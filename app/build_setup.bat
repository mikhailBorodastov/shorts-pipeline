@echo off
chcp 65001 >nul
rem Установщик Claude Studio для друзей: setup.exe (NSIS, ставится «для пользователя», без прав администратора).
rem Внутри — окно приложения + код _studio (только файлы из git) + демо-канал. Первая сборка Tauri сама скачает NSIS.
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
python stage_bundle.py || goto :err
call npm install || goto :err
call npx tauri build || goto :err
for %%f in ("src-tauri\target\release\bundle\nsis\*-setup.exe") do copy /y "%%f" "Claude Studio Setup.exe" >nul
echo Готово: %~dp0Claude Studio Setup.exe
pause
exit /b 0
:err
echo Сборка не удалась
pause
exit /b 1
