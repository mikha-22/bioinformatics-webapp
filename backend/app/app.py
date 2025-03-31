# backend/app/app.py

import asyncio
import logging
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import List, Dict, Any # Added Any
from pydantic import BaseModel
import uuid # <-- Import UUID
import json # <-- Import JSON
import time

# --- RQ / Redis Imports ---
import redis
from rq import Queue
from rq.job import Job
from rq.exceptions import NoSuchJobError

# --- Import Task Function ---
try:
    from .tasks import run_pipeline_task
except ImportError:
    from tasks import run_pipeline_task

# --- Basic Logging Setup ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- FastAPI App Initialization ---
app = FastAPI(title="Bioinformatics Webapp")

# --- Path Definitions ---
APP_FILE_PATH = Path(__file__).resolve()
BACKEND_APP_DIR = APP_FILE_PATH.parent
PROJECT_ROOT = BACKEND_APP_DIR.parents[1]
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
try:
    app.mount("/frontend/static", StaticFiles(directory=str(STATIC_DIR)), name="frontend_static")
    logger.info(f"Mounted static directory: {STATIC_DIR}")
except RuntimeError as e:
    logger.error(f"Error mounting static directory '{STATIC_DIR}': {e}. Check if directory exists.")

# --- CORS Configuration ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# --- Redis Connection and RQ Queue ---
REDIS_HOST = "localhost"
REDIS_PORT = 6379
REDIS_DB = 0
PIPELINE_QUEUE_NAME = "pipeline_tasks"
STAGED_JOBS_KEY = "staged_pipeline_jobs" # <-- Key for Redis Hash storing staged jobs

redis_conn = None
pipeline_queue = None

try:
    # *** Ensure decode_responses=False for RQ compatibility ***
    redis_conn = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB, decode_responses=False)
    redis_conn.ping()
    logger.info(f"Successfully connected to Redis at {REDIS_HOST}:{REDIS_PORT}")
    pipeline_queue = Queue(PIPELINE_QUEUE_NAME, connection=redis_conn)
    logger.info(f"RQ Queue '{PIPELINE_QUEUE_NAME}' initialized.")

except redis.exceptions.ConnectionError as e:
    logger.error(f"FATAL: Could not connect to Redis at {REDIS_HOST}:{REDIS_PORT}. RQ and Job Staging will not work. Error: {e}")
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
    known_variants_file: str | None = None

# --- Helper Function ---
def get_directory_contents(directory: Path) -> List[Dict[str, str]]:
    """Retrieves a list of files and directories from the specified directory."""
    items = []
    if not directory.is_dir():
        logger.warning(f"Directory not found or is not a directory: {directory}")
        return items
    try:
        sorted_items = sorted(list(directory.iterdir()), key=lambda p: (not p.is_dir(), p.name.lower()))
        for item in sorted_items:
            items.append({"name": item.name, "type": "directory" if item.is_dir() else "file"})
    except OSError as e:
        logger.error(f"Error reading directory {directory}: {e}")
    return items

# --- Validation Helper (Moved out for reuse) ---
def validate_pipeline_input(input_data: PipelineInput) -> tuple[Dict[str, Path], str | None, List[str]]:
    """Validates input files exist and returns paths and errors."""
    validation_errors = []
    paths_map: Dict[str, Path] = {}
    known_variants_path_str = None

    try:
        paths_map["forward_reads"] = DATA_DIR / input_data.forward_reads_file
        paths_map["reverse_reads"] = DATA_DIR / input_data.reverse_reads_file
        paths_map["reference_genome"] = DATA_DIR / input_data.reference_genome_file
        paths_map["target_regions"] = DATA_DIR / input_data.target_regions_file

        required_files_display_map = {
            "Forward Reads": paths_map["forward_reads"],
            "Reverse Reads": paths_map["reverse_reads"],
            "Reference Genome": paths_map["reference_genome"],
            "Target Regions": paths_map["target_regions"]
        }
        for name, file_path in required_files_display_map.items():
            if not file_path.is_file():
                validation_errors.append(f"{name} file not found: {file_path.name}")

        # Handle optional known variants file path string
        if input_data.known_variants_file and input_data.known_variants_file.lower() != "none":
            known_variants_path = DATA_DIR / input_data.known_variants_file
            if not known_variants_path.is_file():
                 validation_errors.append(f"Known Variants file not found: {known_variants_path.name}")
            else:
                 known_variants_path_str = str(known_variants_path) # Store as string
                 paths_map["known_variants"] = known_variants_path # Also add Path object if needed later

    except Exception as e:
         logger.error(f"Error constructing file paths during validation: {e}")
         # This usually indicates a bad filename format rather than file not found
         raise HTTPException(status_code=400, detail="Invalid file name format provided.")

    return paths_map, known_variants_path_str, validation_errors


