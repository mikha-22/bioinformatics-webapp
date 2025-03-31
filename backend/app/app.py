# backend/app/app.py

import asyncio
import logging
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import List, Dict, Any, Optional # Added Optional
from pydantic import BaseModel
import uuid
import json
import time
import datetime # Added for timestamp conversion

# --- RQ / Redis Imports ---
import redis
from rq import Queue, Worker
from rq.job import Job, JobStatus
from rq.exceptions import NoSuchJobError
# --- NEW: Import Registries ---
from rq.registry import StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry, DeferredJobRegistry, ScheduledJobRegistry

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
STAGED_JOBS_KEY = "staged_pipeline_jobs"

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

# --- Validation Helper ---
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

        if input_data.known_variants_file and input_data.known_variants_file.lower() != "none":
            known_variants_path = DATA_DIR / input_data.known_variants_file
            if not known_variants_path.is_file():
                 validation_errors.append(f"Known Variants file not found: {known_variants_path.name}")
            else:
                 known_variants_path_str = str(known_variants_path)
                 paths_map["known_variants"] = known_variants_path

    except Exception as e:
         logger.error(f"Error constructing file paths during validation: {e}")
         raise HTTPException(status_code=400, detail="Invalid file name format provided.")

    return paths_map, known_variants_path_str, validation_errors

# --- Helper to convert datetime to timestamp ---
def dt_to_timestamp(dt: Optional[datetime.datetime]) -> Optional[float]:
    """Converts a datetime object to a Unix timestamp, handling None."""
    return dt.timestamp() if dt else None


# --- HTML Routes ---
@app.get("/", response_class=HTMLResponse, summary="Serve Main Home Page")
async def main_page(request: Request):
    return templates.TemplateResponse("pages/index/index.html", {"request": request})

@app.get("/run_pipeline", response_class=HTMLResponse, summary="Serve Run Pipeline Page")
async def run_pipeline_page(request: Request):
    return templates.TemplateResponse("pages/run_pipeline/run_pipeline.html", {"request": request})

@app.get("/results", response_class=HTMLResponse, summary="Serve Results Page")
async def results_page(request: Request):
    try:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
         logger.error(f"Could not create or access results directory {RESULTS_DIR}: {e}")
         return templates.TemplateResponse("pages/results/results.html", {"request": request, "output_files": [], "error": "Could not access results directory."})

    # Pass empty list initially, JS will fetch actual files
    # Extract highlight parameter if present
    highlight = request.query_params.get("highlight")
    return templates.TemplateResponse("pages/results/results.html", {"request": request, "output_files": [], "highlight": highlight})

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

