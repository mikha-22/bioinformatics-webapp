# backend/app/app.py

import asyncio
import logging
from fastapi import FastAPI, Request, HTTPException, Depends # Added Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse # Added FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
import uuid
import json
import time
import datetime # Added for timestamp conversion
import os # Added for file stats
import urllib.parse # Added for URL encoding run dir names

# --- RQ / Redis Imports ---
import redis
from rq import Queue, Worker
from rq.job import Job, JobStatus
from rq.exceptions import NoSuchJobError
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
DOCKER_DIR = PROJECT_ROOT / "docker" # Added for reading File Browser settings

logger.info(f"Project Root resolved to: {PROJECT_ROOT}")
logger.info(f"Static Directory resolved to: {STATIC_DIR}")
logger.info(f"Results Directory resolved to: {RESULTS_DIR}")

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
    allow_origins=["*"], # Be more specific in production
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"], # Added DELETE if needed later
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
    redis_conn = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB, decode_responses=False)
    redis_conn.ping()
    logger.info(f"Successfully connected to Redis at {REDIS_HOST}:{REDIS_PORT}")
    pipeline_queue = Queue(PIPELINE_QUEUE_NAME, connection=redis_conn)
    logger.info(f"RQ Queue '{PIPELINE_QUEUE_NAME}' initialized.")
except redis.exceptions.ConnectionError as e:
    logger.error(f"FATAL: Could not connect to Redis at {REDIS_HOST}:{REDIS_PORT}. RQ and Job Staging will not work. Error: {e}")
    redis_conn = None
    pipeline_queue = None
except Exception as e:
    logger.error(f"FATAL: An unexpected error occurred during Redis/RQ initialization: {e}")
    redis_conn = None
    pipeline_queue = None

# --- File Browser Config Loading (Helper) ---
def get_filebrowser_config() -> Dict[str, Any]:
    """Loads File Browser base URL from settings.json"""
    settings_path = DOCKER_DIR / "settings.json"
    config = {"baseURL": "/filebrowser"} # Default fallback
    try:
        if settings_path.is_file():
            with open(settings_path, 'r') as f:
                fb_settings = json.load(f)
                config["baseURL"] = fb_settings.get("baseURL", "/filebrowser").strip('/')
                # Add other settings if needed
            logger.info(f"Loaded File Browser config: baseURL=/{config['baseURL']}")
        else:
            logger.warning(f"File Browser settings not found at {settings_path}, using default baseURL.")
    except (json.JSONDecodeError, OSError) as e:
        logger.error(f"Error reading File Browser settings: {e}, using default baseURL.")
    return config

# --- Pydantic Model for Input Validation ---
class PipelineInput(BaseModel):
    forward_reads_file: str
    reverse_reads_file: str
    reference_genome_file: str
    target_regions_file: str
    known_variants_file: str | None = None

# --- Helper Functions ---
def dt_to_timestamp(dt: Optional[datetime.datetime]) -> Optional[float]:
    """Converts a datetime object to a Unix timestamp, handling None."""
    return dt.timestamp() if dt else None

def get_safe_path(base_dir: Path, requested_path: str) -> Path:
    """Safely join a base directory and a requested path, preventing path traversal."""
    # Decode URL component
    decoded_path_str = urllib.parse.unquote(requested_path)
    # Create Path object
    requested = Path(decoded_path_str)

    # Ensure the requested path is relative and does not contain '..'
    if requested.is_absolute() or '..' in requested.parts:
        logger.warning(f"Attempted path traversal: {requested_path}")
        raise HTTPException(status_code=400, detail="Invalid path requested.")

    # Join with base directory
    full_path = (base_dir / requested).resolve()

    # Check if the resolved path is still within the base directory
    if base_dir.resolve() not in full_path.parents and full_path != base_dir.resolve():
         logger.warning(f"Attempted path traversal resolved outside base: {full_path} (Base: {base_dir.resolve()})")
         raise HTTPException(status_code=400, detail="Invalid path requested.")

    return full_path


