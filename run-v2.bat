@echo off
setlocal
title Cayin RU3 v2

cd /d "%~dp0"
set "PYTHON=%~dp0.venv\Scripts\python.exe"
set "SERVER=%~dp0v2\server.py"
set "URL=http://127.0.0.1:8765"

if not exist "%PYTHON%" (
    echo [ERROR] Python virtual environment tidak ditemukan.
    echo Expected: %PYTHON%
    echo.
    pause
    exit /b 1
)

if not exist "%SERVER%" (
    echo [ERROR] Server v2 tidak ditemukan.
    echo Expected: %SERVER%
    echo.
    pause
    exit /b 1
)

echo ========================================================
echo   CAYIN RU3 v2 - WEB UI
echo ========================================================
echo.
echo Server : %URL%
echo Stop   : tekan Ctrl+C di jendela ini
echo.

if /I not "%RU3_NO_BROWSER%"=="1" (
    start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"
)

"%PYTHON%" "%SERVER%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo Server berhenti dengan kode %EXIT_CODE%.
    pause
)

endlocal & exit /b %EXIT_CODE%