# --- REPLACED: /staged_jobs is now /jobs_list ---
# --- NEW: API Route to Get ALL Jobs (Staged, Running, Finished, Failed) ---
@app.get("/jobs_list", response_model=List[Dict[str, Any]], summary="List All Relevant Jobs")
async def get_jobs_list():
    """
    Returns a list of jobs including staged, running, finished, and failed.
    """
    if not redis_conn or not pipeline_queue:
        raise HTTPException(status_code=503, detail="Service unavailable: Cannot connect to job storage.")

    all_jobs_dict = {} # Use dict to easily merge/overwrite

    # 1. Get Staged Jobs
    try:
        staged_jobs_raw = redis_conn.hgetall(STAGED_JOBS_KEY)
        for job_id_bytes, job_details_bytes in staged_jobs_raw.items():
            try:
                job_id = job_id_bytes.decode('utf-8')
                details = json.loads(job_details_bytes.decode('utf-8'))
                all_jobs_dict[job_id] = {
                    "id": job_id,
                    "status": "staged",
                    "description": details.get("description", "N/A"),
                    "enqueued_at": None,
                    "started_at": None,
                    "ended_at": None,
                    "result": None,
                    "error": None,
                    "meta": {"input_params": details}, # Store original params here
                    "staged_at": details.get("staged_at") # Keep staged time
                }
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                logger.error(f"Error decoding/parsing staged job data for key {job_id_bytes}: {e}")
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error fetching staged jobs: {e}")
        # Continue to fetch other types if possible

    # 2. Get Jobs from RQ Registries
    # Limit how many finished/failed jobs to retrieve to avoid performance issues
    MAX_REGISTRY_JOBS = 50
    registries = {
        "started": StartedJobRegistry(queue=pipeline_queue),
        "finished": FinishedJobRegistry(queue=pipeline_queue),
        "failed": FailedJobRegistry(queue=pipeline_queue),
        # Add others like DeferredJobRegistry if needed
    }

    for status_name, registry in registries.items():
        try:
            limit = -1 if status_name == "started" else MAX_REGISTRY_JOBS # No limit for started
            job_ids = registry.get_job_ids(0, limit)
            if job_ids:
                jobs = Job.fetch_many(job_ids, connection=redis_conn, serializer=pipeline_queue.serializer)
                for job in jobs:
                    if job: # fetch_many might return None for missing jobs
                        # Avoid overwriting a potentially newer status if ID conflict (unlikely)
                        if job.id not in all_jobs_dict or all_jobs_dict[job.id]['status'] == 'staged':
                            # Try fetching potentially missing meta if not loaded by fetch_many
                            if not job.meta and job.connection:
                                job.refresh()

                            error_summary = None
                            if job.get_status() == JobStatus.FAILED:
                                error_summary = "Job failed processing. Check server logs for details."
                                # Try to get a shorter message if available in meta
                                if job.meta and 'error_message' in job.meta:
                                    error_summary = job.meta['error_message']
                                elif job.exc_info:
                                    try:
                                      # Extract last line of traceback if possible
                                      lines = job.exc_info.strip().split('\n')
                                      if lines: error_summary = lines[-1]
                                    except Exception:
                                        pass # Keep generic message


                            all_jobs_dict[job.id] = {
                                "id": job.id,
                                "status": job.get_status(),
                                "description": job.description or "N/A",
                                "enqueued_at": dt_to_timestamp(job.enqueued_at),
                                "started_at": dt_to_timestamp(job.started_at),
                                "ended_at": dt_to_timestamp(job.ended_at),
                                "result": job.result,
                                "error": error_summary, # Use the potentially summarized error
                                "meta": job.meta or {}, # Ensure meta is a dict
                                "staged_at": None # Not applicable directly
                            }

        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error fetching {status_name} jobs: {e}")
        except Exception as e:
            logger.exception(f"Unexpected error fetching {status_name} jobs.")

    # Convert dict back to list and sort (e.g., by enqueue/staged time, newest first)
    all_jobs_list = sorted(
        all_jobs_dict.values(),
        key=lambda j: j.get('enqueued_at') or j.get('staged_at') or time.time(), # Sort primarily by enqueue/staged time
        reverse=True
    )

    return all_jobs_list