# --- HTML Routes ---
@app.get("/", response_class=HTMLResponse, summary="Serve Main Home Page")
async def main_page(request: Request):
    return templates.TemplateResponse("pages/index/index.html", {"request": request})

@app.get("/run_pipeline", response_class=HTMLResponse, summary="Serve Run Pipeline Page")
async def run_pipeline_page(request: Request):
    return templates.TemplateResponse("pages/run_pipeline/run_pipeline.html", {"request": request})

@app.get("/results", response_class=HTMLResponse, summary="Serve Results Page")
async def results_page(request: Request):
    # Check if results dir exists, create if not (moved from get_results API)
    try:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
         logger.error(f"Could not create or access results directory {RESULTS_DIR}: {e}")
         # Render page but show an error? Or raise 500? Let's render with empty list.
         return templates.TemplateResponse("pages/results/results.html", {"request": request, "output_files": [], "error": "Could not access results directory."})

    # Pass empty list initially, JS will fetch actual files
    return templates.TemplateResponse("pages/results/results.html", {"request": request, "output_files": []})

# --- NEW: HTML Route for Jobs Page ---
@app.get("/jobs", response_class=HTMLResponse, summary="Serve Jobs Page")
async def jobs_page(request: Request):
    """Serves the page listing staged and running jobs."""
    return templates.TemplateResponse("pages/jobs/jobs.html", {"request": request})


# --- API Data Routes ---
@app.get("/get_data", response_model=List[Dict[str, str]], summary="List Data Files")
async def get_data():
    if not DATA_DIR.exists():
         logger.error(f"Data directory does not exist: {DATA_DIR}")
         raise HTTPException(status_code=500, detail="Server configuration error: Data directory not found.")
    return get_directory_contents(DATA_DIR)

@app.get("/get_results", response_model=List[Dict[str, str]], summary="List Result Files/Dirs")
async def get_results():
    if not RESULTS_DIR.exists():
        logger.warning(f"Results directory not found: {RESULTS_DIR}. Returning empty list.")
        return [] # Return empty list if dir doesn't exist yet
    return get_directory_contents(RESULTS_DIR)

# --- NEW: API Route to Get Staged Jobs ---
@app.get("/staged_jobs", response_model=Dict[str, Any], summary="List Staged Jobs")
async def get_staged_jobs():
    """Returns a dictionary of jobs staged in Redis, keyed by staged_job_id."""
    if not redis_conn:
        raise HTTPException(status_code=503, detail="Service unavailable: Cannot connect to job storage.")
    try:
        staged_jobs_raw = redis_conn.hgetall(STAGED_JOBS_KEY)
        staged_jobs = {}
        for job_id_bytes, job_details_bytes in staged_jobs_raw.items():
            try:
                # Decode keys and values assuming UTF-8, then parse JSON
                job_id = job_id_bytes.decode('utf-8')
                job_details = json.loads(job_details_bytes.decode('utf-8'))
                staged_jobs[job_id] = job_details
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                logger.error(f"Error decoding/parsing staged job data for key {job_id_bytes}: {e}")
                # Skip corrupted entries
        return staged_jobs
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error fetching staged jobs: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not fetch staged jobs.")
    except Exception as e:
        logger.exception("Unexpected error fetching staged jobs.")
        raise HTTPException(status_code=500, detail="Server error fetching staged jobs.")