def get_directory_contents(directory: Path, list_dirs: bool = False, list_files: bool = False, fb_base_url: str = "filebrowser") -> List[Dict[str, Any]]:
    """Retrieves metadata for items in a directory."""
    items = []
    if not directory.is_dir():
        logger.warning(f"Directory not found or is not a directory: {directory}")
        return items
    try:
        # Sort directories first, then files, alphabetically
        sorted_paths = sorted(
            list(directory.iterdir()),
            key=lambda p: (not p.is_dir(), p.name.lower())
        )

        for item_path in sorted_paths:
            item_info = {}
            is_dir = item_path.is_dir()

            if (is_dir and list_dirs) or (not is_dir and list_files):
                try:
                    stat_result = item_path.stat()
                    item_info = {
                        "name": item_path.name,
                        "is_dir": is_dir,
                        "modified_time": stat_result.st_mtime,
                        "size": stat_result.st_size if not is_dir else None,
                        "extension": item_path.suffix.lower() if not is_dir else None,
                        # Generate File Browser link ONLY if listing directories (for runs list)
                        "filebrowser_link": f"/{fb_base_url}/files/{urllib.parse.quote(item_path.name)}" if is_dir and list_dirs else None
                    }
                    items.append(item_info)
                except OSError as stat_e:
                    logger.error(f"Could not get stat for item {item_path}: {stat_e}")
                    # Optionally add a placeholder for inaccessible items
                    items.append({
                        "name": item_path.name,
                        "is_dir": is_dir,
                        "error": "Could not access item metadata."
                    })

    except OSError as list_e:
        logger.error(f"Error reading directory {directory}: {list_e}")
        # Consider raising an exception or returning an error indicator
        raise HTTPException(status_code=500, detail=f"Error reading directory: {directory.name}") from list_e

    return items


# --- Validation Helper ---
# (No changes needed in validate_pipeline_input)
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


# --- HTML Routes ---
# (No changes needed for HTML routes serving templates, including /results)
@app.get("/", response_class=HTMLResponse, summary="Serve Main Home Page")
async def main_page(request: Request):
    return templates.TemplateResponse("pages/index/index.html", {"request": request})

@app.get("/run_pipeline", response_class=HTMLResponse, summary="Serve Run Pipeline Page")
async def run_pipeline_page(request: Request):
    return templates.TemplateResponse("pages/run_pipeline/run_pipeline.html", {"request": request})

@app.get("/results", response_class=HTMLResponse, summary="Serve Results Page")
async def results_page(request: Request):
    # Ensure RESULTS_DIR exists (or log error)
    try:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
         logger.error(f"Could not create or access results directory {RESULTS_DIR}: {e}")
         # Render template anyway, JS will show error
    # Extract highlight parameter if present
    highlight = request.query_params.get("highlight")
    return templates.TemplateResponse("pages/results/results.html", {"request": request, "highlight": highlight})


@app.get("/jobs", response_class=HTMLResponse, summary="Serve Jobs Page")
async def jobs_page(request: Request):
    return templates.TemplateResponse("pages/jobs/jobs.html", {"request": request})


# --- API Data Routes ---
@app.get("/get_data", response_model=List[Dict[str, str]], summary="List Data Files")
async def get_data():
    if not DATA_DIR.exists():
         logger.error(f"Data directory does not exist: {DATA_DIR}")
         raise HTTPException(status_code=500, detail="Server configuration error: Data directory not found.")

    fb_config = get_filebrowser_config() # Keep getting config in case helper uses it internally

    try:
        # Get the detailed contents first using the helper
        # We want only files listed for this endpoint's purpose
        full_contents = get_directory_contents(
            DATA_DIR,
            list_dirs=False, # Don't list directories
            list_files=True,  # DO list files
            fb_base_url=fb_config["baseURL"]
        )

        # --- NEW: Simplify the response to match the response_model ---
        # The model List[Dict[str, str]] expects {'name': 'some_name', 'type': 'file'/'directory'}
        simplified_response = []
        for item in full_contents:
            # Ensure we only process files returned by the helper
            if not item.get("is_dir", True): # Check 'is_dir' is explicitly False
                simplified_response.append({
                    "name": item.get("name", "Unknown"), # Get the name
                    "type": "file" # Hardcode type as 'file' since we only asked for files
                })
        # --- End Simplification ---

        return simplified_response # Return the simplified list

    except HTTPException as e:
        # Propagate specific exceptions raised by get_directory_contents or get_safe_path
        logger.error(f"HTTPException in /get_data processing: {e.detail}")
        raise e
    except Exception as e:
        # Catch any other unexpected errors during processing
        logger.exception(f"Unexpected error processing data directory contents for /get_data: {e}")
        raise HTTPException(status_code=500, detail="Internal server error processing data list.")
    
