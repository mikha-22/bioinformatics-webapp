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
    paths_map: Dict[str, Optional[Path]]
    validation_errors: List[str]
    # Use the reverted validation function that writes host paths to CSV
    # This now includes the lane field
    paths_map, validation_errors = validate_pipeline_input(input_data)

    input_csv_path = paths_map.get("input_csv")
    if not input_csv_path and not any("At least one sample" in e for e in validation_errors):
        if "Internal server error: Could not create samplesheet." not in validation_errors:
             validation_errors.append("Failed to generate samplesheet from provided sample data.")

    if validation_errors:
        if input_csv_path and input_csv_path.exists():
             try:
                 os.remove(input_csv_path)
                 logger.info(f"Cleaned up temporary CSV file due to validation errors: {input_csv_path}")
             except OSError as e:
                 logger.warning(f"Could not clean up temporary CSV file {input_csv_path}: {e}")
        error_message = "Validation errors:\n" + "\n".join(f"- {error}" for error in validation_errors)
        logger.warning(f"Validation errors staging job: {error_message}")
        raise HTTPException(status_code=400, detail=error_message)

    if not isinstance(input_csv_path, Path):
         logger.error("Validation passed but input_csv_path is not a Path object. Aborting staging.")
         raise HTTPException(status_code=500, detail="Internal server error during job staging preparation.")

    logger.info(f"Input validation successful. Samplesheet: {input_csv_path}")

    # --- Prepare Job Details for Staging ---
    try:
        staged_job_id = f"staged_{uuid.uuid4()}"

        input_filenames = {
            "intervals_file": input_data.intervals_file,
            "dbsnp": input_data.dbsnp,
            "known_indels": input_data.known_indels,
            "pon": input_data.pon
        }
        # Include lane in the sample info being stored
        sample_info_list = [s.model_dump() for s in input_data.samples]

        # Convert tools list to comma-separated string for storage in Redis
        tools_str = ",".join(input_data.tools) if input_data.tools else None

        # Store absolute HOST paths (as strings) and parameters needed for the task execution
        # These paths come directly from paths_map which contains validated host paths now
        job_details = {
            # --- Paths ---
            "input_csv_path": str(input_csv_path), # Validated CSV path (temp file on host)
            "intervals_path": str(paths_map["intervals"]) if paths_map.get("intervals") else None,
            "dbsnp_path": str(paths_map["dbsnp"]) if paths_map.get("dbsnp") else None,
            "known_indels_path": str(paths_map["known_indels"]) if paths_map.get("known_indels") else None,
            "pon_path": str(paths_map["pon"]) if paths_map.get("pon") else None,
            "outdir_base_path": str(RESULTS_DIR), # Base directory for results (host path)

            # --- Sarek Parameters ---
            "genome": input_data.genome,
            # *** Store the comma-separated string ***
            "tools": tools_str,
            # *****************************************
            # Use defaults only if the user didn't provide a value
            "step": input_data.step if input_data.step is not None else SAREK_DEFAULT_STEP,
            "profile": input_data.profile if input_data.profile is not None else SAREK_DEFAULT_PROFILE,
            "aligner": input_data.aligner if input_data.aligner is not None else SAREK_DEFAULT_ALIGNER,

            # --- Sarek Flags ---
            "joint_germline": input_data.joint_germline or False,
            "wes": input_data.wes or False,
            "trim_fastq": input_data.trim_fastq or False,
            "skip_qc": input_data.skip_qc or False,
            "skip_annotation": input_data.skip_annotation or False,
            "skip_baserecalibrator": input_data.skip_baserecalibrator or False,

            # --- Metadata ---
            "description": input_data.description or f"Sarek run ({len(input_data.samples)} samples, Genome: {input_data.genome})",
            "staged_at": time.time(),
            "input_filenames": input_filenames, # Original relative filenames from user input
            "sample_info": sample_info_list # Sample details from user input (now includes lane)
        }

        redis_conn.hset(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'), json.dumps(job_details).encode('utf-8'))
        logger.info(f"Staged Sarek job '{staged_job_id}' with {len(input_data.samples)} samples.")

        return JSONResponse(status_code=200, content={"message": "Job staged successfully.", "staged_job_id": staged_job_id})

    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error staging job: {e}")
        if input_csv_path and input_csv_path.exists():
             try:
                 os.remove(input_csv_path)
                 logger.info(f"Cleaned up temporary CSV file due to Redis error: {input_csv_path}")
             except OSError as remove_e:
                 logger.warning(f"Could not clean up temporary CSV file {input_csv_path} after Redis error: {remove_e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not stage job due to storage error.")
    except Exception as e:
         logger.exception(f"Unexpected error during job staging for input: {input_data}")
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
    job_details = None
    try:
        job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'))
        if not job_details_bytes:
            logger.warning(f"Start job request failed: Staged job ID '{staged_job_id}' not found.")
            raise HTTPException(status_code=404, detail=f"Staged job '{staged_job_id}' not found.")

        try:
            job_details = json.loads(job_details_bytes.decode('utf-8'))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            logger.error(f"Corrupted staged job data for {staged_job_id}: {e}. Removing entry.")
            redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'))
            raise HTTPException(status_code=500, detail="Corrupted staged job data found. Please try staging again.")

        # --- Validate required keys (use defaults if needed during enqueue) ---
        required_base_keys = ["input_csv_path", "outdir_base_path", "genome"]
        if not all(key in job_details for key in required_base_keys):
            missing_keys = [key for key in required_base_keys if key not in job_details]
            logger.error(f"Corrupted staged job data for {staged_job_id}: Missing required keys: {missing_keys}. Data: {job_details}")
            redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'))
            raise HTTPException(status_code=500, detail="Incomplete staged job data found. Please try staging again.")

        # --- Prepare arguments for the RQ task (run_pipeline_task) ---
        # Pass the comma-separated string 'tools' value directly. Task handles default.
        job_args = (
            job_details["input_csv_path"],
            job_details["outdir_base_path"],
            job_details["genome"],
            job_details.get("tools"), # Pass stored comma-separated string or None
            job_details.get("step", SAREK_DEFAULT_STEP), # Use default if not set in staging
            job_details.get("profile", SAREK_DEFAULT_PROFILE),
            job_details.get("intervals_path"), # Will be None if not provided
            job_details.get("dbsnp_path"),     # Will be None if not provided
            job_details.get("known_indels_path"), # Will be None if not provided
            job_details.get("pon_path"),       # Will be None if not provided
            job_details.get("aligner", SAREK_DEFAULT_ALIGNER),
            job_details.get("joint_germline", False),
            job_details.get("wes", False),
            job_details.get("trim_fastq", False),
            job_details.get("skip_qc", False),
            job_details.get("skip_annotation", False),
            job_details.get("skip_baserecalibrator", False),
            # *** ADDED is_rerun argument ***
            job_details.get("is_rerun", False),
            # *******************************
        )

        # --- Enqueue the job to RQ ---
        try:
            # Use a new job ID for the RQ job, derived from the staged ID but distinct
            rq_job_id = staged_job_id.replace("staged_", "running_")
            if rq_job_id == staged_job_id: # Ensure it actually changed
                rq_job_id = f"running_{uuid.uuid4()}" # Fallback to totally new ID

            # Check if this RQ job ID already exists (e.g., from a previous failed attempt to start)
            try:
                 existing_job = Job.fetch(rq_job_id, connection=redis_conn)
                 if existing_job:
                     logger.warning(f"RQ job {rq_job_id} already exists (Status: {existing_job.get_status()}). Generating new ID.")
                     rq_job_id = f"running_{uuid.uuid4()}"
            except NoSuchJobError:
                pass # Job ID is available

            # Store original staged parameters within the RQ job's meta for later reference (like rerun)
            job_meta_to_store = {
                 "staged_job_id_origin": staged_job_id,
                 "input_params": job_details.get("input_filenames"),
                 "sarek_params": {
                     "genome": job_details.get("genome"),
                     "tools": job_details.get("tools"), # Store the comma-separated string
                     "step": job_details.get("step"),
                     "profile": job_details.get("profile"),
                     "aligner": job_details.get("aligner"),
                     "joint_germline": job_details.get("joint_germline", False),
                     "wes": job_details.get("wes", False),
                     "trim_fastq": job_details.get("trim_fastq", False),
                     "skip_qc": job_details.get("skip_qc", False),
                     "skip_annotation": job_details.get("skip_annotation", False),
                     "skip_baserecalibrator": job_details.get("skip_baserecalibrator", False),
                 },
                 "sample_info": job_details.get("sample_info"), # Includes lane
                 "description": job_details.get("description"),
                 # Store the input CSV path used, in case needed for debugging later
                 "input_csv_path_used": job_details.get("input_csv_path"),
                 # Store the is_rerun flag used for this specific execution
                 "is_rerun_execution": job_details.get("is_rerun", False),
            }


            rq_job = queue.enqueue(
                run_pipeline_task,
                args=job_args,
                job_timeout=DEFAULT_JOB_TIMEOUT,
                result_ttl=DEFAULT_RESULT_TTL,
                failure_ttl=DEFAULT_FAILURE_TTL,
                job_id=rq_job_id,
                meta=job_meta_to_store # Store the parameters in meta
            )
            logger.info(f"Successfully enqueued job {rq_job.id} to RQ queue.")
        except Exception as e:
            logger.error(f"Failed to enqueue job to RQ: {e}")
            raise HTTPException(status_code=503, detail="Service unavailable: Could not enqueue job for execution.")

        # --- Clean up staged job entry ---
        try:
            redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'))
            logger.info(f"Removed staged job entry {staged_job_id} after successful enqueue.")
        except redis.exceptions.RedisError as e:
            logger.warning(f"Could not remove staged job entry {staged_job_id} after enqueue: {e}")
            # Don't fail the request if cleanup fails

        return JSONResponse(
            status_code=202,
            content={
                "message": "Job enqueued for execution.",
                "job_id": rq_job.id,
                "status": "queued"
            }
        )

    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error starting job: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not start job due to storage error.")
    except Exception as e:
        logger.exception(f"Unexpected error starting job {staged_job_id}")
        raise HTTPException(status_code=500, detail="Internal server error during job start.")


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
                # Construct meta based on *stored* details
                # Ensure sample_info includes lane if present in stored details
                staged_meta = {
                    "input_params": details.get("input_filenames", {}),
                    "sarek_params": {
                         "genome": details.get("genome"),
                         "tools": details.get("tools"), # Reflects stored value (comma-separated string or None)
                         "step": details.get("step"),
                         "profile": details.get("profile"),
                         "aligner": details.get("aligner"),
                         "joint_germline": details.get("joint_germline", False),
                         "wes": details.get("wes", False),
                         "trim_fastq": details.get("trim_fastq", False),
                         "skip_qc": details.get("skip_qc", False),
                         "skip_annotation": details.get("skip_annotation", False),
                         "skip_baserecalibrator": details.get("skip_baserecalibrator", False),
                    },
                    "sample_info": details.get("sample_info", []), # Should contain lane if stored correctly
                    "staged_job_id_origin": job_id
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
                    "meta": staged_meta,
                    "staged_at": details.get("staged_at"),
                    "resources": None
                }
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as e:
                logger.error(f"Error decoding/parsing staged job data for key {job_id_bytes}: {e}. Skipping entry.")
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error fetching staged jobs from '{STAGED_JOBS_KEY}': {e}")

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
            limit = MAX_REGISTRY_JOBS if status_name in ["finished", "failed"] else -1
            if isinstance(registry_or_queue, Queue):
                job_ids = registry_or_queue.get_job_ids()
            elif isinstance(registry_or_queue, (StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry)):
                # Fetch most recent MAX_REGISTRY_JOBS
                total_count = registry_or_queue.count
                start_index = max(0, total_count - limit) if limit > 0 else 0
                end_index = total_count -1
                if start_index <= end_index:
                     job_ids = registry_or_queue.get_job_ids(start_index, end_index)
                     job_ids.reverse() # Show newest first within the limit

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
            # Use a separate connection for fetch_many that decodes responses=False
            redis_conn_bytes = redis.Redis(
                host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
                port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
                db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
                decode_responses=False # Crucial for RQ job fetching
            )
            fetched_jobs = Job.fetch_many(list(rq_job_ids_to_fetch), connection=redis_conn_bytes, serializer=queue.serializer)

            for job in fetched_jobs:
                if job:
                    job.refresh() # Fetch latest status and meta
                    current_status = job.get_status(refresh=False) # Use cached status after refresh
                    error_summary = None
                    job_meta = job.meta or {} # Use fetched meta

                    if current_status == JobStatus.FAILED:
                         error_summary = job_meta.get('error_message', "Job failed processing")
                         stderr_snippet = job_meta.get('stderr_snippet')
                         # Use exc_info if available and error_message is generic
                         if error_summary == "Job failed processing" and job.exc_info:
                             try: error_summary = job.exc_info.strip().split('\n')[-1]
                             except Exception: pass # Ignore errors parsing exc_info
                         if stderr_snippet: error_summary += f" (stderr: {stderr_snippet}...)"

                    # Extract resource info from meta
                    resources = {
                        "peak_memory_mb": job_meta.get("peak_memory_mb"),
                        "average_cpu_percent": job_meta.get("average_cpu_percent"),
                        "duration_seconds": job_meta.get("duration_seconds")
                    }

                    # Add or update the job in our dictionary
                    # Ensure we don't overwrite a running/finished job with a stale staged entry if IDs clash
                    if job.id not in all_jobs_dict or all_jobs_dict[job.id].get('status') == 'staged':
                         all_jobs_dict[job.id] = {
                            "id": job.id,
                            "status": current_status,
                            # Use description from meta if available, fallback to job.description or generic
                            "description": job_meta.get("description") or job.description or f"RQ job {job.id[:12]}...",
                            "enqueued_at": dt_to_timestamp(job.enqueued_at),
                            "started_at": dt_to_timestamp(job.started_at),
                            "ended_at": dt_to_timestamp(job.ended_at),
                            "result": job.result, # Result directly from job object
                            "error": error_summary,
                            "meta": job_meta, # Use the full meta fetched
                            "staged_at": None, # Not a staged job anymore
                            "resources": resources if any(v is not None for v in resources.values()) else None
                        }
        except redis.exceptions.RedisError as e:
             logger.error(f"Redis error during Job.fetch_many: {e}")
             # Don't raise HTTPException here, return potentially partial list
        except Exception as e:
            logger.exception("Unexpected error fetching RQ job details.")
            # Don't raise HTTPException here

    # 3. Sort the Combined List
    try:
        # Sort primarily by last update time (ended > started > enqueued > staged) descending
        all_jobs_list = sorted(
            all_jobs_dict.values(),
            key=lambda j: j.get('ended_at') or j.get('started_at') or j.get('enqueued_at') or j.get('staged_at') or 0,
            reverse=True
        )
    except Exception as e:
        logger.exception("Error sorting combined jobs list.")
        all_jobs_list = list(all_jobs_dict.values()) # Fallback to unsorted if error

    # Limit the number of finished/failed jobs returned if MAX_REGISTRY_JOBS is set
    if MAX_REGISTRY_JOBS > 0:
        final_list = []
        finished_failed_count = 0
        for job_item in all_jobs_list:
             status = job_item.get('status', '').lower()
             is_terminal = status in ['finished', 'failed', 'stopped', 'canceled']
             if is_terminal:
                 if finished_failed_count < MAX_REGISTRY_JOBS:
                     final_list.append(job_item)
                     finished_failed_count += 1
             else:
                 final_list.append(job_item) # Always include non-terminal jobs
        all_jobs_list = final_list


    return all_jobs_list


@router.get("/job_status/{job_id}", response_model=JobStatusDetails, summary="Get RQ Job Status and Details")
async def get_job_status(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue) # Need queue for serializer
):
    """
    Fetches the status, result/error, metadata, and resource usage for a specific RQ job ID.
    Handles cases where the job might not be found in RQ (checks staged).
    """
    logger.debug(f"Fetching status for job ID: {job_id}")
    try:
        # --- Check if it's an RQ Job ID first ---
        if not job_id.startswith("staged_"):
            try:
                redis_conn_bytes = redis.Redis(
                    host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
                    port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
                    db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
                    decode_responses=False # Required for RQ
                )
                job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
                job.refresh() # Get the latest status and meta

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

                resource_stats = {
                    "peak_memory_mb": meta_data.get("peak_memory_mb"),
                    "average_cpu_percent": meta_data.get("average_cpu_percent"),
                    "duration_seconds": meta_data.get("duration_seconds")
                }

                return JobStatusDetails(
                    job_id=job.id,
                    status=status,
                    description=meta_data.get("description") or job.description, # Prefer meta description
                    enqueued_at=dt_to_timestamp(job.enqueued_at),
                    started_at=dt_to_timestamp(job.started_at),
                    ended_at=dt_to_timestamp(job.ended_at),
                    result=result,
                    error=error_info_summary,
                    meta=meta_data,
                    resources=JobResourceInfo(**resource_stats) if any(v is not None for v in resource_stats.values()) else None
                )

            except NoSuchJobError:
                logger.warning(f"RQ Job ID '{job_id}' not found.")
                # Fall through to check staged jobs if it wasn't found in RQ
            except redis.exceptions.RedisError as e:
                logger.error(f"Redis error fetching RQ job {job_id}: {e}")
                raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to status backend.")
            except Exception as e:
                logger.exception(f"Unexpected error fetching or refreshing RQ job {job_id}.")
                raise HTTPException(status_code=500, detail="Internal server error fetching job status.")


        # --- Check if it's a Staged Job ID ---
        if job_id.startswith("staged_"):
            try:
                 staged_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id.encode('utf-8'))
                 if staged_details_bytes:
                     logger.info(f"Job ID {job_id} corresponds to a currently staged job.")
                     try:
                         details = json.loads(staged_details_bytes.decode('utf-8'))
                         # Construct meta including sample_info with lane
                         staged_meta = {
                             "input_params": details.get("input_filenames", {}),
                             "sarek_params": {
                                  "genome": details.get("genome"), "tools": details.get("tools"),
                                  "step": details.get("step"), "profile": details.get("profile"),
                                  "aligner": details.get("aligner"),
                                  "joint_germline": details.get("joint_germline", False),
                                  "wes": details.get("wes", False), "trim_fastq": details.get("trim_fastq", False),
                                  "skip_qc": details.get("skip_qc", False),
                                  "skip_annotation": details.get("skip_annotation", False),
                                  "skip_baserecalibrator": details.get("skip_baserecalibrator", False),
                             },
                             "sample_info": details.get("sample_info", []), # Should contain lane
                             "staged_job_id_origin": job_id,
                             "description": details.get("description"),
                         }
                         return JobStatusDetails(
                             job_id=job_id, status="staged",
                             description=details.get("description"),
                             enqueued_at=None, started_at=None, ended_at=None,
                             result=None, error=None, meta=staged_meta, resources=None
                         )
                     except (json.JSONDecodeError, UnicodeDecodeError, TypeError) as parse_err:
                         logger.error(f"Error parsing staged job details for {job_id} in status check: {parse_err}")
                         # Fall through to 404 if parsing fails
                 else:
                     logger.warning(f"Staged job ID '{job_id}' not found in Redis hash.")

            except redis.exceptions.RedisError as e:
                 logger.error(f"Redis error checking staged status for {job_id}: {e}")
                 # Fall through to 404


        # --- If not found in RQ or Staged ---
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    except HTTPException as http_exc:
        raise http_exc # Re-raise FastAPI exceptions
    except Exception as e:
         logger.exception(f"Unexpected error in get_job_status for {job_id}.")
         raise HTTPException(status_code=500, detail="Internal server error retrieving job status.")


