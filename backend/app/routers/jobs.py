# backend/app/routers/jobs.py
import logging
import json
import uuid
import time
import redis # Import redis exceptions
import os # Import os for cleanup
from typing import List, Dict, Any, Optional
from pathlib import Path # Import Path
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

# RQ Imports
from rq import Queue, Worker
from rq.job import Job, JobStatus
from rq.exceptions import NoSuchJobError, InvalidJobOperation
from rq.registry import StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry
from rq.command import send_stop_job_command

# App specific imports
from ..core.config import (
    STAGED_JOBS_KEY, DEFAULT_JOB_TIMEOUT,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL, MAX_REGISTRY_JOBS,
    SAREK_DEFAULT_PROFILE, SAREK_DEFAULT_TOOLS, SAREK_DEFAULT_STEP, SAREK_DEFAULT_ALIGNER,
    RESULTS_DIR
)
from ..core.redis_rq import get_redis_connection, get_pipeline_queue
# Import updated models AND the new JobStatusDetails
from ..models.pipeline import PipelineInput, SampleInfo, JobStatusDetails, JobResourceInfo # <-- ADD JobStatusDetails & JobResourceInfo HERE
# Import updated validation function
from ..utils.validation import validate_pipeline_input
from ..utils.time import dt_to_timestamp
# Import the task function
from ..tasks import run_pipeline_task

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Jobs Management"] # Tag for OpenAPI docs
    # prefix="/api" # Prefix is added in app.py
)

# --- Job Staging and Control Routes ---

