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
    echo "Error: Virtual environment not found in backend/.venv"
    echo "Please run the setup process first: create a python virtual environment in backend/.venv"
    echo "Example: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
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
