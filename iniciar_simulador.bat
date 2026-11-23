@echo off
REM Abre el simulador de escenarios en el navegador con un servidor local (requiere Python).
cd /d "%~dp0docs"
start "" http://localhost:8767/?ciudad=piura
python -m http.server 8767
