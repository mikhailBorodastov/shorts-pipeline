@echo off
rem Claude Studio: локальный скрипт приложения + страница (http://localhost:8790/)
cd /d "%~dp0server"
python studio.py --open
pause