# --- MODIFIED: Pipeline Job Route (Stages Job) ---
@app.post("/run_pipeline", status_code=200, summary="Stage Pipeline Job")
async def stage_pipeline_job(input_data: PipelineInput):
    """
    Receives pipeline parameters, validates paths, and STORES the job parameters
    in Redis for later execution. Returns the staged job ID.
    """
    if not redis_conn:
        logger.error("Attempted to stage job, but Redis connection is not available.")
        raise HTTPException(status_code=503, detail="Service unavailable. Please check server logs.")

    pipeline_script_path = BACKEND_APP_DIR / "pipeline.sh"
    if not pipeline_script_path.is_file():
        logger.error(f"Pipeline script not found at: {pipeline_script_path}")
        raise HTTPException(status_code=500, detail="Server configuration error: Pipeline script missing.")

    paths_map, known_variants_path_str, validation_errors = validate_pipeline_input(input_data)
    if validation_errors:
        logger.warning(f"Input file validation failed: {'; '.join(validation_errors)}")
        raise HTTPException(status_code=400, detail=f"Input file error(s): {'; '.join(validation_errors)}")

    try:
        staged_job_id = f"staged_{uuid.uuid4()}"

        # Store paths as strings AND the original input filenames for display/rerun
        job_details = {
            "pipeline_script_path": str(pipeline_script_path),
            "forward_reads_path": str(paths_map["forward_reads"]),
            "reverse_reads_path": str(paths_map["reverse_reads"]),
            "reference_genome_path": str(paths_map["reference_genome"]),
            "target_regions_path": str(paths_map["target_regions"]),
            "known_variants_path": known_variants_path_str,
            "description": f"Pipeline for {input_data.forward_reads_file}",
            "staged_at": time.time(),
            # --- NEW: Store original inputs for display/rerun ---
            "input_filenames": {
                 "forward_reads": input_data.forward_reads_file,
                 "reverse_reads": input_data.reverse_reads_file,
                 "reference_genome": input_data.reference_genome_file,
                 "target_regions": input_data.target_regions_file,
                 "known_variants": input_data.known_variants_file
            }
        }

        redis_conn.hset(STAGED_JOBS_KEY, staged_job_id, json.dumps(job_details))
        logger.info(f"Staged job {staged_job_id}")

        return JSONResponse(
            status_code=200,
            content={"message": "Pipeline job successfully staged.", "staged_job_id": staged_job_id}
        )

    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error staging job: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not stage job.")
    except Exception as e:
        logger.exception("Failed to stage pipeline job.")
        raise HTTPException(status_code=500, detail="Server error: Could not stage job.")