@router.post("/run_pipeline", status_code=200, summary="Stage Pipeline Job")
async def stage_pipeline_job(
    input_data: PipelineInput, # Use updated PipelineInput model
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    """
    Validates input, generates samplesheet, and stages a new Sarek pipeline job.
    The job details (including paths and parameters) are stored in Redis hash
    but not yet enqueued for execution.
    Returns a staged job ID that can be used to start the job later.
    """
    logger.info(f"Received staging request for Sarek pipeline with {len(input_data.samples)} samples.")

    # --- Validate Input and Generate Samplesheet ---
    # paths_map contains validated absolute Path objects or None
    paths_map: Dict[str, Optional[Path]]
    validation_errors: List[str]
    paths_map, validation_errors = validate_pipeline_input(input_data)

    # Check if samplesheet CSV was created successfully
    input_csv_path = paths_map.get("input_csv")
    if not input_csv_path and not any("At least one sample" in e for e in validation_errors):
        # If CSV path is missing but not because there were no samples, it indicates a CSV creation error
        if "Internal server error: Could not create samplesheet." not in validation_errors:
             validation_errors.append("Failed to generate samplesheet from provided sample data.")

    # If validation errors exist (including CSV failure), raise HTTP 400
    if validation_errors:
        # If CSV creation failed, clean up the temporary file if it exists
        if input_csv_path and input_csv_path.exists():
             try:
                 os.remove(input_csv_path)
                 logger.info(f"Cleaned up temporary CSV file due to validation errors: {input_csv_path}")
             except OSError as e:
                 logger.warning(f"Could not clean up temporary CSV file {input_csv_path}: {e}")

        error_message = "Validation errors:\n" + "\n".join(f"- {error}" for error in validation_errors)
        logger.warning(f"Validation errors staging job: {error_message}")
        raise HTTPException(status_code=400, detail=error_message)

    # Ensure input_csv_path is definitely a Path object if validation passed
    if not isinstance(input_csv_path, Path):
         # This case should ideally not happen if validation passes, but as a safeguard:
         logger.error("Validation passed but input_csv_path is not a Path object. Aborting staging.")
         raise HTTPException(status_code=500, detail="Internal server error during job staging preparation.")

    logger.info(f"Input validation successful. Samplesheet: {input_csv_path}")

    # --- Prepare Job Details for Staging ---
    try:
        staged_job_id = f"staged_{uuid.uuid4()}"

        # Store original filenames provided by the user for display/metadata
        input_filenames = {
            "intervals_file": input_data.intervals_file,
            "dbsnp": input_data.dbsnp,
            "known_indels": input_data.known_indels,
            "pon": input_data.pon
        }

        # Store sample information as provided by the user
        sample_info_list = [s.model_dump() for s in input_data.samples] # Use model_dump for Pydantic v2

        # Store absolute paths (as strings) and parameters needed for the task execution
        job_details = {
            # --- Paths ---
            "input_csv_path": str(input_csv_path), # Validated CSV path
            "intervals_path": str(paths_map["intervals"]) if paths_map.get("intervals") else None,
            "dbsnp_path": str(paths_map["dbsnp"]) if paths_map.get("dbsnp") else None,
            "known_indels_path": str(paths_map["known_indels"]) if paths_map.get("known_indels") else None,
            "pon_path": str(paths_map["pon"]) if paths_map.get("pon") else None,
            "outdir_base_path": str(RESULTS_DIR), # Base directory for results

            # --- Sarek Parameters ---
            "genome": input_data.genome,
            "tools": input_data.tools or SAREK_DEFAULT_TOOLS, # Use default if not provided
            "step": input_data.step or SAREK_DEFAULT_STEP,
            "profile": input_data.profile or SAREK_DEFAULT_PROFILE,
            "aligner": input_data.aligner or SAREK_DEFAULT_ALIGNER, # Use default if not provided

            # --- Sarek Flags ---
            "joint_germline": input_data.joint_germline or False,
            "wes": input_data.wes or False,
            "trim_fastq": input_data.trim_fastq or False,
            "skip_qc": input_data.skip_qc or False,
            "skip_annotation": input_data.skip_annotation or False,

            # --- Metadata ---
            "description": input_data.description or f"Sarek run ({len(input_data.samples)} samples, Genome: {input_data.genome})",
            "staged_at": time.time(),
            "input_filenames": input_filenames, # Original filenames from user input
            "sample_info": sample_info_list # Sample details from user input
        }

        # Store as bytes in Redis hash
        redis_conn.hset(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'), json.dumps(job_details).encode('utf-8'))
        logger.info(f"Staged Sarek job '{staged_job_id}' with {len(input_data.samples)} samples.")

        return JSONResponse(status_code=200, content={"message": "Job staged successfully.", "staged_job_id": staged_job_id})

    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error staging job: {e}")
        # Clean up temporary CSV if staging fails after validation
        if input_csv_path and input_csv_path.exists():
             try:
                 os.remove(input_csv_path)
                 logger.info(f"Cleaned up temporary CSV file due to Redis error: {input_csv_path}")
             except OSError as remove_e:
                 logger.warning(f"Could not clean up temporary CSV file {input_csv_path} after Redis error: {remove_e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not stage job due to storage error.")
    except Exception as e:
         logger.exception(f"Unexpected error during job staging for input: {input_data}")
         # Clean up temporary CSV on any unexpected error
         if input_csv_path and input_csv_path.exists():
             try:
                 os.remove(input_csv_path)
                 logger.info(f"Cleaned up temporary CSV file due to unexpected error: {input_csv_path}")
             except OSError as remove_e:
                 logger.warning(f"Could not clean up temporary CSV file {input_csv_path} after error: {remove_e}")
         raise HTTPException(status_code=500, detail="Internal server error during job staging.")


@router.post("/start_job/{staged_job_id}", status_code=202, summary="Enqueue Staged Job")
async def start_job(
    staged_job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    """
    Retrieves staged job details from Redis, enqueues it to RQ for execution
    via run_pipeline_task, and removes the staged entry upon success.
    Returns 202 Accepted with the new RQ job ID.
    """
    logger.info(f"Attempting to start job from staged ID: {staged_job_id}")
    job_details = None # Initialize job_details
    try:
        # Fetch the staged job details (bytes)
        job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'))
        if not job_details_bytes:
            logger.warning(f"Start job request failed: Staged job ID '{staged_job_id}' not found.")
            raise HTTPException(status_code=404, detail=f"Staged job '{staged_job_id}' not found.")

        try:
            job_details = json.loads(job_details_bytes.decode('utf-8'))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            logger.error(f"Corrupted staged job data for {staged_job_id}: {e}. Removing entry.")
            redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8')) # Attempt cleanup
            raise HTTPException(status_code=500, detail="Corrupted staged job data found. Please try staging again.")

        # --- Validate required keys in fetched details ---
        required_keys = [
            "input_csv_path", "outdir_base_path", "genome", "tools",
            "step", "profile", "aligner" # Add aligner
            # Boolean flags are optional in the task signature, defaults handled there
        ]
        if not all(key in job_details for key in required_keys):
            missing_keys = [key for key in required_keys if key not in job_details]
            logger.error(f"Corrupted staged job data for {staged_job_id}: Missing required keys: {missing_keys}. Data: {job_details}")
            redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8')) # Attempt cleanup
            raise HTTPException(status_code=500, detail="Incomplete staged job data found. Please try staging again.")

        # --- Prepare arguments for the RQ task (run_pipeline_task) ---
        # Ensure the order matches the task function's signature definition
        job_args = (
            job_details["input_csv_path"],
            job_details["outdir_base_path"],
            job_details["genome"],
            job_details["tools"],
            job_details["step"],
            job_details["profile"],
            job_details.get("intervals_path"), # Optional
            job_details.get("dbsnp_path"),     # Optional
            job_details.get("known_indels_path"), # Optional
            job_details.get("pon_path"),        # Optional
            job_details.get("aligner"),         # Optional (but required key checked above)
            job_details.get("joint_germline", False), # Optional
            job_details.get("wes", False),            # Optional
            job_details.get("trim_fastq", False),     # Optional
            job_details.get("skip_qc", False),        # Optional
            job_details.get("skip_annotation", False) # Optional
        )

        # --- Prepare Metadata for the RQ Job ---
        # Include parameters and sample info for easier retrieval later
        job_meta = {
            "input_params": job_details.get("input_filenames", {}), # Original user filenames
            "sarek_params": { # Store actual Sarek params used
                 "genome": job_details["genome"],
                 "tools": job_details["tools"],
                 "step": job_details["step"],
                 "profile": job_details["profile"],
                 "aligner": job_details["aligner"],
                 "joint_germline": job_details.get("joint_germline", False),
                 "wes": job_details.get("wes", False),
                 "trim_fastq": job_details.get("trim_fastq", False),
                 "skip_qc": job_details.get("skip_qc", False),
                 "skip_annotation": job_details.get("skip_annotation", False),
            },
            "sample_info": job_details.get("sample_info", []), # User-provided sample info
            "staged_job_id_origin": staged_job_id,
            # Task will add resource usage, errors, results path later
        }
        job_description = job_details.get("description", f"Sarek run ({len(job_details.get('sample_info', []))} samples)")

        # Enqueue the job to RQ
        job = queue.enqueue(
            f=run_pipeline_task,
            args=job_args,
            meta=job_meta,
            job_id_prefix="sarek_", # Keep prefix
            job_timeout=DEFAULT_JOB_TIMEOUT,
            result_ttl=DEFAULT_RESULT_TTL,
            failure_ttl=DEFAULT_FAILURE_TTL,
            description=job_description
        )
        logger.info(f"Successfully enqueued RQ job {job.id} from staged job {staged_job_id}")

        # --- Remove the staged job entry AFTER successful enqueueing ---
        try:
            delete_count = redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'))
            if delete_count == 1:
                logger.info(f"Removed staged job entry {staged_job_id} after enqueueing.")
            else:
                 logger.warning(f"Staged job entry {staged_job_id} was not found for removal after enqueueing (perhaps removed concurrently?).")
        except redis.exceptions.RedisError as del_e:
            # Log error but don't fail the request, job is already enqueued
            logger.error(f"Failed to remove staged job entry {staged_job_id} after enqueueing: {del_e}")

        return JSONResponse(status_code=202, content={"message": "Job successfully enqueued.", "job_id": job.id})

    except HTTPException as e:
        # Re-raise HTTP exceptions (e.g., 404, 500 from checks)
        # Clean up CSV if start fails after validation but before enqueueing
        if job_details and job_details.get("input_csv_path"):
            csv_path = Path(job_details["input_csv_path"])
            if csv_path.exists():
                try:
                    os.remove(csv_path)
                    logger.info(f"Cleaned up temporary CSV file due to start_job error: {csv_path}")
                except OSError as remove_e:
                    logger.warning(f"Could not clean up temporary CSV file {csv_path} after start_job error: {remove_e}")
        raise e
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error during start job process for {staged_job_id}: {e}")
         # Clean up CSV if Redis fails
        if job_details and job_details.get("input_csv_path"):
            csv_path = Path(job_details["input_csv_path"])
            if csv_path.exists():
                try:
                    os.remove(csv_path)
                    logger.info(f"Cleaned up temporary CSV file due to Redis error: {csv_path}")
                except OSError as remove_e:
                    logger.warning(f"Could not clean up temporary CSV file {csv_path} after Redis error: {remove_e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not access job storage.")
    except Exception as e:
        logger.exception(f"Unexpected error starting/enqueuing staged job {staged_job_id}.")
        # Clean up CSV on any unexpected error
        if job_details and job_details.get("input_csv_path"):
            csv_path = Path(job_details["input_csv_path"])
            if csv_path.exists():
                try:
                    os.remove(csv_path)
                    logger.info(f"Cleaned up temporary CSV file due to unexpected error: {csv_path}")
                except OSError as remove_e:
                    logger.warning(f"Could not clean up temporary CSV file {csv_path} after error: {remove_e}")
        raise HTTPException(status_code=500, detail="Internal server error: Could not start job.")


# --- Job Listing and Status Routes ---

@router.get("/jobs_list", response_model=List[Dict[str, Any]], summary="List All Relevant Jobs (Staged & RQ)")
async def get_jobs_list(
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue) # Need queue for serializer info
):
    """
    Fetches and combines jobs from the staging area (Redis Hash) and
    various RQ registries (queued, started, finished, failed).
    Returns a list sorted by enqueue/stage time descending (newest first).
    """
    all_jobs_dict = {}

    # 1. Get Staged Jobs from Redis Hash
    try:
        staged_jobs_raw = redis_conn.hgetall(STAGED_JOBS_KEY)
        for job_id_bytes, job_details_bytes in staged_jobs_raw.items():
            try:
                job_id = job_id_bytes.decode('utf-8')
                details = json.loads(job_details_bytes.decode('utf-8'))
                # Construct a dictionary similar to RQ job structure for consistency
                # Extract relevant info for display from staged details
                staged_meta = {
                    "input_params": details.get("input_filenames", {}), # Original user filenames
                    "sarek_params": { # Store actual Sarek params used
                         "genome": details.get("genome"),
                         "tools": details.get("tools"),
                         "step": details.get("step"),
                         "profile": details.get("profile"),
                         "aligner": details.get("aligner"),
                         "joint_germline": details.get("joint_germline", False),
                         "wes": details.get("wes", False),
                         "trim_fastq": details.get("trim_fastq", False),
                         "skip_qc": details.get("skip_qc", False),
                         "skip_annotation": details.get("skip_annotation", False),
                    },
                    "sample_info": details.get("sample_info", []),
                    "staged_job_id_origin": job_id # Link back to self
                }
                all_jobs_dict[job_id] = {
                    "id": job_id,
                    "status": "staged",
                    "description": details.get("description", f"Staged: {job_id[:8]}..."),
                    "enqueued_at": None,
                    "started_at": None,
                    "ended_at": None,
                    "result": None,
                    "error": None,
                    "meta": staged_meta, # Use constructed meta
                    "staged_at": details.get("staged_at"),
                    "resources": None
                }
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as e:
                logger.error(f"Error decoding/parsing staged job data for key {job_id_bytes}: {e}. Skipping entry.")
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error fetching staged jobs from '{STAGED_JOBS_KEY}': {e}")
        # Decide if this is critical - perhaps return 503 or just log and continue?
        # raise HTTPException(status_code=503, detail="Failed to retrieve staged jobs list from storage.")

    # 2. Get RQ Jobs from Relevant Registries
    registries_to_check = {
        "queued": queue,
        "started": StartedJobRegistry(queue=queue),
        "finished": FinishedJobRegistry(queue=queue),
        "failed": FailedJobRegistry(queue=queue),
    }

    rq_job_ids_to_fetch = set()
    for status_name, registry_or_queue in registries_to_check.items():
        try:
            job_ids = []
            limit = MAX_REGISTRY_JOBS if status_name in ["finished", "failed"] else -1 # Limit history
            if isinstance(registry_or_queue, Queue):
                job_ids = registry_or_queue.get_job_ids()
            elif isinstance(registry_or_queue, (StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry)):
                job_ids = registry_or_queue.get_job_ids(0, limit -1 if limit > 0 else limit)
            else:
                 logger.warning(f"Unsupported type for job fetching: {type(registry_or_queue)}")
                 continue
            if job_ids:
                 rq_job_ids_to_fetch.update(job_ids)
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error fetching job IDs from {status_name} registry/queue: {e}")
        except Exception as e:
            logger.exception(f"Unexpected error fetching job IDs from {status_name} registry/queue.")

    # Fetch all unique RQ job IDs found across registries
    if rq_job_ids_to_fetch:
        try:
            # Ensure connection uses decode_responses=False for fetch_many
            redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
                                           port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
                                           db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
                                           decode_responses=False) # Explicitly False for RQ fetch

            fetched_jobs = Job.fetch_many(list(rq_job_ids_to_fetch), connection=redis_conn_bytes, serializer=queue.serializer)

            for job in fetched_jobs:
                if job: # fetch_many can return None for missing jobs
                    job.refresh() # Ensure meta and latest status are loaded
                    current_status = job.get_status(refresh=False)
                    error_summary = None
                    job_meta = job.meta or {} # Ensure meta is a dict

                    if current_status == JobStatus.FAILED:
                         error_summary = job_meta.get('error_message', "Job failed processing")
                         stderr_snippet = job_meta.get('stderr_snippet')
                         if error_summary == "Job failed processing" and job.exc_info:
                             try: error_summary = job.exc_info.strip().split('\n')[-1]
                             except Exception: pass
                         if stderr_snippet: error_summary += f" (stderr: {stderr_snippet}...)"

                    # Extract resource stats from meta for top-level access
                    # Ensure meta keys exist before accessing
                    resources = {
                        "peak_memory_mb": job_meta.get("peak_memory_mb"),
                        "average_cpu_percent": job_meta.get("average_cpu_percent"),
                        "duration_seconds": job_meta.get("duration_seconds")
                    }

                    # Don't overwrite a final state job with an earlier one if IDs clash
                    if job.id not in all_jobs_dict or all_jobs_dict[job.id]['status'] == 'staged':
                         all_jobs_dict[job.id] = {
                            "id": job.id,
                            "status": current_status,
                            "description": job.description or f"RQ job {job.id[:12]}...",
                            "enqueued_at": dt_to_timestamp(job.enqueued_at),
                            "started_at": dt_to_timestamp(job.started_at),
                            "ended_at": dt_to_timestamp(job.ended_at),
                            "result": job.result,
                            "error": error_summary,
                            "meta": job_meta, # Full meta, including input_params, sample_info etc.
                            "staged_at": None,
                            "resources": resources # Include extracted resources
                        }
        except redis.exceptions.RedisError as e:
             logger.error(f"Redis error during Job.fetch_many: {e}")
             raise HTTPException(status_code=503, detail="Failed to retrieve job details from storage.")
        except Exception as e:
            logger.exception("Unexpected error fetching RQ job details.")
            raise HTTPException(status_code=500, detail="Internal server error fetching job details.")


    # 3. Sort the Combined List by time (staged or enqueued) descending
    try:
        all_jobs_list = sorted(
            all_jobs_dict.values(),
            key=lambda j: j.get('staged_at') or j.get('enqueued_at') or 0,
            reverse=True
        )
    except Exception as e:
        logger.exception("Error sorting combined jobs list.")
        all_jobs_list = list(all_jobs_dict.values()) # Fallback to unsorted

    return all_jobs_list


@router.get("/job_status/{job_id}", response_model=JobStatusDetails, summary="Get RQ Job Status and Details")
async def get_job_status(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue) # Need queue for serializer
):
    """
    Fetches the status, result/error, metadata, and resource usage for a specific RQ job ID.
    Handles cases where the job might not be found in RQ.
    """
    logger.debug(f"Fetching status for RQ job ID: {job_id}")
    try:
        # Ensure connection uses decode_responses=False for fetch
        redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
                                       port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
                                       db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
                                       decode_responses=False) # Explicitly False for RQ fetch
        job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
        job.refresh()
    except NoSuchJobError:
        logger.warning(f"Job status request failed: RQ job ID '{job_id}' not found.")
        # Check if it's a staged job ID (using the main redis_conn which decodes responses)
        try:
             # Use bytes for hexists check as well since key is bytes
             if job_id.startswith("staged_") and redis_conn.hexists(STAGED_JOBS_KEY.encode('utf-8'), job_id.encode('utf-8')):
                  logger.info(f"Job ID {job_id} corresponds to a currently staged job.")
                  raise HTTPException(status_code=404, detail=f"Job '{job_id}' is staged but not running.")
             else:
                  raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found in active queues or recent history.")
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error checking staged status for {job_id}: {e}")
            raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found (storage check failed).")

    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error fetching RQ job {job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to status backend.")
    except Exception as e:
        logger.exception(f"Unexpected error fetching or refreshing job {job_id}.")
        raise HTTPException(status_code=500, detail="Internal server error fetching job status.")

    # Process the fetched job data
    status = job.get_status(refresh=False)
    result = None
    meta_data = job.meta or {}
    error_info_summary = None

    try:
        if status == JobStatus.FINISHED:
            result = job.result
        elif status == JobStatus.FAILED:
            error_info_summary = meta_data.get('error_message', "Job failed processing")
            stderr_snippet = meta_data.get('stderr_snippet')
            if error_info_summary == "Job failed processing" and job.exc_info:
                 try: error_info_summary = job.exc_info.strip().split('\n')[-1]
                 except Exception: pass
            if stderr_snippet: error_info_summary += f" (stderr: {stderr_snippet}...)"
    except Exception as e:
        logger.exception(f"Error accessing result/error info for job {job_id} (status: {status}).")
        error_info_summary = error_info_summary or "Could not retrieve job result/error details."

    # Extract resource stats from meta
    resource_stats = {
        "peak_memory_mb": meta_data.get("peak_memory_mb"),
        "average_cpu_percent": meta_data.get("average_cpu_percent"),
        "duration_seconds": meta_data.get("duration_seconds")
    }

    # Return the JobStatusDetails structure
    return JobStatusDetails(
        job_id=job.id, # Use 'job_id' key as defined in the response model
        status=status,
        description=job.description,
        enqueued_at=dt_to_timestamp(job.enqueued_at),
        started_at=dt_to_timestamp(job.started_at),
        ended_at=dt_to_timestamp(job.ended_at),
        result=result,
        error=error_info_summary,
        meta=meta_data,
        resources=JobResourceInfo(**resource_stats) # Create JobResourceInfo instance
    )


@router.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued RQ Job")
async def stop_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection) # Needs bytes connection for send_stop_job_command
):
    """
    Sends a stop signal to a specific RQ job if it's running or queued.
    """
    logger.info(f"Received request to stop RQ job: {job_id}")
    try:
         # Use bytes connection for fetching and sending command
        redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
                                       port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
                                       db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
                                       decode_responses=False) # Explicitly False

        job = Job.fetch(job_id, connection=redis_conn_bytes)
        status = job.get_status(refresh=True)

        if job.is_finished or job.is_failed or job.is_stopped or job.is_canceled:
            logger.warning(f"Attempted to stop job {job_id} which is already in state: {status}")
            return JSONResponse(status_code=200, content={"message": f"Job already in terminal state: {status}.", "job_id": job_id})

        logger.info(f"Job {job_id} is in state {status}. Attempting to send stop signal.")
        message = f"Stop signal sent to job {job_id}."
        try:
            send_stop_job_command(redis_conn_bytes, job.id) # Use bytes connection
            logger.info(f"Successfully sent stop signal command via RQ for job {job_id}.")
        except Exception as sig_err:
            logger.warning(f"Could not send stop signal command via RQ for job {job_id}. Worker may not stop immediately. Error: {sig_err}")
            message = f"Stop signal attempted for job {job_id} (check worker logs)."

        return JSONResponse(status_code=200, content={"message": message, "job_id": job_id})

    except NoSuchJobError:
        logger.warning(f"Stop job request failed: Job ID '{job_id}' not found.")
        raise HTTPException(status_code=404, detail=f"Cannot stop job: Job '{job_id}' not found.")
    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error interacting with job {job_id} for stopping: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to job backend.")
    except Exception as e:
        logger.exception(f"Unexpected error stopping job {job_id}.")
        raise HTTPException(status_code=500, detail="Internal server error attempting to stop job.")


