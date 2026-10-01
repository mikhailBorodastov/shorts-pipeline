// Claude Studio — окно приложения (S2).
// Ищет папку `_studio` вверх от exe, поднимает локальный скрипт `server/studio.py`
// (если он ещё не запущен для этой рабочей папки), ждёт ответа на /api/version
// и открывает http://localhost:<порт>/ в окне WebView2 (тот же движок, что Edge).
// Закрыли окно — останавливаем скрипт, если его запускали мы.
// Ссылки на чужие сайты открываются в обычном браузере, локальные (клип, стенд,
// страница ролика «отдельным окном») — ещё одним окном приложения.
// Установленная программа (setup.exe): код — в <папка программы>/_studio, рабочая папка — Документы\Claude Studio
// (первый запуск кладёт туда демо-канал); не хватает Python / Node / ffmpeg / Git / Claude Code — мастер на стартовой
// странице ставит их (tools/setup_deps.ps1, winget + pip + npm). Кнопки мастера — ссылки studio://…, их ловит on_navigation.
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
    for a in exe.ancestors() {
        if a.join("server").join("studio.py").is_file() {
            return Some(a.to_path_buf());
        }
        if a.join("_studio").join("server").join("studio.py").is_file() {      // установленная программа: <папка программы>/_studio
            return Some(a.join("_studio"));
        }
    }
    None
}

/// Рабочая папка (каналы, видео, .studio). Разработка — родитель _studio (там уже есть .studio или каналы);
/// установленная программа — STUDIO_ROOT, workspace.txt рядом с программой или Документы\Claude Studio.
fn workspace(dir: &Path) -> (PathBuf, bool) {
    if let Ok(r) = std::env::var("STUDIO_ROOT") {
        return (PathBuf::from(r), false);
    }
    let parent = dir.parent().unwrap_or(dir).to_path_buf();
    let dev = parent.join(".studio").is_dir()
        || std::fs::read_dir(&parent).map_or(false, |it| it.flatten().any(|e| e.path().join("channel.json").is_file()));
    if dev {
        return (parent, false);
    }
    if let Ok(t) = std::fs::read_to_string(parent.join("workspace.txt")) {
        let t = t.trim();
        if !t.is_empty() {
            return (PathBuf::from(t), true);
        }
    }
    let docs = std::env::var("USERPROFILE").map(|h| PathBuf::from(h).join("Documents")).unwrap_or_else(|_| parent.clone());
    (docs.join("Claude Studio"), true)
}

/// Первый запуск установленной программы: рабочая папка + демо-канал (_studio/demo/*) + CLAUDE.md со ссылкой на инструкцию.
fn first_run(dir: &Path, root: &Path) {
    let _ = std::fs::create_dir_all(root);
    let has_channel = std::fs::read_dir(root).map_or(false, |it| it.flatten().any(|e| e.path().join("channel.json").is_file()));
    if !has_channel {
        if let Ok(it) = std::fs::read_dir(dir.join("demo")) {
            for e in it.flatten() {
                if e.path().join("channel.json").is_file() {
                    copy_dir(&e.path(), &root.join(e.file_name()));
                }
            }
        }
    }
    let md = root.join("CLAUDE.md");
    if !md.is_file() {
        let d = dir.to_string_lossy().replace('\\', "/");     // своя короткая инструкция: _studio/CLAUDE.md — про каналы автора программы
        let _ = std::fs::write(&md, format!("# Рабочая папка Claude Studio\n\nКаналы — папки с channel.json (видео в videos/, стиль канала — style/, библиотека — library/).\n\
Код программы — {d}: устройство — {d}/README.md и {d}/docs/studio/, CLI — python {d}/server/studio.py.\n\
Стиль, герой и правила берутся из канала (channel.json и style/), а не из примеров в документации.\n"));
    }
}

fn copy_dir(src: &Path, dst: &Path) {
    let _ = std::fs::create_dir_all(dst);
    if let Ok(it) = std::fs::read_dir(src) {
        for e in it.flatten() {
            let p = e.path();
            let to = dst.join(e.file_name());
            if p.is_dir() {
                copy_dir(&p, &to);
            } else {
                let _ = std::fs::copy(&p, &to);
            }
        }
    }
}