# --- MODIFIED: /get_results API Route ---
@app.get("/get_results", response_model=List[Dict[str, Any]], summary="List Result Run Directories")
async def get_results_runs(fb_config: Dict = Depends(get_filebrowser_config)):
    """Lists the subdirectories (pipeline runs) within the main results directory."""
    if not RESULTS_DIR.exists():
        logger.warning(f"Results directory not found: {RESULTS_DIR}. Returning empty list.")
        return []
    # Use helper to list ONLY directories and include File Browser link
    return get_directory_contents(RESULTS_DIR, list_dirs=True, list_files=False, fb_base_url=fb_config["baseURL"])


# --- NEW: API Route to Get Files WITHIN a Result Directory ---
@app.get("/get_results/{run_dir_name:path}", response_model=List[Dict[str, Any]], summary="List Files in a Specific Run Directory")
async def get_results_run_files(run_dir_name: str):
    """
    Lists the files and subdirectories within a specific pipeline run directory.
    The run_dir_name is URL-decoded automatically by FastAPI.
    """
    logger.info(f"Request to list files for run directory: {run_dir_name}")

    # Validate the path is within RESULTS_DIR
    try:
        target_run_dir = get_safe_path(RESULTS_DIR, run_dir_name)
    except HTTPException as e:
        # Propagate the HTTPException from get_safe_path
        raise e
    except Exception as e:
        logger.error(f"Unexpected error validating path for {run_dir_name}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error during path validation.")


    if not target_run_dir.exists() or not target_run_dir.is_dir():
         logger.warning(f"Requested run directory not found or not a directory: {target_run_dir}")
         raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")

    # Use helper to list ONLY files (and potentially subdirs if needed later)
    # File Browser links aren't needed for inner files
    fb_config = get_filebrowser_config()
    return get_directory_contents(target_run_dir, list_dirs=True, list_files=True, fb_base_url=fb_config["baseURL"])


# --- Jobs List Route ---
# (No changes needed for /jobs_list)
@app.get("/jobs_list", response_model=List[Dict[str, Any]], summary="List All Relevant Jobs")
async def get_jobs_list():
    if not redis_conn or not pipeline_queue:
        raise HTTPException(status_code=503, detail="Service unavailable: Cannot connect to job storage.")
    all_jobs_dict = {}
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
                    "enqueued_at": None, "started_at": None, "ended_at": None,
                    "result": None, "error": None,
                    "meta": {"input_params": details.get("input_filenames", details)}, # Prioritize input_filenames
                    "staged_at": details.get("staged_at")
                }
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as e:
                logger.error(f"Error decoding/parsing staged job data for key {job_id_bytes}: {e}")
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error fetching staged jobs: {e}")

    MAX_REGISTRY_JOBS = 50
    registries = {
        "started": StartedJobRegistry(queue=pipeline_queue),
        "finished": FinishedJobRegistry(queue=pipeline_queue),
        "failed": FailedJobRegistry(queue=pipeline_queue),
    }
    for status_name, registry in registries.items():
        try:
            limit = -1 if status_name == "started" else MAX_REGISTRY_JOBS
            job_ids = registry.get_job_ids(0, limit)
            if job_ids:
                jobs = Job.fetch_many(job_ids, connection=redis_conn, serializer=pipeline_queue.serializer)
                for job in jobs:
                    if job and (job.id not in all_jobs_dict or all_jobs_dict[job.id]['status'] == 'staged'):
                        job.refresh() # Ensure meta is loaded
                        error_summary = None
                        if job.get_status() == JobStatus.FAILED:
                            error_summary = job.meta.get('error_message', "Job failed processing.")
                            if error_summary == "Job failed processing." and job.exc_info:
                                try:
                                    lines = job.exc_info.strip().split('\n')
                                    if lines: error_summary = lines[-1]
                                except Exception: pass

                        all_jobs_dict[job.id] = {
                            "id": job.id, "status": job.get_status(),
                            "description": job.description or "N/A",
                            "enqueued_at": dt_to_timestamp(job.enqueued_at),
                            "started_at": dt_to_timestamp(job.started_at),
                            "ended_at": dt_to_timestamp(job.ended_at),
                            "result": job.result, "error": error_summary,
                            "meta": job.meta or {}, "staged_at": None
                        }
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error fetching {status_name} jobs: {e}")
        except Exception as e:
            logger.exception(f"Unexpected error fetching {status_name} jobs.")

    all_jobs_list = sorted(
        all_jobs_dict.values(),
        key=lambda j: j.get('enqueued_at') or j.get('staged_at') or time.time(),
        reverse=True
    )
    return all_jobs_list