# --- MODIFIED: Pipeline Job Route (Now Stages Job) ---
@app.post("/run_pipeline", status_code=200, summary="Stage Pipeline Job") # Changed status code to 200
async def stage_pipeline_job(input_data: PipelineInput):
    """
    Receives pipeline parameters, validates paths, and STORES the job parameters
    in Redis for later execution. Returns the staged job ID.
    """
    if not redis_conn: # Check Redis connection
        logger.error("Attempted to stage job, but Redis connection is not available.")
        raise HTTPException(status_code=503, detail="Service unavailable. Please check server logs.")

    pipeline_script_path = BACKEND_APP_DIR / "pipeline.sh"
    if not pipeline_script_path.is_file():
        logger.error(f"Pipeline script not found at: {pipeline_script_path}")
        raise HTTPException(status_code=500, detail="Server configuration error: Pipeline script missing.")

    # --- Validate input files exist ---
    paths_map, known_variants_path_str, validation_errors = validate_pipeline_input(input_data)
    if validation_errors:
        logger.warning(f"Input file validation failed: {'; '.join(validation_errors)}")
        raise HTTPException(status_code=400, detail=f"Input file error(s): {'; '.join(validation_errors)}")
    # --- End Validation ---

    # --- Store the job details in Redis Hash ---
    try:
        staged_job_id = f"staged_{uuid.uuid4()}" # Generate a unique ID for the staged job

        # Store paths as strings for JSON serialization
        job_details = {
            "pipeline_script_path": str(pipeline_script_path),
            "forward_reads_path": str(paths_map["forward_reads"]),
            "reverse_reads_path": str(paths_map["reverse_reads"]),
            "reference_genome_path": str(paths_map["reference_genome"]),
            "target_regions_path": str(paths_map["target_regions"]),
            "known_variants_path": known_variants_path_str, # Already a string or None
            "description": f"Pipeline for {input_data.forward_reads_file}", # Keep description
            "staged_at": time.time() # Add timestamp
        }

        # Use hset to add/update the job in the hash
        redis_conn.hset(STAGED_JOBS_KEY, staged_job_id, json.dumps(job_details))

        logger.info(f"Staged job {staged_job_id} with details: {job_details}")

        # Return 200 OK with the staged job ID
        return JSONResponse(
            status_code=200,
            content={"message": "Pipeline job successfully staged. Go to the Jobs page to start it.", "staged_job_id": staged_job_id}
        )

    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error staging job: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not stage job.")
    except Exception as e:
        logger.exception("Failed to stage pipeline job.")
        raise HTTPException(status_code=500, detail="Server error: Could not stage job.")


