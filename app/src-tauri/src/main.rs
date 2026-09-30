// Claude Studio — окно приложения (S2).
// Ищет папку `_studio` вверх от exe, поднимает локальный скрипт `server/studio.py`
// (если он ещё не запущен для этой рабочей папки), ждёт ответа на /api/version
// и открывает http://localhost:<порт>/ в окне WebView2 (тот же движок, что Edge).
// Закрыли окно — останавливаем скрипт, если его запускали мы.
// Ссылки на чужие сайты открываются в обычном браузере, локальные (клип, стенд,
// страница ролика «отдельным окном») — ещё одним окном приложения.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const PORT0: u16 = 8790;

/// Скрипт приложения, если его подняли мы (иначе None — чужой не трогаем).
struct Server(Mutex<Option<Child>>);

fn studio_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("STUDIO_DIR") {
        return Some(PathBuf::from(d));
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|a| a.join("server").join("studio.py").is_file())
        .map(Path::to_path_buf)
}

/// Отвечает ли на этом порту Claude Studio той же рабочей папки (как probe() в ideas_server.py).
fn probe(port: u16, data: &str) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    if s
        .write_all(b"GET /api/version HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let Some(body) = text.split("\r\n\r\n").nth(1) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("data").and_then(|d| d.as_str()).map(str::to_lowercase))
        .map_or(false, |d| d == data)
}

fn running_port(data: &str) -> Option<u16> {
    (PORT0..PORT0 + 10).find(|&p| probe(p, data))
}

fn is_local(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "tauri.localhost"))
        || url.scheme() == "tauri"
}

fn open_in_browser(url: &Url) {
    let mut c = Command::new("rundll32");
    c.args(["url.dll,FileProtocolHandler", url.as_str()]);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let _ = c.spawn();
}

static WINDOWS: AtomicUsize = AtomicUsize::new(0);

/// Окно приложения: общие правила ссылок, заголовок — из страницы.
fn app_window(app: &AppHandle, label: &str, url: WebviewUrl) -> tauri::Result<WebviewWindow> {
    let h = app.clone();
    WebviewWindowBuilder::new(app, label, url)
        .title("Claude Studio")
        .inner_size(1500.0, 950.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(|url| {
            if is_local(url) || url.scheme() == "about" || url.scheme() == "data" || url.scheme() == "blob" {
                true
            } else {
                open_in_browser(url);
                false
            }
        })
        .on_new_window(move |url, _features| {
            if is_local(&url) {
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || {
                    let n = WINDOWS.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app_window(&h2, &format!("w{n}"), WebviewUrl::External(url));
                });
            } else {
                open_in_browser(&url);
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(|w, title| {
            let t = title.trim();
            let _ = w.set_title(if t.is_empty() { "Claude Studio" } else { t });
        })
        .build()
}

fn show(w: &WebviewWindow, js_fn: &str, text: &str) {
    let arg = serde_json::to_string(text).unwrap_or_default();
    let _ = w.eval(format!("{js_fn}({arg})"));
}

fn log_tail(log: &Path) -> String {
    let s = std::fs::read(log).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let lines: Vec<&str> = s.lines().collect();
    lines[lines.len().saturating_sub(40)..].join("\n")
}

/// Фон: найти или поднять скрипт приложения и перевести окно на него.
fn start(app: AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let Some(dir) = studio_dir() else {
        show(&w, "showError", "Не нашёл папку _studio (рядом с программой нет server/studio.py).\nПоложи программу внутрь _studio или задай STUDIO_DIR.");
        return;
    };
    let root = dir.parent().unwrap_or(&dir).to_path_buf();
    let state = std::env::var("IDEAS_DIR").map(PathBuf::from).unwrap_or_else(|_| root.join(".studio"));
    let data = state.to_string_lossy().to_lowercase();

    let port = match running_port(&data) {
        Some(p) => p,
        None => {
            let _ = std::fs::create_dir_all(&state);
            let log = state.join("app.log");
            let out = std::fs::File::create(&log);
            let mut spawned = None;
            for py in ["python", "py"] {
                let mut c = Command::new(py);
                c.arg("studio.py")
                    .current_dir(dir.join("server"))
                    .env("PYTHONIOENCODING", "utf-8")
                    .env("PYTHONUNBUFFERED", "1")
                    .stdin(Stdio::null());
                if let Ok(f) = &out {
                    if let (Ok(a), Ok(b)) = (f.try_clone(), f.try_clone()) {
                        c.stdout(a).stderr(b);
                    }
                }
                #[cfg(windows)]
                c.creation_flags(CREATE_NO_WINDOW);
                if let Ok(child) = c.spawn() {
                    spawned = Some(child);
                    break;
                }
            }
            let Some(child) = spawned else {
                show(&w, "showError", "Не удалось запустить Python (ни python, ни py не нашлись).");
                return;
            };
            *app.state::<Server>().0.lock().unwrap() = Some(child);
            let t0 = Instant::now();
            loop {
                if let Some(p) = running_port(&data) {
                    break p;
                }
                let exited = app
                    .state::<Server>()
                    .0
                    .lock()
                    .unwrap()
                    .as_mut()
                    .map_or(true, |c| matches!(c.try_wait(), Ok(Some(_))));
                if exited || t0.elapsed() > Duration::from_secs(45) {
                    show(&w, "showError", &log_tail(&log));
                    return;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    };
    if let Ok(url) = Url::parse(&format!("http://localhost:{port}/")) {
        let _ = w.navigate(url);
    }
}

fn stop_server(app: &AppHandle) {
    if let Some(mut c) = app.state::<Server>().0.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            let w = app_window(app.handle(), "main", WebviewUrl::App("index.html".into()))?;
            let _ = w.maximize();
            let h = app.handle().clone();
            std::thread::spawn(move || start(h));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Claude Studio: окно не создалось")
        .run(|app, e| {
            if let RunEvent::Exit = e {
                stop_server(app);
            }
        });
}
