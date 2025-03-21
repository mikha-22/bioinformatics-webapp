import uvicorn
from backend.app.app import app  # Import FastAPI app from backend/app/app.py

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
