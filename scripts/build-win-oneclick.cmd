@echo off
setlocal
cd /d "%~dp0.."

where pwsh >nul 2>&1
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-win-oneclick.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-win-oneclick.ps1"
)

if errorlevel 1 (
  echo.
  echo Build failed.
  pause
)

endlocal

