# backend/app/app.py
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Import config first
from .core import config
# Import routers
from .routers import data, jobs, profiles, websockets # <<< ADD websockets router import

# --- Basic Logging Setup ---
logging.basicConfig(
    level=logging.INFO, # Consider logging.DEBUG for development
    format='%(asctime)s - %(process)d - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)
logger.info("--- Initializing Bioinformatics Webapp Backend API ---")

# --- FastAPI App Initialization ---
tags_metadata = [
    {"name": "Data Access", "description": "API endpoints for retrieving file/result lists."},
    {"name": "Jobs Management", "description": "API endpoints for staging, starting, monitoring, and managing pipeline jobs."},
    {"name": "Profiles Management", "description": "API endpoints for saving and loading pipeline configuration profiles."},
    {"name": "WebSocket", "description": "Endpoints for real-time communication (e.g., logs)."}, # <<< ADDED
    {"name": "Health Check", "description": "Basic application health status."},
]

app = FastAPI(
    title="Bioinformatics Webapp API",
    description="Backend API for staging, running, and managing Sarek bioinformatics pipelines using FastAPI and RQ.",
    version="0.5.0", # <<< Version Bump
    openapi_tags=tags_metadata
)

# --- CORS Configuration ---
allowed_origins = ["*"] # TODO: Restrict in production for security
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "PUT", "OPTIONS"], # Added PUT
    allow_headers=["*"],
)
logger.info(f"CORS middleware configured. Allowed origins: {allowed_origins}")

# --- Include Routers ---
app.include_router(data.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(profiles.router) # Already has /api/profiles prefix
# Include the WebSocket router - the prefix is defined *within* websockets.py
app.include_router(websockets.router)
logger.info("Included API routers: data, jobs, profiles, websockets.") # <<< Updated log message

# --- Root endpoint for health check ---
@app.get("/health", tags=["Health Check"], summary="Basic Health Check")
async def health_check():
    """Returns a simple 'ok' status for health checks."""
    return {"status": "ok", "message": "Backend API is running"}

logger.info("--- Bioinformatics Webapp Backend API Initialization Complete. Ready to serve requests. ---")