# --- NEW: API Route to Start a Staged Job ---
@app.post("/start_job/{staged_job_id}", status_code=202, summary="Enqueue Staged Job")
async def start_job(staged_job_id: str):
    """
    Retrieves a staged job's details from Redis, enqueues it to RQ,
    and removes it from the staging area. Returns the RQ job ID.
    """
    if not redis_conn or not pipeline_queue:
        logger.error("Attempted to start job, but Redis/RQ connection is not available.")
        raise HTTPException(status_code=503, detail="Background job service unavailable.")

    try:
        # 1. Retrieve job details from Redis Hash
        job_details_json_bytes = redis_conn.hget(STAGED_JOBS_KEY, staged_job_id)
        if not job_details_json_bytes:
            logger.warning(f"Attempted to start non-existent staged job ID: {staged_job_id}")
            raise HTTPException(status_code=404, detail=f"Staged job {staged_job_id} not found.")

        job_details = json.loads(job_details_json_bytes.decode('utf-8'))

        # 2. Prepare arguments for the RQ task function
        # Ensure all required paths are present in the stored details
        required_keys = [
            "pipeline_script_path", "forward_reads_path", "reverse_reads_path",
            "reference_genome_path", "target_regions_path"
        ]
        if not all(key in job_details for key in required_keys):
             logger.error(f"Corrupted staged job data for {staged_job_id}: Missing required paths.")
             raise HTTPException(status_code=500, detail="Corrupted job data found.")

        job_args = (
            job_details["pipeline_script_path"],
            job_details["forward_reads_path"],
            job_details["reverse_reads_path"],
            job_details["reference_genome_path"],
            job_details["target_regions_path"],
            job_details.get("known_variants_path", ""), # Use get for optional key, default empty string
        )

        # 3. Enqueue the job
        job = pipeline_queue.enqueue(
            f=run_pipeline_task,
            args=job_args,
            job_id_prefix="bio_pipeline_", # RQ job ID will start with this
            job_timeout='2h',
            result_ttl=86400,
            failure_ttl=604800,
            description=job_details.get("description", f"Started from staged job {staged_job_id}")
        )
        logger.info(f"Enqueued RQ job {job.id} from staged job {staged_job_id} with args: {job_args}")

        # 4. Remove the job from the staging Hash *after successful enqueue*
        redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id)
        logger.info(f"Removed staged job {staged_job_id} from Redis.")

        # 5. Return 202 Accepted with the RQ Job ID
        return JSONResponse(
            status_code=202,
            content={"message": "Pipeline job successfully enqueued for processing.", "job_id": job.id}
        )

    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error starting job {staged_job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable starting job.")
    except json.JSONDecodeError as e:
        logger.error(f"Error decoding JSON for staged job {staged_job_id}: {e}")
        # Consider deleting the corrupted entry? redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id)
        raise HTTPException(status_code=500, detail="Corrupted staged job data.")
    except Exception as e:
        logger.exception(f"Failed to start/enqueue staged job {staged_job_id}.")
        raise HTTPException(status_code=500, detail="Server error: Could not start job.")


@app.get("/job_status/{job_id}", summary="Get RQ Job Status")
async def get_job_status(job_id: str):
    """
    Pollable endpoint for the frontend to check the status of a background RQ job
    using its RQ Job ID. Returns job status, result, or error info.
    (No changes needed here, it already works with RQ job IDs)
    """
    if not redis_conn:
        raise HTTPException(status_code=503, detail="Status check unavailable (Redis connection failed).")

    logger.debug(f"Fetching status for RQ job ID: {job_id}")
    try:
        job = Job.fetch(job_id, connection=redis_conn)

    except NoSuchJobError:
        logger.warning(f"Attempted to fetch status for non-existent RQ job ID: {job_id}")
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found.")
    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error fetching RQ job {job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to status backend.")
    except Exception as e:
        logger.exception(f"Unexpected error fetching job {job_id} from Redis.")
        raise HTTPException(status_code=500, detail=f"Server error fetching job status.")

    status = job.get_status()
    result = None
    error_info = None
    meta_data = job.meta
    error_info_summary = None # Initialize error summary

    try:
        if job.is_finished:
            result = job.result
            logger.info(f"RQ Job {job_id} status 'finished'. Result: {result}")
        elif job.is_failed:
            error_info = job.exc_info # Contains traceback
            logger.error(f"RQ Job {job_id} status 'failed'. See RQ details or worker logs.")
            error_info_summary = "Job failed processing. Check server logs for details."
    except Exception as e:
        logger.exception(f"Error accessing result/error info for job {job_id} (status: {status}).")
        if status == 'failed':
            error_info_summary = "Job failed, and error details could not be retrieved."
        else:
             error_info_summary = "Could not retrieve job result/error details."

    return JSONResponse(content={
        "job_id": job_id,
        "status": status,
        "result": result,
        "error": error_info_summary, # Use the summary
        "meta": meta_data
    })

# (Keep the main execution block commented out or removed if using main.py)
# import time # Add near other imports if not already present
