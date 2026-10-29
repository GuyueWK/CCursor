@echo off
REM install.bat - CCursor portable one-click entry for Windows (double-click me)
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
