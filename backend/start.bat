@echo off
echo Starting FactCheck AI Backend...
cd %~dp0
if not exist logs mkdir logs
echo Writing logs to logs\backend.log
.venv\Scripts\uvicorn main:app --host 127.0.0.1 --port 8000 > logs\backend.log 2>&1
