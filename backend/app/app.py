# File: backend/app/app.py
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Import config first
from .core import config
# Import routers
from .routers import data, jobs, profiles, websockets
from .routers import notifications_ws # <<< --- ADDED: Import new notifications WebSocket router ---

# --- Basic Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
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
    {"name": "WebSocket Logs", "description": "Endpoints for real-time job log streaming."}, # Renamed for clarity
    {"name": "WebSocket Notifications", "description": "Endpoints for real-time application notifications."}, # <<< --- ADDED: New Tag ---
    {"name": "Health Check", "description": "Basic application health status."},
]

app = FastAPI(
    title="Bioinformatics Webapp API",
    description="Backend API for staging, running, and managing Sarek bioinformatics pipelines using FastAPI and RQ. Includes WebSockets for live logs and notifications.", # Updated description
    version="0.7.0", # <<< --- Version Bump for Notifications feature ---
    openapi_tags=tags_metadata
)

# --- CORS Configuration ---
allowed_origins = ["*"] # TODO: Restrict in production for security
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "PUT", "OPTIONS"],
    allow_headers=["*"],
)
logger.info(f"CORS middleware configured. Allowed origins: {allowed_origins}")

# --- Include Routers ---
app.include_router(data.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(profiles.router, prefix="/api")
app.include_router(websockets.router) # For job-specific logs
app.include_router(notifications_ws.router) # <<< --- ADDED: Include notifications WebSocket router ---
logger.info("Included API routers: data, jobs, profiles, websockets (logs), notifications_ws.")

# --- Root endpoint for health check ---
@app.get("/health", tags=["Health Check"], summary="Basic Health Check")
async def health_check():
    """Returns a simple 'ok' status for health checks."""
    return {"status": "ok", "message": "Backend API is running"}

# --- Add startup/shutdown events for the notification manager ---
@app.on_event("startup")
async def on_app_startup():
    logger.info("Application startup: Initializing notification manager components if any.")
    # If manager.startup_event needs to be called explicitly (depends on its design)
    # await notifications_ws.manager.startup_event() # Or however you trigger its setup

@app.on_event("shutdown")
async def on_app_shutdown():
    logger.info("Application shutdown: Cleaning up notification manager components.")
    await notifications_ws.manager.shutdown_event() # Ensure graceful shutdown of the notification manager

logger.info("--- Bioinformatics Webapp Backend API Initialization Complete. Ready to serve requests. ---")
