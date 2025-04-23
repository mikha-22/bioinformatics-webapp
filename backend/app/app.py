# backend/app/app.py
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
# REMOVED: from fastapi.staticfiles import StaticFiles
# REMOVED: Jinja2Templates initialization was in core.templating

# Import config and routers
# Import config first to ensure paths and settings are loaded early
from .core import config
# Import the routers defined in the routers sub-package
# REMOVED: from .routers import pages
from .routers import data, jobs, profiles # <<< ADD profiles router import

# --- Basic Logging Setup ---
# Configure logging level, format, and date format.
# Consider moving to a more sophisticated logging setup (e.g., file-based) for production.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(process)d - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)
logger.info("--- Initializing Bioinformatics Webapp Backend API ---")

# --- FastAPI App Initialization ---
# Define metadata for OpenAPI documentation tags to organize endpoints
tags_metadata = [
    # REMOVED: {"name": "HTML Pages", "description": "Routes serving the web interface pages."},
    {"name": "Data Access", "description": "API endpoints for retrieving file/result lists."},
    {"name": "Jobs Management", "description": "API endpoints for staging, starting, monitoring, and managing pipeline jobs."},
    {"name": "Profiles Management", "description": "API endpoints for saving and loading pipeline configuration profiles."}, # <<< ADDED
    {"name": "Health Check", "description": "Basic application health status."},
]

# Create the FastAPI application instance
app = FastAPI(
    title="Bioinformatics Webapp API", # Updated title
    description="Backend API for staging, running, and managing Sarek bioinformatics pipelines using FastAPI and RQ.", # Updated description
    version="0.4.0", # <<< Version Bump
    openapi_tags=tags_metadata # Assign the tags metadata
)

# --- Jinja2 Templates (REMOVED) ---
# No longer needed as frontend is handled by Next.js

# --- Static Files Mounting (REMOVED) ---
# No longer needed as frontend is handled by Next.js

# --- CORS Configuration ---
# Configure Cross-Origin Resource Sharing (CORS) middleware.
# Be more restrictive with 'allow_origins' in production environments.
# '*' is okay for development when frontend runs on a different port (e.g., 3000)
# and backend on 8000. For production, list the specific frontend origin.
allowed_origins = ["*"] # TODO: Restrict in production

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins, # List of allowed origins
    allow_credentials=True, # Allow cookies to be included in cross-origin requests
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"], # Allow specific HTTP methods
    allow_headers=["*"], # Allow all headers
)
logger.info(f"CORS middleware configured. Allowed origins: {allowed_origins}")

# --- Include Routers ---
# Add the routers from the sub-package to the main application.
# These routers contain the actual endpoints for different functionalities.
# REMOVED: app.include_router(pages.router)
app.include_router(data.router, prefix="/api") # Add prefix for data endpoints
app.include_router(jobs.router, prefix="/api") # Add prefix for jobs endpoints
app.include_router(profiles.router) # <<< ADD profiles router (already has /api/profiles prefix)
logger.info("Included API routers: data, jobs, profiles (prefixed with /api).") # <<< Updated log message

# --- Optional: Root endpoint for health check ---
# Provides a simple endpoint to verify the application is running.
@app.get("/health", tags=["Health Check"], summary="Basic Health Check")
async def health_check():
    """Returns a simple 'ok' status for health checks."""
    # Future enhancement: Check connections to Redis etc. here.
    return {"status": "ok", "message": "Backend API is running"}

logger.info("--- Bioinformatics Webapp Backend API Initialization Complete. Ready to serve requests. ---")

# Note: Running the app (e.g., using uvicorn) is handled by the main.py
# script in the project root directory, which imports 'app' from this file.
