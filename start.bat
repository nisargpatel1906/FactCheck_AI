@echo off
echo ===================================================
echo            FactCheck AI Backend Server
echo ===================================================

cd /d "%~dp0backend"

:: Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

:: Check if virtual environment exists
if not exist ".venv\Scripts\activate.bat" (
    echo.
    echo [ERROR] Virtual environment not found in backend\.venv
    echo Run these commands to set it up:
    echo   python -m venv .venv
    echo   .venv\Scripts\activate
    echo   pip install -r requirements.txt
    pause
    exit /b 1
)

:: Auto-create .env from .env.example if it doesn't exist yet
if not exist ".env" (
    if exist ".env.example" (
        echo [SETUP] .env not found. Copying from .env.example...
        copy ".env.example" ".env" >nul
        echo [SETUP] .env created. Open backend\.env and fill in your API keys, then re-run this script.
        pause
        exit /b 0
    ) else (
        echo [ERROR] Neither .env nor .env.example found in backend\.
        pause
        exit /b 1
    )
)

:: Validate that the critical NVIDIA_API_KEY is set
for /f "tokens=1,2 delims==" %%a in (.env) do (
    if "%%a"=="NVIDIA_API_KEY" (
        if "%%b"=="" (
            echo.
            echo [ERROR] NVIDIA_API_KEY is empty in backend\.env
            echo Get your free key at https://build.nvidia.com and paste it in backend\.env
            pause
            exit /b 1
        )
    )
)

echo Activating virtual environment...
call .venv\Scripts\activate.bat

echo Starting Uvicorn server...
uvicorn main:app --host 127.0.0.1 --port 8000 --reload

echo.
echo Server has stopped.
pause