@router.delete("/remove_job/{job_id}", status_code=200, summary="Remove Staged or RQ Job Data")
async def remove_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue) # Needed for RQ job fetching/deleting
):
    """
    Removes a job's data from Redis. Handles both 'staged_*' IDs and RQ job IDs.
    """
    logger.info(f"Request received to remove job/data for ID: {job_id}")

    # --- Case 1: Handle Staged Jobs ---
    if job_id.startswith("staged_"):
        logger.info(f"Attempting to remove staged job '{job_id}' from hash '{STAGED_JOBS_KEY}'.")
        try:
            # Fetch details first to get CSV path for cleanup
            job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id.encode('utf-8'))
            csv_path_to_remove = None
            if job_details_bytes:
                try:
                    details = json.loads(job_details_bytes.decode('utf-8'))
                    csv_path_to_remove = details.get("input_csv_path")
                except (json.JSONDecodeError, UnicodeDecodeError):
                     logger.warning(f"Could not parse details for staged job {job_id} during removal, cannot clean up CSV.")

            # Remove from Redis hash
            num_deleted = redis_conn.hdel(STAGED_JOBS_KEY, job_id.encode('utf-8'))

            if num_deleted == 1:
                logger.info(f"Successfully removed staged job entry: {job_id}")
                # Clean up associated temporary CSV file
                if csv_path_to_remove:
                    try:
                        csv_path = Path(csv_path_to_remove)
                        if csv_path.exists() and csv_path.is_file() and csv_path.suffix == '.csv':
                             os.remove(csv_path)
                             logger.info(f"Cleaned up temporary CSV file for removed staged job: {csv_path}")
                        else:
                             logger.warning(f"Temporary CSV path {csv_path} not found or invalid for removal.")
                    except OSError as e:
                        logger.warning(f"Could not clean up temporary CSV file {csv_path_to_remove}: {e}")

                return JSONResponse(status_code=200, content={"message": f"Staged job '{job_id}' removed.", "removed_id": job_id})
            else:
                logger.warning(f"Staged job '{job_id}' not found in hash for removal.")
                raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found.")

        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error removing staged job {job_id}: {e}")
            raise HTTPException(status_code=503, detail="Service unavailable: Could not remove job due to storage error.")
        except HTTPException as e:
            raise e # Re-raise the 404
        except Exception as e:
            logger.exception(f"Unexpected error removing staged job {job_id}.")
            raise HTTPException(status_code=500, detail="Internal server error removing staged job.")

    # --- Case 2: Handle RQ Jobs ---
    else:
        logger.info(f"Attempting to remove RQ job '{job_id}' data.")
        try:
            # Use bytes connection for fetch/delete
            redis_conn_bytes = redis.Redis(
                host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
                port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
                db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
                decode_responses=False,
                socket_timeout=5,  # Add timeout
                socket_connect_timeout=5  # Add connect timeout
            )
            
            # First check if job exists and get its status
            try:
                job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
            except NoSuchJobError:
                logger.warning(f"RQ Job '{job_id}' not found for removal.")
                raise HTTPException(status_code=404, detail=f"RQ Job '{job_id}' not found.")
            except Exception as fetch_err:
                logger.error(f"Error fetching job {job_id}: {fetch_err}")
                raise HTTPException(status_code=500, detail=f"Could not fetch job {job_id} for removal")

            if not job:
                raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
                
            # Get job status
            try:
                job_status = job.get_status()
            except Exception as status_err:
                logger.error(f"Error getting status for job {job_id}: {status_err}")
                job_status = None
            
            # If job is running, try to stop it first
            if job_status == 'started':
                try:
                    send_stop_job_command(redis_conn_bytes, job.id)
                    logger.info(f"Sent stop signal to running job {job_id} before removal")
                    # Wait a bit for the job to stop
                    time.sleep(1)
                except Exception as stop_err:
                    logger.warning(f"Could not stop running job {job_id} before removal: {stop_err}")

            # Get CSV path from meta *before* deleting if possible
            try:
                csv_path_to_remove = job.meta.get("input_csv_path") if job.meta else None
            except Exception as meta_err:
                logger.warning(f"Could not get CSV path from job meta: {meta_err}")
                csv_path_to_remove = None

            # Delete the job using the correct method for this RQ version
            try:
                # First remove from registries
                for registry in [StartedJobRegistry(queue=queue), 
                               FinishedJobRegistry(queue=queue), 
                               FailedJobRegistry(queue=queue)]:
                    try:
                        registry.remove(job)
                    except Exception as reg_err:
                        logger.warning(f"Error removing job {job_id} from registry: {reg_err}")

                # Then delete the job itself
                job.delete()
                logger.info(f"Successfully removed RQ job {job_id}")
            except Exception as delete_err:
                logger.error(f"Error deleting job {job_id}: {delete_err}")
                raise HTTPException(status_code=500, detail=f"Could not delete job {job_id}")

            # Clean up CSV file if it exists
            if csv_path_to_remove and os.path.exists(csv_path_to_remove):
                try:
                    os.remove(csv_path_to_remove)
                    logger.info(f"Removed associated CSV file: {csv_path_to_remove}")
                except Exception as csv_err:
                    logger.warning(f"Could not remove CSV file {csv_path_to_remove}: {csv_err}")

            return JSONResponse(status_code=200, content={"message": f"Successfully removed job {job_id}"})

        except HTTPException as e:
            raise e
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error removing RQ job {job_id}: {e}")
            raise HTTPException(status_code=503, detail="Service unavailable: Could not remove RQ job due to storage error.")
        except InvalidJobOperation as e:
            logger.warning(f"Invalid operation trying to remove RQ job {job_id} (possibly running?): {e}")
            raise HTTPException(status_code=409, detail=f"Cannot remove job '{job_id}': Invalid operation (job might be active or locked).")
        except Exception as e:
            logger.exception(f"Unexpected error removing RQ job {job_id}: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Internal server error removing RQ job: {str(e)}")