# --- Staging and Job Control Routes ---
# (No changes needed for /run_pipeline, /start_job, /job_status, /stop_job)
@app.post("/run_pipeline", status_code=200, summary="Stage Pipeline Job")
async def stage_pipeline_job(input_data: PipelineInput):
    if not redis_conn:
        raise HTTPException(status_code=503, detail="Service unavailable (Redis).")
    pipeline_script_path = BACKEND_APP_DIR / "pipeline.sh"
    if not pipeline_script_path.is_file():
        raise HTTPException(status_code=500, detail="Server config error: Pipeline script missing.")

    paths_map, known_variants_path_str, validation_errors = validate_pipeline_input(input_data)
    if validation_errors:
        raise HTTPException(status_code=400, detail=f"Input file error(s): {'; '.join(validation_errors)}")

    try:
        staged_job_id = f"staged_{uuid.uuid4()}"
        job_details = {
            "pipeline_script_path": str(pipeline_script_path),
            "forward_reads_path": str(paths_map["forward_reads"]),
            "reverse_reads_path": str(paths_map["reverse_reads"]),
            "reference_genome_path": str(paths_map["reference_genome"]),
            "target_regions_path": str(paths_map["target_regions"]),
            "known_variants_path": known_variants_path_str,
            "description": f"Pipeline for {input_data.forward_reads_file}",
            "staged_at": time.time(),
            "input_filenames": { # Store original inputs
                 "forward_reads": input_data.forward_reads_file,
                 "reverse_reads": input_data.reverse_reads_file,
                 "reference_genome": input_data.reference_genome_file,
                 "target_regions": input_data.target_regions_file,
                 "known_variants": input_data.known_variants_file
            }
        }
        redis_conn.hset(STAGED_JOBS_KEY, staged_job_id, json.dumps(job_details))
        logger.info(f"Staged job {staged_job_id}")
        return JSONResponse(status_code=200, content={"message": "Job staged.", "staged_job_id": staged_job_id})
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error staging job: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not stage job.")
    except Exception as e:
        logger.exception("Failed to stage pipeline job.")
        raise HTTPException(status_code=500, detail="Server error: Could not stage job.")


