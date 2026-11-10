@echo off
title Cayin RU3 Studio Deck
cd /d "%~dp0"
echo ========================================================
echo   CAYIN RU3 STUDIO 10-BAND PARAMETRIC EQ & DAC CONTROLLER
echo ========================================================
echo.
echo Launching Native Desktop App with direct Hardware Driver Bridge...
python app.py
if errorlevel 1 (
    echo.
    echo Application exited with error. Press any key to close...
    pause >nul
)
