#!/bin/bash
echo "Starting FactCheck AI Backend..."

# Navigate to the backend directory relative to this script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

mkdir -p logs
echo "Writing logs to logs/backend.log"

if [ ! -f ".venv/bin/uvicorn" ]; then
    echo "Error: .venv/bin/uvicorn not found. Please set up the virtual environment in backend/.venv"
    exit 1
fi

.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 > logs/backend.log 2>&1