# --- ADD /rerun_job endpoint ---
@router.post("/rerun_job/{job_id}", status_code=200, summary="Re-stage Job")
async def rerun_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue) # Needed for fetching RQ job details
):
    """
    Retrieves parameters from a previously staged or completed/failed RQ job
    and creates a new staged job entry using those parameters.
    Returns the new staged job ID.
    """
    logger.info(f"Re-staging request received for job ID: {job_id}")
    original_job_details = {}
    is_staged_origin = job_id.startswith("staged_")

    try:
        # --- Fetch Original Job Details ---
        if is_staged_origin:
            # Fetch from staged jobs hash
            details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id.encode('utf-8'))
            if not details_bytes:
                raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found to rerun.")
            original_job_details = json.loads(details_bytes.decode('utf-8'))
            logger.info(f"Found original details in staged job hash for {job_id}")
        else:
            # Fetch from RQ job metadata
            try:
                redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
                                               port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
                                               db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
                                               decode_responses=False)
                job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
                job.refresh() # Load meta
                if not job.meta:
                     raise HTTPException(status_code=404, detail=f"RQ job '{job_id}' found, but has no metadata to rerun.")
                # Reconstruct details from meta (might need adjustments based on what's stored)
                original_job_details = {
                    "input_filenames": job.meta.get("input_params", {}),
                    "sample_info": job.meta.get("sample_info", []),
                    "genome": job.meta.get("sarek_params", {}).get("genome"),
                    "tools": job.meta.get("sarek_params", {}).get("tools"),
                    "step": job.meta.get("sarek_params", {}).get("step"),
                    "profile": job.meta.get("sarek_params", {}).get("profile"),
                    "aligner": job.meta.get("sarek_params", {}).get("aligner"),
                    "joint_germline": job.meta.get("sarek_params", {}).get("joint_germline"),
                    "wes": job.meta.get("sarek_params", {}).get("wes"),
                    "trim_fastq": job.meta.get("sarek_params", {}).get("trim_fastq"),
                    "skip_qc": job.meta.get("sarek_params", {}).get("skip_qc"),
                    "skip_annotation": job.meta.get("sarek_params", {}).get("skip_annotation"),
                    "description": f"Rerun of {job_id} - {job.description or ''}".strip(),
                    # We need the original *relative* file paths for validation
                    "intervals_file": job.meta.get("input_params", {}).get("intervals_file"), # Corrected key
                    "dbsnp": job.meta.get("input_params", {}).get("dbsnp"),
                    "known_indels": job.meta.get("input_params", {}).get("known_indels"),
                    "pon": job.meta.get("input_params", {}).get("pon"),
                }
                 # Basic check for essential info
                if not original_job_details.get("genome") or not original_job_details.get("sample_info"):
                    raise HTTPException(status_code=400, detail=f"Incomplete metadata for RQ job '{job_id}'. Cannot determine essential parameters (genome, samples) for rerun.")
                logger.info(f"Reconstructed details from RQ job meta for {job_id}")

            except NoSuchJobError:
                 raise HTTPException(status_code=404, detail=f"RQ job '{job_id}' not found to rerun.")

        # --- Create PipelineInput for Validation ---
        # Map the fetched details back to a Pydantic model instance
        try:
            pipeline_input_for_validation = PipelineInput(
                samples=[SampleInfo(**s) for s in original_job_details.get("sample_info", [])],
                genome=original_job_details.get("genome", ""), # Must have genome
                intervals_file=original_job_details.get("intervals_file"),
                dbsnp=original_job_details.get("dbsnp"),
                known_indels=original_job_details.get("known_indels"),
                pon=original_job_details.get("pon"),
                tools=original_job_details.get("tools"),
                step=original_job_details.get("step"),
                profile=original_job_details.get("profile"),
                aligner=original_job_details.get("aligner"),
                joint_germline=original_job_details.get("joint_germline", False),
                wes=original_job_details.get("wes", False),
                trim_fastq=original_job_details.get("trim_fastq", False),
                skip_qc=original_job_details.get("skip_qc", False),
                skip_annotation=original_job_details.get("skip_annotation", False),
                description=f"Rerun of {job_id}" # Generate new description
            )
        except Exception as model_error:
             logger.error(f"Error creating PipelineInput model from fetched details for {job_id}: {model_error}")
             raise HTTPException(status_code=500, detail="Could not reconstruct job parameters for rerun.")

        # --- Re-validate and Stage ---
        # Call the same staging logic as /run_pipeline
        return await stage_pipeline_job(pipeline_input_for_validation, redis_conn)

    except HTTPException as e:
        raise e # Re-raise validation or not found errors
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error during rerun process for {job_id}: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not access job storage for rerun.")
    except Exception as e:
        logger.exception(f"Unexpected error re-staging job {job_id}.")
        raise HTTPException(status_code=500, detail="Internal server error attempting to re-stage job.")
