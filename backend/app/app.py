import asyncio
import logging
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import List, Dict
from pydantic import BaseModel

# --- RQ / Redis Imports ---
import redis
from rq import Queue
from rq.job import Job
from rq.exceptions import NoSuchJobError

# --- Import Task Function ---
# Assuming tasks.py is in the same directory (backend/app)
try:
    from .tasks import run_pipeline_task
except ImportError:
    # Fallback for running directly (e.g. python backend/app/app.py), though not recommended for RQ setup
    from tasks import run_pipeline_task


# --- Basic Logging Setup ---
# Consistent format for both app and potential worker imports
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__) # Get logger for this module

# --- FastAPI App Initialization ---
app = FastAPI(title="Bioinformatics Webapp")

# --- Path Definitions ---
# Use resolve() for absolute paths, robust to how the script is run
APP_FILE_PATH = Path(__file__).resolve()
BACKEND_APP_DIR = APP_FILE_PATH.parent
PROJECT_ROOT = BACKEND_APP_DIR.parents[1] # Go up two levels from backend/app

FRONTEND_DIR = PROJECT_ROOT / "frontend"
TEMPLATES_DIR = FRONTEND_DIR / "templates"
STATIC_DIR = FRONTEND_DIR / "static"
BIOINFORMATICS_DIR = PROJECT_ROOT / "bioinformatics"
DATA_DIR = BIOINFORMATICS_DIR / "data"
RESULTS_DIR = BIOINFORMATICS_DIR / "results"

logger.info(f"Project Root resolved to: {PROJECT_ROOT}")
logger.info(f"Static Directory resolved to: {STATIC_DIR}")

# --- Jinja2 Templates ---
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# --- Static Files Mounting ---
# Serve static files (CSS, JS, images) from the frontend/static directory
try:
    app.mount("/frontend/static", StaticFiles(directory=str(STATIC_DIR)), name="frontend_static")
    logger.info(f"Mounted static directory: {STATIC_DIR}")
except RuntimeError as e:
    logger.error(f"Error mounting static directory '{STATIC_DIR}': {e}. Check if directory exists.")
    # Decide if this is fatal or not

# --- CORS Configuration ---
# Allows frontend (potentially on different port during dev) to access API
# In production, restrict origins more tightly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # TODO: Restrict in production, e.g., ["https://yourdomain.com", "http://localhost:8000"]
    allow_credentials=True,
    allow_methods=["GET", "POST"], # Be specific about allowed methods
    allow_headers=["*"], # Or specify like ["Content-Type"]
)

# --- Redis Connection and RQ Queue ---
# TODO: Use environment variables for Redis host/port/db in production
REDIS_HOST = "localhost"
REDIS_PORT = 6379
REDIS_DB = 0
PIPELINE_QUEUE_NAME = "pipeline_tasks" # Name of the queue workers will listen to

redis_conn = None # Initialize to None
pipeline_queue = None # Initialize to None

try:
    # *** IMPORTANT FIX: Removed decode_responses=True ***
    redis_conn = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)
    # ****************************************************
    redis_conn.ping() # Test connection
    logger.info(f"Successfully connected to Redis at {REDIS_HOST}:{REDIS_PORT}")
    # Create the RQ Queue object only if Redis connection is successful
    pipeline_queue = Queue(PIPELINE_QUEUE_NAME, connection=redis_conn)
    logger.info(f"RQ Queue '{PIPELINE_QUEUE_NAME}' initialized.")

except redis.exceptions.ConnectionError as e:
    logger.error(f"FATAL: Could not connect to Redis at {REDIS_HOST}:{REDIS_PORT}. RQ will not work. Error: {e}")
    # The app might still run but job queuing/status will fail.
    # Consider exiting if Redis is essential: import sys; sys.exit(1)
except Exception as e:
    logger.error(f"FATAL: An unexpected error occurred during Redis/RQ initialization: {e}")
    redis_conn = None
    pipeline_queue = None


# --- Pydantic Model for Input Validation ---
class PipelineInput(BaseModel):
    forward_reads_file: str
    reverse_reads_file: str
    reference_genome_file: str
    target_regions_file: str
    known_variants_file: str | None = None # Optional, accept None

