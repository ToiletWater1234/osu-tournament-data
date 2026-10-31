@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-dependencies.ps1"
set "setup_result=%errorlevel%"
echo.
if not "%setup_result%"=="0" (
  echo Dependency setup failed. Please read the error above.
) else (
  echo Dependencies are ready. You can now start the application.
)
pause
exit /b %setup_result%
