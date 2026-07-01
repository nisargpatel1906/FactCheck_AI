#!/bin/bash
echo "==================================================="
echo "           FactCheck AI Backend Server"
echo "==================================================="

# Navigate to the backend directory relative to this script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR/backend"

# Create logs directory if it doesn't exist
mkdir -p logs

# Check if virtual environment exists
if [ ! -f ".venv/bin/activate" ]; then
    echo ""
    echo "[ERROR] Virtual environment not found in backend/.venv"
    echo "Run these commands to set it up:"
    echo "  python3 -m venv .venv"
    echo "  source .venv/bin/activate"
    echo "  pip install -r requirements.txt"
    read -p "Press enter to exit..."
    exit 1
fi

# Auto-create .env from .env.example if it doesn't exist yet
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "[SETUP] .env not found. Copying from .env.example..."
        cp .env.example .env
        echo "[SETUP] .env created. Open backend/.env and fill in your API keys, then re-run this script."
        read -p "Press enter to exit..."
        exit 0
    else
        echo "[ERROR] Neither .env nor .env.example found in backend/."
        read -p "Press enter to exit..."
        exit 1
    fi
fi

# Validate that NVIDIA_API_KEY is set
NVIDIA_KEY=$(grep "^NVIDIA_API_KEY=" .env | cut -d'=' -f2 | tr -d '[:space:]')
if [ -z "$NVIDIA_KEY" ]; then
    echo ""
    echo "[ERROR] NVIDIA_API_KEY is empty in backend/.env"
    echo "Get your free key at https://build.nvidia.com and paste it in backend/.env"
    read -p "Press enter to exit..."
    exit 1
fi

echo "Activating virtual environment..."
source .venv/bin/activate

echo "Starting Uvicorn server..."
uvicorn main:app --host 127.0.0.1 --port 8000 --reload

echo ""
echo "Server has stopped."
read -p "Press enter to exit..."