# --- Helper Function ---
def get_directory_contents(directory: Path) -> List[Dict[str, str]]:
    """Retrieves a list of files and directories from the specified directory."""
    items = []
    if not directory.is_dir(): # Check if it exists and is a directory
        logger.warning(f"Directory not found or is not a directory: {directory}")
        return items
    try:
        # Sort items for consistent ordering, maybe dirs first
        sorted_items = sorted(list(directory.iterdir()), key=lambda p: (not p.is_dir(), p.name.lower()))
        for item in sorted_items:
            items.append({"name": item.name, "type": "directory" if item.is_dir() else "file"})
    except OSError as e:
        logger.error(f"Error reading directory {directory}: {e}")
    return items

# --- HTML Routes ---
@app.get("/", response_class=HTMLResponse, summary="Serve Main Home Page")
async def main_page(request: Request):
    """Serves the main index.html page using Jinja2 templating."""
    return templates.TemplateResponse("pages/index/index.html", {"request": request})

@app.get("/run_pipeline", response_class=HTMLResponse, summary="Serve Run Pipeline Page")
async def run_pipeline_page(request: Request):
    """Serves the page where users can select files and start the pipeline."""
    return templates.TemplateResponse("pages/run_pipeline/run_pipeline.html", {"request": request})

@app.get("/results", response_class=HTMLResponse, summary="Serve Results Page")
async def results_page(request: Request):
    """Serves the page displaying pipeline results."""
    return templates.TemplateResponse("pages/results/results.html", {"request": request})

# --- API Data Routes ---
@app.get("/get_data", response_model=List[Dict[str, str]], summary="List Data Files")
async def get_data():
    """Returns a list of files/dirs in 'bioinformatics/data' for frontend dropdowns."""
    if not DATA_DIR.exists():
         logger.error(f"Data directory does not exist: {DATA_DIR}")
         raise HTTPException(status_code=500, detail="Server configuration error: Data directory not found.")
    return get_directory_contents(DATA_DIR)

@app.get("/get_results", response_model=List[Dict[str, str]], summary="List Result Files/Dirs")
async def get_results():
    """Returns a list of files/dirs in 'bioinformatics/results' for the results page."""
    # Ensure results directory exists before trying to list contents
    try:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
         logger.error(f"Could not create or access results directory {RESULTS_DIR}: {e}")
         raise HTTPException(status_code=500, detail="Server configuration error: Cannot access results directory.")
    return get_directory_contents(RESULTS_DIR)

# --- Pipeline Job Routes ---
@app.post("/run_pipeline", status_code=202, summary="Enqueue Pipeline Job")
async def trigger_pipeline(input_data: PipelineInput):
    """
    Receives pipeline parameters, validates paths, and enqueues the job
    using RQ. Returns the job ID upon successful queuing.
    """
    if not pipeline_queue: # Check if RQ is initialized (Redis connection ok)
        logger.error("Attempted to enqueue job, but RQ Queue is not available (Redis connection failed?).")
        raise HTTPException(status_code=503, detail="Background job service unavailable. Please check server logs.")

    pipeline_script_path = BACKEND_APP_DIR / "pipeline.sh"
    if not pipeline_script_path.is_file():
        logger.error(f"Pipeline script not found at: {pipeline_script_path}")
        raise HTTPException(status_code=500, detail="Server configuration error: Pipeline script missing.")

    # --- Validate input files exist ---
    validation_errors = []
    try:
        forward_reads_path = DATA_DIR / input_data.forward_reads_file
        reverse_reads_path = DATA_DIR / input_data.reverse_reads_file
        reference_genome_path = DATA_DIR / input_data.reference_genome_file
        target_regions_path = DATA_DIR / input_data.target_regions_file

        required_files_map = {
            "Forward Reads": forward_reads_path,
            "Reverse Reads": reverse_reads_path,
            "Reference Genome": reference_genome_path,
            "Target Regions": target_regions_path
        }
        for name, file_path in required_files_map.items():
            if not file_path.is_file():
                validation_errors.append(f"{name} file not found: {file_path.name}")

        # Handle optional known variants file path string
        known_variants_path_str = ""
        if input_data.known_variants_file and input_data.known_variants_file.lower() != "none":
            known_variants_path = DATA_DIR / input_data.known_variants_file
            if not known_variants_path.is_file():
                 validation_errors.append(f"Known Variants file not found: {known_variants_path.name}")
            else:
                 known_variants_path_str = str(known_variants_path)

    except Exception as e:
         # Catch potential errors during path construction if input is malformed
         logger.error(f"Error constructing file paths: {e}")
         raise HTTPException(status_code=400, detail="Invalid file name(s) provided.")

    if validation_errors:
        logger.warning(f"Input file validation failed: {'; '.join(validation_errors)}")
        raise HTTPException(status_code=400, detail=f"Input file error(s): {'; '.join(validation_errors)}")
    # --- End Validation ---

    # --- Enqueue the job ---
    try:
        # Convert Path objects to strings for serialization
        job_args = (
            str(pipeline_script_path),
            str(forward_reads_path),
            str(reverse_reads_path),
            str(reference_genome_path),
            str(target_regions_path),
            known_variants_path_str,
        )

        job = pipeline_queue.enqueue(
            f=run_pipeline_task,      # The function defined in tasks.py
            args=job_args,            # Arguments must be serializable
            job_id_prefix="bio_pipeline_", # Optional: Prefix for easier identification
            job_timeout='2h',         # Max time the job can run (e.g., 2 hours)
            result_ttl=86400,         # Keep result for 1 day (in seconds)
            failure_ttl=604800,       # Keep failure info for 1 week (in seconds)
            description=f"Pipeline for {input_data.forward_reads_file}" # For monitoring UI
        )
        logger.info(f"Enqueued job {job.id} with args: {job_args}")
        # Return 202 Accepted status code and the Job ID
        return JSONResponse(
            status_code=202,
            content={"message": "Pipeline job successfully queued.", "job_id": job.id}
        )

    except Exception as e:
        logger.exception("Failed to enqueue pipeline job to Redis.") # Log the full traceback
        raise HTTPException(status_code=500, detail=f"Server error: Could not enqueue job. Check server logs.")