@router.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued RQ Job")
async def stop_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    """
    Sends a stop signal to a specific RQ job if it's running or queued.
    Does NOT stop 'staged' jobs.
    """
    if job_id.startswith("staged_"):
        raise HTTPException(status_code=400, detail="Cannot stop a 'staged' job. Remove it instead.")

    logger.info(f"Received request to stop RQ job: {job_id}")
    try:
        redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
                                       port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
                                       db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
                                       decode_responses=False)

        job = Job.fetch(job_id, connection=redis_conn_bytes)
        status = job.get_status(refresh=True)

        if job.is_finished or job.is_failed or job.is_stopped or job.is_canceled:
            logger.warning(f"Attempted to stop job {job_id} which is already in state: {status}")
            return JSONResponse(status_code=200, content={"message": f"Job already in terminal state: {status}.", "job_id": job_id})

        logger.info(f"Job {job_id} is in state {status}. Attempting to send stop signal.")
        message = f"Stop signal sent to job {job_id}."
        try:
            send_stop_job_command(redis_conn_bytes, job.id)
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
    queue: Queue = Depends(get_pipeline_queue)
):
    """
    Removes a job's data from Redis. Handles both 'staged_*' IDs and RQ job IDs.
    Also cleans up the temporary input CSV file if found in meta.
    """
    logger.info(f"Request received to remove job/data for ID: {job_id}")
    csv_path_to_remove = None

    # --- Case 1: Handle Staged Jobs ---
    if job_id.startswith("staged_"):
        logger.info(f"Attempting to remove staged job '{job_id}' from hash '{STAGED_JOBS_KEY}'.")
        try:
            job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id.encode('utf-8'))
            if job_details_bytes:
                try:
                    details = json.loads(job_details_bytes.decode('utf-8'))
                    csv_path_to_remove = details.get("input_csv_path")
                except (json.JSONDecodeError, UnicodeDecodeError):
                     logger.warning(f"Could not parse details for staged job {job_id} during removal, cannot identify CSV.")

            num_deleted = redis_conn.hdel(STAGED_JOBS_KEY, job_id.encode('utf-8'))

            if num_deleted == 1:
                logger.info(f"Successfully removed staged job entry: {job_id}")
                # Attempt cleanup outside the main try/except for Redis errors
            else:
                logger.warning(f"Staged job '{job_id}' not found in hash for removal.")
                raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found.")

        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error removing staged job {job_id}: {e}")
            raise HTTPException(status_code=503, detail="Service unavailable: Could not remove job due to storage error.")
        except HTTPException as e:
            raise e # Re-raise 404 etc.
        except Exception as e:
            logger.exception(f"Unexpected error during staged job removal check for {job_id}.")
            raise HTTPException(status_code=500, detail="Internal server error removing staged job.")

    # --- Case 2: Handle RQ Jobs ---
    else:
        logger.info(f"Attempting to remove RQ job '{job_id}' data.")
        try:
            redis_conn_bytes = redis.Redis(
                host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
                port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
                db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
                decode_responses=False,
                socket_timeout=5,
                socket_connect_timeout=5
            )

            try:
                job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
                # Get CSV path from meta before potentially deleting the job
                if job and job.meta:
                    csv_path_to_remove = job.meta.get("input_csv_path_used") or job.meta.get("input_csv_path")

            except NoSuchJobError:
                logger.warning(f"RQ Job '{job_id}' not found for removal.")
                raise HTTPException(status_code=404, detail=f"RQ Job '{job_id}' not found.")
            except Exception as fetch_err:
                logger.error(f"Error fetching job {job_id}: {fetch_err}")
                raise HTTPException(status_code=500, detail=f"Could not fetch job {job_id} for removal")

            if not job:
                 raise HTTPException(status_code=404, detail=f"Job {job_id} not found") # Should be caught by NoSuchJobError

            try: job_status = job.get_status()
            except Exception as status_err: logger.error(f"Error getting status for job {job_id}: {status_err}"); job_status = None

            if job_status == 'started':
                try:
                    logger.info(f"Sending stop signal to running job {job_id} before removal")
                    send_stop_job_command(redis_conn_bytes, job.id)
                    time.sleep(1) # Brief pause, though stop is not guaranteed synchronous
                except Exception as stop_err:
                    logger.warning(f"Could not stop running job {job_id} before removal: {stop_err}")

            try:
                # Remove from all relevant registries
                for registry_func in [queue.remove, StartedJobRegistry(queue=queue).remove, FinishedJobRegistry(queue=queue).remove, FailedJobRegistry(queue=queue).remove]:
                    try:
                        registry_func(job, delete_job=False) # Remove from registry, don't delete the job data yet
                    except InvalidJobOperation:
                         logger.debug(f"Job {job_id} not in registry for removal.")
                    except Exception as reg_err:
                        logger.warning(f"Error removing job {job_id} from a registry: {reg_err}")

                # Now delete the job data itself
                job.delete(remove_from_registries=False) # Already removed from registries
                logger.info(f"Successfully deleted RQ job data for {job_id}")

            except InvalidJobOperation as e:
                 # This might happen if trying to delete a job that's actively running and locked
                 logger.warning(f"Invalid operation trying to remove RQ job {job_id}: {e}")
                 raise HTTPException(status_code=409, detail=f"Cannot remove job '{job_id}': Invalid operation (job might be active or locked). Try stopping first.")
            except Exception as delete_err:
                logger.error(f"Error deleting job {job_id}: {delete_err}")
                raise HTTPException(status_code=500, detail=f"Could not delete job {job_id}")

        except HTTPException as e: raise e # Re-raise specific HTTP errors
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error removing RQ job {job_id}: {e}")
            raise HTTPException(status_code=503, detail="Service unavailable: Could not remove RQ job due to storage error.")
        except Exception as e:
            logger.exception(f"Unexpected error during RQ job removal for {job_id}: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Internal server error removing RQ job: {str(e)}")

    # --- Common Cleanup Logic ---
    if csv_path_to_remove:
        try:
            csv_path = Path(csv_path_to_remove)
            # Basic safety check: Ensure it's a CSV file in a plausible temp location or results subdir
            if csv_path.exists() and csv_path.is_file() and csv_path.suffix == '.csv':
                 # More safety: Check if it's within expected parent dirs (e.g., system temp or results base)
                 # This is a basic check, adjust based on where temp files are actually created
                 # temp_dir = Path(tempfile.gettempdir())
                 # if csv_path.parent == temp_dir or RESULTS_DIR in csv_path.parents:
                 os.remove(csv_path)
                 logger.info(f"Cleaned up temporary CSV file for removed job {job_id}: {csv_path}")
                 # else:
                 #     logger.warning(f"Skipping removal of CSV file outside expected temp/results area: {csv_path}")
            else:
                 logger.warning(f"Temporary CSV path {csv_path} not found, invalid, or not a CSV for removal associated with job {job_id}.")
        except OSError as e:
            logger.warning(f"Could not clean up temporary CSV file {csv_path_to_remove} for job {job_id}: {e}")
        except Exception as e:
             logger.warning(f"Unexpected error during CSV cleanup for job {job_id}: {e}")


    return JSONResponse(status_code=200, content={"message": f"Successfully removed job {job_id}.", "removed_id": job_id})


