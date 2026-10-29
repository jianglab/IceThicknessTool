@echo off
rem =====================================================================
rem  Build IceThickness.exe  (single-file Windows launcher)
rem
rem  Requires Python 3 (any recent version) on this machine. Everything
rem  else is installed automatically into a local folder.
rem
rem  Double-click this file, or run it from a command prompt.
rem  Result: dist\IceThickness.exe
rem =====================================================================
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo Python 3 was not found on PATH.
  echo Install it from https://www.python.org/downloads/ and tick
  echo "Add python.exe to PATH", then run this script again.
  echo.
  pause
  exit /b 1
)

echo Installing PyInstaller (first run only)...
python -m pip install --upgrade pyinstaller
if errorlevel 1 (
  echo Could not install PyInstaller. Check your internet connection.
  pause
  exit /b 1
)

echo.
echo Building the executable...
python -m PyInstaller --onefile --console --name IceThickness ^
  --add-data "%CD%\webapp;webapp" ^
  --distpath "%CD%\dist" --workpath "%CD%\build" --specpath "%CD%\build" ^
  --noconfirm "%CD%\launcher.py"
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Done:  dist\IceThickness.exe
echo.
echo  Copy that single file anywhere and double-click it. It opens
echo  the tool in your default browser; close the small console
echo  window to stop it. No Python needed on the target machine.
echo ============================================================
pause
