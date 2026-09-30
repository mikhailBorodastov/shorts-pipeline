"""Claude Studio: вход. Без аргументов — локальный скрипт приложения (страница на http://localhost:8790/), с аргументами — CLI.

    python studio.py [--open] | port | channels | use ID | list | show ID | new … | scene … | lib …   (подробно — ideas_server.py, ideas_api.cli)
"""
import os, runpy, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ideas_server.py"), run_name="__main__")
