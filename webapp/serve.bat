@echo off
rem Serve the Ice Thickness web tool on your local network.
rem Default port 8000; pass another port as an argument, e.g.  serve.bat 8080
cd /d "%~dp0"
if "%1"=="" (
  python serve.py
) else (
  python serve.py %1
)
pause