/// PATH из реестра (после установки через winget у этого процесса старый PATH).
fn fresh_path() -> String {
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

fn has(cmd: &str, args: &[&str], path: &str) -> bool {
    let mut c = Command::new(cmd);
    c.args(args).env("PATH", path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.status().map_or(false, |s| s.success())
}

/// Что есть на компьютере: [(id, название, есть)].
fn check_deps() -> Vec<(&'static str, &'static str, bool)> {
    let path = fresh_path();
    let stands = studio_dir().map_or(true, |d| d.join("stands").join("node_modules").join("puppeteer-core").is_dir());
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let claude = has("claude", &["--version"], &path) || Path::new(&home).join(".local").join("bin").join("claude.exe").is_file();
    vec![
        ("python", "Python 3", has("python", &["--version"], &path) || has("py", &["-3", "--version"], &path)),
        ("pip", "Python-пакеты (edge-tts, numpy, pillow, yt-dlp)", has("python", &["-c", "import edge_tts, numpy, PIL"], &path)),
        ("node", "Node.js", has("node", &["--version"], &path)),
        ("npm", "Модули рендера кадров (puppeteer-core)", stands),
        ("ffmpeg", "ffmpeg", has("ffmpeg", &["-version"], &path)),
        ("git", "Git", has("git", &["--version"], &path)),
        ("claude", "Claude Code (кнопки ✨ и агент)", claude),
    ]
}

static SETUP_BUSY: AtomicUsize = AtomicUsize::new(0);

fn setup_page(w: &WebviewWindow) -> bool {
    let deps = check_deps();
    let missing: Vec<_> = deps.iter().filter(|d| !d.2).collect();
    if missing.is_empty() {
        return false;
    }
    let list: Vec<serde_json::Value> = deps.iter().map(|d| serde_json::json!({"id": d.0, "name": d.1, "ok": d.2})).collect();
    let _ = w.eval(format!("showSetup({})", serde_json::Value::Array(list)));
    true
}

fn run_setup(app: AppHandle) {
    if SETUP_BUSY.swap(1, Ordering::SeqCst) == 1 {
        return;
    }
    let Some(w) = app.get_webview_window("main") else { return };
    let Some(dir) = studio_dir() else { return };
    let missing: Vec<&str> = check_deps().iter().filter(|d| !d.2).map(|d| d.0).collect();
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(dir.join("tools").join("setup_deps.ps1"))
        .arg("-Missing")
        .arg(missing.join(","))
        .arg("-Studio")
        .arg(&dir)
        .env("PATH", fresh_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    match c.spawn() {
        Ok(mut child) => {
            if let Some(out) = child.stdout.take() {
                use std::io::BufRead;
                for line in std::io::BufReader::new(out).lines().flatten() {
                    show(&w, "setupLog", &line);
                }
            }
            let _ = child.wait();
        }
        Err(e) => show(&w, "setupLog", &format!("не запустился PowerShell: {e}")),
    }
    SETUP_BUSY.store(0, Ordering::SeqCst);
    if !setup_page(&w) {
        show(&w, "setupLog", "Всё на месте — запускаю Claude Studio…");
        std::thread::spawn(move || start(app, true));
    } else {
        show(&w, "setupLog", "Что-то не поставилось — см. выше. Можно «Пропустить» и поставить вручную.");
    }
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

/// Поиск картинок (Google / Яндекс Картинки): открывается окном «🔎 Картинки» внутри приложения, а не во внешнем браузере —
/// картинку оттуда перетаскивают в слот референса (или «Копировать картинку» → Ctrl+V).
fn is_img_search(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("");
    let q = url.query().unwrap_or("");
    (host.contains("google.") && (q.contains("udm=2") || q.contains("tbm=isch")))
        || (host.contains("yandex.") && url.path().starts_with("/images"))
}

fn search_window(app: &AppHandle, url: Url) {
    if let Some(w) = app.get_webview_window("imgsearch") {
        let _ = w.navigate(url);
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let (mut x, mut y) = (60.0, 40.0);
    if let Some(m) = app.get_webview_window("main") {                // справа от главного окна, чтобы перетаскивать
        if let (Ok(p), Ok(s), Ok(f)) = (m.outer_position(), m.outer_size(), m.scale_factor()) {
            x = (p.x as f64 + s.width as f64) / f - 520.0;
            y = p.y as f64 / f + 30.0;
        }
    }
    let h = app.clone();
    let _ = WebviewWindowBuilder::new(app, "imgsearch", WebviewUrl::External(url))
        .title("🔎 Картинки — перетащи картинку в референс")
        .inner_size(760.0, 900.0)
        .position(x.max(0.0), y.max(0.0))
        .on_new_window(move |url, _features| {                       // ссылки «в новой вкладке» — в этом же окне
            if let Some(w) = h.get_webview_window("imgsearch") { let _ = w.navigate(url); }
            NewWindowResponse::Deny
        })
        .build();
}

/// Окно приложения: общие правила ссылок, заголовок — из страницы.
fn app_window(app: &AppHandle, label: &str, url: WebviewUrl) -> tauri::Result<WebviewWindow> {
    let h = app.clone();
    WebviewWindowBuilder::new(app, label, url)
        .title("Claude Studio")
        .inner_size(1500.0, 950.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation({
            let h3 = app.clone();
            move |url| {
            if url.scheme() == "studio" {                                   // кнопки мастера первого запуска
                let h4 = h3.clone();
                match url.host_str().unwrap_or("") {
                    "setup" => { std::thread::spawn(move || run_setup(h4)); }
                    "skip" => { std::thread::spawn(move || start(h4, true)); }
                    "claude-login" => {
                        let mut c = Command::new("cmd");
                        c.args(["/c", "start", "Claude Code — вход", "cmd", "/k", "claude"]).env("PATH", fresh_path());
                        let _ = c.spawn();
                    }
                    _ => {}
                }
                return false;
            }
            if is_local(url) || url.scheme() == "about" || url.scheme() == "data" || url.scheme() == "blob" {
                true
            } else {
                open_in_browser(url);
                false
            }
        }})
        .on_new_window(move |url, _features| {
            if is_img_search(&url) {
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || search_window(&h2, url));
                return NewWindowResponse::Deny;
            }
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
fn start(app: AppHandle, skip_check: bool) {
    let Some(w) = app.get_webview_window("main") else { return };
    let Some(dir) = studio_dir() else {
        show(&w, "showError", "Не нашёл папку _studio (рядом с программой нет server/studio.py).\nПоложи программу внутрь _studio или задай STUDIO_DIR.");
        return;
    };
    let (root, installed) = workspace(&dir);
    if installed {
        first_run(&dir, &root);
        if !skip_check && setup_page(&w) {
            return;                                                     // мастер: «Установить недостающее» / «Пропустить»
        }
    }
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
                    .env("STUDIO_ROOT", &root)
                    .env("PATH", fresh_path())
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
            std::thread::spawn(move || start(h, false));
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