@router.post("/rerun_job/{job_id}", status_code=202, summary="Re-stage Failed/Finished Job")
async def rerun_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    """
    Re-stages a previously run (failed or finished) job using the parameters
    stored in its RQ job meta. Creates a *new* staged job entry.
    """
    if job_id.startswith("staged_"):
        raise HTTPException(status_code=400, detail="Cannot re-run a job that is still 'staged'. Start it first.")

    logger.info(f"Attempting to re-stage job based on RQ job: {job_id}")
    try:
        # Fetch the original RQ job details
        redis_conn_bytes = redis.Redis(
            host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'),
            port=redis_conn.connection_pool.connection_kwargs.get('port', 6379),
            db=redis_conn.connection_pool.connection_kwargs.get('db', 0),
            decode_responses=False
        )
        try:
             original_job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
        except NoSuchJobError:
            logger.warning(f"Re-stage request failed: Original RQ job ID '{job_id}' not found.")
            raise HTTPException(status_code=404, detail=f"Original job '{job_id}' not found to re-stage.")

        if not original_job.meta:
            logger.error(f"Cannot re-stage job {job_id}: Original job metadata is missing.")
            raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Missing original parameters.")

        original_meta = original_job.meta
        original_sarek_params = original_meta.get("sarek_params", {})
        original_input_params = original_meta.get("input_params", {})
        original_sample_info = original_meta.get("sample_info", [])
        original_description = original_meta.get("description", f"Sarek run")

        # --- Create a new temporary CSV for the re-run ---
        # We need to recreate the samplesheet as the original temp one was likely deleted.
        if not original_sample_info:
             raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Original sample info missing from metadata.")

        new_sample_rows_for_csv = []
        for sample_data in original_sample_info:
             # Assume sample_data structure matches SampleInfo model (including lane)
             new_sample_rows_for_csv.append([
                 sample_data.get('patient'), sample_data.get('sample'), sample_data.get('sex'),
                 sample_data.get('status'), sample_data.get('lane'),
                 sample_data.get('fastq_1'), sample_data.get('fastq_2')
             ])

        new_temp_csv_file_path = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv:
                csv_writer = csv.writer(temp_csv)
                csv_writer.writerow(['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2'])
                csv_writer.writerows(new_sample_rows_for_csv)
                new_temp_csv_file_path = temp_csv.name
                logger.info(f"Created new temporary samplesheet for re-run: {new_temp_csv_file_path}")
        except (OSError, csv.Error) as e:
             logger.error(f"Failed to create new temporary samplesheet for re-run of {job_id}: {e}")
             raise HTTPException(status_code=500, detail="Internal server error: Could not create samplesheet for re-run.")

        # --- Create details for the new staged job ---
        new_staged_job_id = f"staged_{uuid.uuid4()}"

        # Reconstruct paths from original meta (these should be absolute host paths)
        # Use original_input_params for filenames and reconstruct full paths if needed,
        # but the task function expects full paths directly.
        # Let's assume the original sarek_params and input_params hold enough info.
        intervals_path = original_meta.get("intervals_path") or \
                         (Path(DATA_DIR / original_input_params["intervals_file"]).as_posix() if original_input_params.get("intervals_file") else None)
        dbsnp_path = original_meta.get("dbsnp_path") or \
                     (Path(DATA_DIR / original_input_params["dbsnp"]).as_posix() if original_input_params.get("dbsnp") else None)
        known_indels_path = original_meta.get("known_indels_path") or \
                            (Path(DATA_DIR / original_input_params["known_indels"]).as_posix() if original_input_params.get("known_indels") else None)
        pon_path = original_meta.get("pon_path") or \
                   (Path(DATA_DIR / original_input_params["pon"]).as_posix() if original_input_params.get("pon") else None)

        new_job_details = {
            "input_csv_path": new_temp_csv_file_path, # Use the NEWLY created CSV path
            "intervals_path": intervals_path,
            "dbsnp_path": dbsnp_path,
            "known_indels_path": known_indels_path,
            "pon_path": pon_path,
            "outdir_base_path": str(RESULTS_DIR),

            "genome": original_sarek_params.get("genome", "GATK.GRCh38"), # Provide default if missing
            "tools": original_sarek_params.get("tools"), # Comma-separated string or None
            "step": original_sarek_params.get("step", SAREK_DEFAULT_STEP),
            "profile": original_sarek_params.get("profile", SAREK_DEFAULT_PROFILE),
            "aligner": original_sarek_params.get("aligner", SAREK_DEFAULT_ALIGNER),

            "joint_germline": original_sarek_params.get("joint_germline", False),
            "wes": original_sarek_params.get("wes", False),
            "trim_fastq": original_sarek_params.get("trim_fastq", False),
            "skip_qc": original_sarek_params.get("skip_qc", False),
            "skip_annotation": original_sarek_params.get("skip_annotation", False),
            "skip_baserecalibrator": original_sarek_params.get("skip_baserecalibrator", False),

            "description": f"Re-run of job {job_id} ({original_description})",
            "staged_at": time.time(),
            "input_filenames": original_input_params, # Keep original input filenames for reference
            "sample_info": original_sample_info, # Keep original sample details
            "is_rerun": True, # Mark this specifically for the task execution
            "original_job_id": job_id, # Reference the original job
        }

        # Store the new staged job
        redis_conn.hset(STAGED_JOBS_KEY, new_staged_job_id.encode('utf-8'), json.dumps(new_job_details).encode('utf-8'))
        logger.info(f"Created new staged job {new_staged_job_id} for re-run of {job_id}")

        # Return the staged job ID - user needs to manually start it
        return JSONResponse(
            status_code=200, # Return 200 OK as staging is complete
            content={
                 "message": f"Job {job_id} re-staged successfully as {new_staged_job_id}. Please start the new job.",
                 "staged_job_id": new_staged_job_id # Return the NEW staged ID
            }
        )
        # Alternatively, automatically start the re-staged job:
        # return await start_job(new_staged_job_id, redis_conn, queue)

    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error during job re-stage for {job_id}: {e}")
        # Clean up new CSV if created before error
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists():
            try: os.remove(new_temp_csv_file_path)
            except OSError: pass
        raise HTTPException(status_code=503, detail="Service unavailable: Could not access job storage.")
    except HTTPException as e:
         # Clean up new CSV if created before error
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists():
            try: os.remove(new_temp_csv_file_path)
            except OSError: pass
        raise e # Re-raise FastAPI exceptions
    except Exception as e:
        logger.exception(f"Unexpected error during job re-stage for {job_id}: {e}")
         # Clean up new CSV if created before error
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists():
            try: os.remove(new_temp_csv_file_path)
            except OSError: pass
        raise HTTPException(status_code=500, detail="Internal server error during job re-stage.")