@app.post("/start_job/{staged_job_id}", status_code=202, summary="Enqueue Staged Job")
async def start_job(staged_job_id: str):
    if not redis_conn or not pipeline_queue:
        raise HTTPException(status_code=503, detail="Background job service unavailable.")
    try:
        job_details_json_bytes = redis_conn.hget(STAGED_JOBS_KEY, staged_job_id)
        if not job_details_json_bytes:
            raise HTTPException(status_code=404, detail=f"Staged job {staged_job_id} not found.")

        job_details = json.loads(job_details_json_bytes.decode('utf-8'))
        required_keys = ["pipeline_script_path", "forward_reads_path", "reverse_reads_path", "reference_genome_path", "target_regions_path"]
        if not all(key in job_details for key in required_keys):
             raise HTTPException(status_code=500, detail="Corrupted staged job data.")

        job_args = (
            job_details["pipeline_script_path"], job_details["forward_reads_path"],
            job_details["reverse_reads_path"], job_details["reference_genome_path"],
            job_details["target_regions_path"], job_details.get("known_variants_path", ""),
        )
        job_meta = {
            "input_params": job_details.get("input_filenames", {}),
            "staged_job_id_origin": staged_job_id
        }
        job = pipeline_queue.enqueue(
            f=run_pipeline_task, args=job_args, meta=job_meta,
            job_id_prefix="bio_pipeline_", job_timeout='2h',
            result_ttl=86400, failure_ttl=604800,
            description=job_details.get("description", f"Run from {staged_job_id}")
        )
        logger.info(f"Enqueued RQ job {job.id} from staged {staged_job_id}")
        redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id)
        logger.info(f"Removed staged job {staged_job_id}.")
        return JSONResponse(status_code=202, content={"message": "Job enqueued.", "job_id": job.id})
    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error starting job {staged_job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable starting job.")
    except json.JSONDecodeError as e:
        logger.error(f"Error decoding JSON for staged job {staged_job_id}: {e}")
        raise HTTPException(status_code=500, detail="Corrupted staged job data.")
    except Exception as e:
        logger.exception(f"Failed to start/enqueue staged job {staged_job_id}.")
        raise HTTPException(status_code=500, detail="Server error: Could not start job.")

@app.get("/job_status/{job_id}", summary="Get RQ Job Status")
async def get_job_status(job_id: str):
    if not redis_conn:
        raise HTTPException(status_code=503, detail="Status check unavailable (Redis).")
    try:
        # Fetch with the correct serializer if needed (often default is fine)
        job = Job.fetch(job_id, connection=redis_conn) # Removed specific serializer arg for simplicity
        job.refresh() # Ensure meta is loaded, especially after task completion
    except NoSuchJobError:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found.")
    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error fetching RQ job {job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to status backend.")
    except Exception as e:
        # Catch potential deserialization errors or other issues
        logger.exception(f"Unexpected error fetching or refreshing job {job_id}.")
        raise HTTPException(status_code=500, detail=f"Server error fetching job status.")

    status = job.get_status()
    result = None
    # --- Get metadata safely ---
    meta_data = job.meta or {}
    error_info_summary = None

    try:
        if status == JobStatus.FINISHED:
            # Result might contain resource info if task returns it, but meta is canonical
            result = job.result
        elif status == JobStatus.FAILED:
            # Prioritize specific error message from meta if task set it
            error_info_summary = meta_data.get('error_message', "Job failed processing.")
            # Add stderr snippet if available
            stderr_snippet = meta_data.get('stderr_snippet')
            if stderr_snippet:
                error_info_summary += f" (stderr: {stderr_snippet}...)"
            # Fallback to exc_info if specific message not set
            if error_info_summary == "Job failed processing." and job.exc_info:
                 try:
                     lines = job.exc_info.strip().split('\n')
                     if lines: error_info_summary = lines[-1] # Get last line of traceback
                 except Exception: pass
    except Exception as e:
        logger.exception(f"Error accessing result/error info for job {job_id} (status: {status}).")
        # Don't overwrite error_info_summary if already set
        if not error_info_summary:
             error_info_summary = "Could not retrieve job result/error details."

    # --- Explicitly include resource stats from meta if they exist ---
    resource_stats = {
        "peak_memory_mb": meta_data.get("peak_memory_mb"),
        "average_cpu_percent": meta_data.get("average_cpu_percent"),
        "duration_seconds": meta_data.get("duration_seconds")
    }

    return JSONResponse(content={
        "job_id": job_id,
        "status": status,
        "result": result, # This might be redundant if info is in meta
        "error": error_info_summary,
        "meta": meta_data, # Include the full meta for potential future use
        "resources": resource_stats, # <-- Add the specific resource stats
        "enqueued_at": dt_to_timestamp(job.enqueued_at),
        "started_at": dt_to_timestamp(job.started_at),
        "ended_at": dt_to_timestamp(job.ended_at)
        })

@app.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued Job")
async def stop_job(job_id: str):
    if not redis_conn:
        raise HTTPException(status_code=503, detail="Service unavailable (Redis).")
    logger.info(f"Request to stop job: {job_id}")
    try:
        job = Job.fetch(job_id, connection=redis_conn)
        status = job.get_status()
        if job.is_finished or job.is_failed or job.is_canceled or job.is_stopped:
             return JSONResponse(status_code=200, content={"message": f"Job already {status}.", "job_id": job_id})

        from rq.command import send_stop_job_command
        message = "Stop signal sent."
        try:
            send_stop_job_command(redis_conn, job.id)
            logger.info(f"Sent stop signal command for job {job_id}.")
        except Exception as sig_err:
            logger.warning(f"Could not send stop signal for job {job_id}. Error: {sig_err}")
            # Fallback? Maybe not necessary if signal sent anyway.
            # job.cancel() # Avoid generic cancel if signal is preferred
            message = "Stop signal attempted (check worker logs)."

        logger.info(f"Stop request processed for job {job_id}.")
        return JSONResponse(status_code=200, content={"message": message, "job_id": job_id})
    except NoSuchJobError:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found.")
    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error interacting with job {job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to job backend.")
    except Exception as e:
        logger.exception(f"Unexpected error stopping job {job_id}.")
        raise HTTPException(status_code=500, detail=f"Server error stopping job.")

