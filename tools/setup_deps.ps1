# Мастер первого запуска Claude Studio: ставит то, чего не хватает на компьютере.
# Вызывает окно приложения (app/src-tauri/src/main.rs → run_setup) кнопкой «Установить недостающее»:
#   powershell -File setup_deps.ps1 -Missing python,pip,node,ffmpeg,git,claude
# Программы — через winget (есть в Windows 10/11), Python-пакеты — pip, Claude Code — официальный установщик claude.ai.
# Каждая строка вывода показывается в окне мастера.
param([string]$Missing = "python,pip,node,npm,ffmpeg,git,claude", [string]$Studio = (Split-Path $PSScriptRoot -Parent))

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
$want = $Missing.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Winget-Install($id, $title) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Output "✗ $title — нет winget (Установщик приложений из Microsoft Store). Поставь $title вручную."
    return
  }
  Write-Output "… $title ($id) — ставлю через winget"
  $args = @("install", "--id", $id, "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity")
  & winget @args "--scope" "user" | Out-Null
  if ($LASTEXITCODE -ne 0) { & winget @args | Out-Null }       # не у всех пакетов есть установка «для пользователя»
  if ($LASTEXITCODE -eq 0) { Write-Output "✓ $title" } else { Write-Output "✗ $title — winget вернул $LASTEXITCODE" }
  Refresh-Path
}

if ($want -contains "python") { Winget-Install "Python.Python.3.12" "Python 3.12" }
if ($want -contains "node")   { Winget-Install "OpenJS.NodeJS.LTS" "Node.js LTS" }
if ($want -contains "ffmpeg") { Winget-Install "Gyan.FFmpeg" "ffmpeg" }
if ($want -contains "git")    { Winget-Install "Git.Git" "Git" }

if ($want -contains "npm" -or $want -contains "node") {
  $stands = Join-Path $Studio "stands"
  if ((Get-Command npm -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $stands "package.json"))) {
    Write-Output "… модули рендера кадров (npm install в stands)"
    Push-Location $stands; & npm install --no-audit --no-fund --loglevel=error 2>&1 | Out-Null; $code = $LASTEXITCODE; Pop-Location
    if ($code -eq 0) { Write-Output "✓ модули рендера" } else { Write-Output "✗ модули рендера — npm вернул $code" }
  } else {
    Write-Output "✗ модули рендера — нет npm (поставь Node.js и перезапусти программу)"
  }
}

if ($want -contains "pip" -or $want -contains "python") {
  $py = (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $py) { $py = (Get-Command py -ErrorAction SilentlyContinue) }
  if ($py) {
    Write-Output "… Python-пакеты: edge-tts, numpy, pillow, yt-dlp"
    & $py.Source -m pip install --user --upgrade --quiet edge-tts numpy pillow yt-dlp 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Output "✓ Python-пакеты" } else { Write-Output "✗ Python-пакеты — pip вернул $LASTEXITCODE" }
  } else {
    Write-Output "✗ Python-пакеты — Python не нашёлся (перезапусти программу после установки Python)"
  }
}

if ($want -contains "claude") {
  Write-Output "… Claude Code — официальный установщик с claude.ai"
  try {
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression | Out-Null
    Refresh-Path
    Write-Output "✓ Claude Code. Войди в свой аккаунт Claude: кнопка «Войти в Claude» ниже (один раз)."
  } catch {
    Write-Output "✗ Claude Code — $($_.Exception.Message)"
  }
}

Write-Output "Готово."