@app.get("/job_status/{job_id}", summary="Get Job Status")
async def get_job_status(job_id: str):
    """
    Pollable endpoint for the frontend to check the status of a background job
    using its Job ID. Returns job status, result (on success), or error info (on failure).
    """
    if not redis_conn: # Check Redis connection availability
        raise HTTPException(status_code=503, detail="Status check unavailable (Redis connection failed).")

    logger.debug(f"Fetching status for job ID: {job_id}")
    try:
        # Fetch the job object from Redis using the connection *without* decode_responses=True
        job = Job.fetch(job_id, connection=redis_conn)

    except NoSuchJobError:
        logger.warning(f"Attempted to fetch status for non-existent job ID: {job_id}")
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found.")
    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error fetching job {job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to status backend.")
    except Exception as e:
        # Catch other potential errors during fetch (e.g., unpickling errors if data is corrupt)
        logger.exception(f"Unexpected error fetching job {job_id} from Redis.")
        raise HTTPException(status_code=500, detail=f"Server error fetching job status.")

    # Get job status and results/errors
    status = job.get_status()
    result = None
    error_info = None
    meta_data = job.meta # Get metadata if worker sets any (e.g., for progress)

    try:
        if job.is_finished: # Status 'finished'
            # result is automatically unpickled by RQ from the task's return value
            result = job.result
            logger.info(f"Job {job_id} has status 'finished'. Result: {result}")
        elif job.is_failed: # Status 'failed'
            # Fetch detailed failure info (traceback string)
            error_info = job.exc_info
            logger.error(f"Job {job_id} has status 'failed'. See RQ details or worker logs.")
            # Provide a generic, safe error message for the frontend
            error_info_summary = "Job failed processing. Please check server logs for details."
    except Exception as e:
        # Handle potential errors during result/exc_info access (e.g., if result is complex and unpickling fails)
        logger.exception(f"Error accessing result/error info for job {job_id} (status: {status}).")
        if status == 'failed':
            error_info_summary = "Job failed, and error details could not be retrieved."
        else: # Should ideally not happen if status is finished, but handle defensively
             error_info_summary = "Could not retrieve job result/error details."


    return JSONResponse(content={
        "job_id": job_id,
        "status": status,
        "result": result, # Contains return value (dict from task) on success
        "error": error_info_summary if status == 'failed' else None, # Provide safe summary on failure
        "meta": meta_data # Include metadata if used
    })

# --- Main execution block (for running with `python app.py`, though `uvicorn` is preferred) ---
# This part is typically handled by main.py now. If you run this file directly,
# you might need to adjust paths or ensure main.py handles uvicorn correctly.
# if __name__ == "__main__":
#     import uvicorn
#     logger.info("Starting Uvicorn server directly from app.py (usually done via main.py)")
#     uvicorn.run(
#         app, # or "backend.app.app:app" if running uvicorn from project root
#         host="0.0.0.0",
#         port=8000,
#         ssl_keyfile=str(PROJECT_ROOT / "tls" / "server.key"),
#         ssl_certfile=str(PROJECT_ROOT / "tls" / "server.crt"),
#         log_level="info" # Match basicConfig level
#      )
