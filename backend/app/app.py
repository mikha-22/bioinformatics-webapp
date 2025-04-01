# backend/app/app.py
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
# NOTE: Jinja2Templates initialization is moved to core.templating

# Import config and routers
# Import config first to ensure paths and settings are loaded early
from .core import config
# Import the routers defined in the routers sub-package
from .routers import pages, data, jobs

# --- Basic Logging Setup ---
# Configure logging level, format, and date format.
# Consider moving to a more sophisticated logging setup (e.g., file-based) for production.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(process)d - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)
logger.info("--- Initializing Bioinformatics Webapp ---")

# --- FastAPI App Initialization ---
# Define metadata for OpenAPI documentation tags to organize endpoints
tags_metadata = [
    {"name": "HTML Pages", "description": "Routes serving the web interface pages."},
    {"name": "Data Access", "description": "API endpoints for retrieving file/result lists."},
    {"name": "Jobs Management", "description": "API endpoints for staging, starting, monitoring, and managing pipeline jobs."},
    {"name": "Health Check", "description": "Basic application health status."},
]

# Create the FastAPI application instance
app = FastAPI(
    title="Bioinformatics Webapp",
    description="Web application for staging, running, and managing bioinformatics pipelines using FastAPI and RQ.",
    version="0.2.0", # Example version number
    openapi_tags=tags_metadata # Assign the tags metadata
)

# --- Jinja2 Templates (Initialization moved to core/templating.py) ---
# The 'templates' object is now initialized in core.templating and imported by routers.pages

# --- Static Files Mounting ---
# Serve static files (CSS, JS, images) from the frontend/static directory
try:
    app.mount(
        "/frontend/static", # The URL path prefix
        StaticFiles(directory=str(config.STATIC_DIR)), # The local directory to serve
        name="frontend_static" # A name for reverse URL lookups (optional but good practice)
    )
    logger.info(f"Mounted static directory: '{config.STATIC_DIR}' at URL path '/frontend/static'")
except RuntimeError as e:
    # Log specific error if mounting fails (e.g., directory doesn't exist)
    logger.error(f"Error mounting static directory '{config.STATIC_DIR}': {e}. Ensure the directory exists.")
    # Depending on severity, you might want to raise the error or allow the app to continue.
except Exception as e:
     # Catch any other unexpected errors during static file mounting
     logger.exception(f"Unexpected error mounting static files from {config.STATIC_DIR}", exc_info=True)
     raise RuntimeError("Failed to mount static files.") from e

# --- CORS Configuration ---
# Configure Cross-Origin Resource Sharing (CORS) middleware.
# Be more restrictive with 'allow_origins' in production environments.
allowed_origins = ["*"] # Allows all origins - suitable for development, restrict in production

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
app.include_router(pages.router)
app.include_router(data.router)
app.include_router(jobs.router)
logger.info("Included API routers: pages, data, jobs.")

# --- Optional: Root endpoint for health check ---
# Provides a simple endpoint to verify the application is running.
@app.get("/health", tags=["Health Check"], summary="Basic Health Check")
async def health_check():
    """Returns a simple 'ok' status for health checks."""
    # Future enhancement: Check connections to Redis, database, etc. here.
    return {"status": "ok", "message": "Application is running"}

logger.info("--- Bioinformatics Webapp Initialization Complete. Ready to serve requests. ---")

# Note: Running the app (e.g., using uvicorn) is handled by the main.py
# script in the project root directory, which imports 'app' from this file.