# --- MODIFIED: Start Staged Job Route ---
@app.post("/start_job/{staged_job_id}", status_code=202, summary="Enqueue Staged Job")
async def start_job(staged_job_id: str):
    """
    Retrieves a staged job's details, enqueues it to RQ (storing params in meta),
    and removes it from staging. Returns the RQ job ID.
    """
    if not redis_conn or not pipeline_queue:
        logger.error("Attempted to start job, but Redis/RQ connection is not available.")
        raise HTTPException(status_code=503, detail="Background job service unavailable.")

    try:
        job_details_json_bytes = redis_conn.hget(STAGED_JOBS_KEY, staged_job_id)
        if not job_details_json_bytes:
            logger.warning(f"Attempted to start non-existent staged job ID: {staged_job_id}")
            raise HTTPException(status_code=404, detail=f"Staged job {staged_job_id} not found.")

        job_details = json.loads(job_details_json_bytes.decode('utf-8'))

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
            job_details.get("known_variants_path", ""),
        )

        # --- NEW: Prepare meta data for the RQ job ---
        job_meta = {
            # Store the *original filenames* used for staging
            "input_params": job_details.get("input_filenames", {}),
            # Store the staged ID for potential traceability
            "staged_job_id_origin": staged_job_id
        }

        job = pipeline_queue.enqueue(
            f=run_pipeline_task,
            args=job_args,
            meta=job_meta, # <-- Pass meta data here
            job_id_prefix="bio_pipeline_",
            job_timeout='2h',
            result_ttl=86400, # Keep results for 1 day
            failure_ttl=604800, # Keep failed jobs for 1 week
            description=job_details.get("description", f"Run from {staged_job_id}")
        )
        logger.info(f"Enqueued RQ job {job.id} from staged job {staged_job_id} with meta: {job_meta}")

        redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id)
        logger.info(f"Removed staged job {staged_job_id} from Redis.")

        return JSONResponse(
            status_code=202,
            content={"message": "Pipeline job successfully enqueued.", "job_id": job.id}
        )

    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error starting job {staged_job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable starting job.")
    except json.JSONDecodeError as e:
        logger.error(f"Error decoding JSON for staged job {staged_job_id}: {e}")
        raise HTTPException(status_code=500, detail="Corrupted staged job data.")
    except Exception as e:
        logger.exception(f"Failed to start/enqueue staged job {staged_job_id}.")
        raise HTTPException(status_code=500, detail="Server error: Could not start job.")


# --- MODIFIED: Job Status Route ---
@app.get("/job_status/{job_id}", summary="Get RQ Job Status")
async def get_job_status(job_id: str):
    """
    Pollable endpoint to check the status of a background RQ job.
    Now ensures meta data is included.
    """
    if not redis_conn:
        raise HTTPException(status_code=503, detail="Status check unavailable (Redis connection failed).")

    logger.debug(f"Fetching status for RQ job ID: {job_id}")
    try:
        job = Job.fetch(job_id, connection=redis_conn, serializer=pipeline_queue.serializer)
        # --- NEW: Explicitly refresh to ensure meta is loaded ---
        job.refresh()

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
    meta_data = job.meta or {} # Ensure meta is a dict
    error_info_summary = None

    try:
        if status == JobStatus.FINISHED:
            result = job.result # Access result only if finished
            logger.info(f"RQ Job {job_id} status 'finished'. Result: {result}")
        elif status == JobStatus.FAILED:
            error_info_summary = "Job failed processing. Check server logs for details."
            if meta_data and 'error_message' in meta_data:
                 error_info_summary = meta_data['error_message']
            elif job.exc_info:
                 try:
                     lines = job.exc_info.strip().split('\n')
                     if lines: error_info_summary = lines[-1]
                 except Exception: pass # Keep generic message
            logger.error(f"RQ Job {job_id} status 'failed'. Error Summary: {error_info_summary}")

    except Exception as e:
        # Handle potential exceptions when accessing result/exc_info
        logger.exception(f"Error accessing result/error info for job {job_id} (status: {status}).")
        if status == JobStatus.FAILED:
            error_info_summary = "Job failed, and error details could not be fully retrieved."
        else:
             error_info_summary = "Could not retrieve job result/error details."

    return JSONResponse(content={
        "job_id": job_id,
        "status": status,
        "result": result,
        "error": error_info_summary,
        "meta": meta_data, # Return the meta data
        # Include timestamps for duration calculation
        "enqueued_at": dt_to_timestamp(job.enqueued_at),
        "started_at": dt_to_timestamp(job.started_at),
        "ended_at": dt_to_timestamp(job.ended_at)
    })


# --- Stop Job Route (Keep as is) ---
@app.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued Job")
async def stop_job(job_id: str):
    """ Attempts to cancel an RQ job (queued or running) using its RQ Job ID. """
    if not redis_conn:
        logger.error(f"Attempted to stop job {job_id}, but Redis connection is not available.")
        raise HTTPException(status_code=503, detail="Service unavailable (Redis connection failed).")

    logger.info(f"Received request to stop job: {job_id}")
    try:
        job = Job.fetch(job_id, connection=redis_conn)
        status = job.get_status()
        logger.info(f"Job {job_id} current status: {status}")

        if job.is_finished or job.is_failed or job.is_canceled or job.is_stopped:
             logger.warning(f"Job {job_id} is already in a terminal state ({status}). Cannot stop.")
             return JSONResponse(
                 status_code=200,
                 content={"message": f"Job already {status}.", "job_id": job_id}
             )

        logger.info(f"Attempting to cancel job {job_id}...")
        # Use send_stop_signal for potentially cleaner shutdown if task supports it
        # Fallback to cancel if needed. For simplicity, let's stick to cancel for now.
        from rq.command import send_stop_job_command
        try:
            send_stop_job_command(redis_conn, job.id)
            logger.info(f"Sent stop signal command for job {job_id}.")
            message = "Stop signal sent."
        except Exception as sig_err:
            logger.warning(f"Could not send stop signal for job {job_id} (maybe not running?), attempting generic cancel. Error: {sig_err}")
            job.cancel()
            message = "Cancellation request sent (fallback)."


        logger.info(f"Stop/Cancel request processed for job {job_id}.")
        return JSONResponse(
            status_code=200,
            content={"message": message, "job_id": job_id}
        )

    except NoSuchJobError:
        logger.warning(f"Attempted to stop non-existent RQ job ID: {job_id}")
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found.")
    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error interacting with job {job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to job backend.")
    except Exception as e:
        logger.exception(f"Unexpected error stopping job {job_id}.")
        raise HTTPException(status_code=500, detail=f"Server error stopping job.")


# --- (No changes needed for tasks.py unless you want finer-grained error reporting in meta)
