@echo off
chcp 65001 >nul
rem Пересобрать окно Claude Studio (нужны Rust и VS Build Tools с C++, см. docs/studio/stage2-studio.md §5)
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
call npm install || goto :err
call npx tauri build || goto :err
copy /y "src-tauri\target\release\claude-studio.exe" "Claude Studio.exe" >nul || goto :err
echo Готово: %~dp0Claude Studio.exe
pause
exit /b 0
:err
echo Сборка не удалась
pause
exit /b 1
