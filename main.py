import uvicorn
from backend.app.app import app  # Import FastAPI app from backend/app/app.py

if __name__ == "__main__":

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        ssl_keyfile="./tls/server.key",  # Path to the key file
        ssl_certfile="./tls/server.crt", # Path to the cert file
    )
