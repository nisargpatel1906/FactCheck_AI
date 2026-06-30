@echo off
echo ===================================================
echo            FactCheck AI Backend Server
echo ===================================================

cd /d "%~dp0backend"

:: Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

:: Check if virtual environment exists
if not exist ".venv\Scripts\activate.bat" (
    echo Error: Virtual environment not found in backend\.venv
    echo Please run the setup process first.
    pause
    exit /b 1
)

echo Activating virtual environment...
call .venv\Scripts\activate.bat

echo Starting Uvicorn server...
:: Logs are handled internally by Python's logging module
uvicorn main:app --host 127.0.0.1 --port 8000 --reload

echo.
echo Server has stopped.
pause
