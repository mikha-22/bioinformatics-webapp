# backend/app/routers/jobs.py
import logging
import json
import uuid
import time
import redis # Import redis exceptions
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

# RQ Imports
from rq import Queue, Worker
from rq.job import Job, JobStatus
# --- ADD JobNotFoundErr and InvalidJobOperation ---
from rq.exceptions import NoSuchJobError, InvalidJobOperation
from rq.registry import StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry
from rq.command import send_stop_job_command

# App specific imports
from ..core.config import (
    PIPELINE_SCRIPT_PATH, STAGED_JOBS_KEY, DEFAULT_JOB_TIMEOUT,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL, MAX_REGISTRY_JOBS
)
from ..core.redis_rq import get_redis_connection, get_pipeline_queue
from ..models.pipeline import PipelineInput
from ..utils.validation import validate_pipeline_input
from ..utils.time import dt_to_timestamp
from ..tasks import run_pipeline_task # Import the actual task function

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Jobs Management"] # Tag for OpenAPI docs
    # prefix="/api" # Optional: Add a prefix like /api/run_pipeline
)

# --- Job Staging and Control Routes ---

@router.post("/run_pipeline", status_code=200, summary="Stage Pipeline Job")
async def stage_pipeline_job(
    input_data: PipelineInput,
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    """
    Validates inputs, generates a unique ID, and stores job details in Redis hash
    for later execution via /start_job endpoint.
    Returns 200 OK with staged job ID.
    """
    # ... (keep existing code for stage_pipeline_job) ...
    if not PIPELINE_SCRIPT_PATH.is_file():
        logger.error(f"Pipeline script not found at configured path: {PIPELINE_SCRIPT_PATH}")
        raise HTTPException(status_code=500, detail="Server configuration error: Pipeline script missing.")

    # Validate inputs and get absolute paths (raises HTTPException on failure)
    paths_map, known_variants_path_str, validation_errors = validate_pipeline_input(input_data)
    if validation_errors:
        logger.warning(f"Validation errors staging job: {validation_errors}")
        # Join errors for a user-friendly message
        error_detail = "Input validation failed: " + "; ".join(validation_errors)
        raise HTTPException(status_code=400, detail=error_detail)

    try:
        staged_job_id = f"staged_{uuid.uuid4()}"
        # Store original *relative* filenames in meta for potential rerun/display
        input_filenames = {
            "forward_reads": input_data.forward_reads_file,
            "reverse_reads": input_data.reverse_reads_file,
            "reference_genome": input_data.reference_genome_file,
            "target_regions": input_data.target_regions_file,
            "known_variants": input_data.known_variants_file # Store original value (can be None)
        }
        # Store absolute paths needed for the task execution
        job_details = {
            "pipeline_script_path": str(PIPELINE_SCRIPT_PATH),
            "forward_reads_path": str(paths_map["forward_reads"]),
            "reverse_reads_path": str(paths_map["reverse_reads"]),
            "reference_genome_path": str(paths_map["reference_genome"]),
            "target_regions_path": str(paths_map["target_regions"]),
            "known_variants_path": known_variants_path_str, # This is the absolute path string or None
            "description": f"Pipeline for {input_data.forward_reads_file}",
            "staged_at": time.time(),
            "input_filenames": input_filenames # Embed original filenames here
        }
        # Store as bytes in Redis hash (RQ uses bytes)
        redis_conn.hset(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'), json.dumps(job_details).encode('utf-8'))
        logger.info(f"Staged job '{staged_job_id}' for file '{input_data.forward_reads_file}'.")
        return JSONResponse(status_code=200, content={"message": "Job staged successfully.", "staged_job_id": staged_job_id})

    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error staging job: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not stage job due to storage error.")
    except Exception as e:
        logger.exception("Failed to stage pipeline job due to unexpected error.")
        raise HTTPException(status_code=500, detail="Internal server error: Could not stage job.")


@router.post("/start_job/{staged_job_id}", status_code=202, summary="Enqueue Staged Job")
async def start_job(
    staged_job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    """
    Retrieves staged job details from Redis, enqueues it to RQ for execution,
    and removes the corresponding entry from the staged jobs hash upon successful enqueueing.
    Returns 202 Accepted with the new RQ job ID.
    """
    # ... (keep existing code for start_job) ...
    logger.info(f"Attempting to start job from staged ID: {staged_job_id}")
    try:
        # Fetch the staged job details (bytes)
        job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'))
        if not job_details_bytes:
            logger.warning(f"Start job request failed: Staged job ID '{staged_job_id}' not found.")
            raise HTTPException(status_code=404, detail=f"Staged job '{staged_job_id}' not found. It may have already been started or removed.")

        # Decode and parse JSON
        try:
            job_details = json.loads(job_details_bytes.decode('utf-8'))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
             logger.error(f"Corrupted staged job data for {staged_job_id}: {e}. Removing entry.")
             redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8')) # Clean up bad entry
             raise HTTPException(status_code=500, detail="Corrupted staged job data found. Please try staging again.")

        # Basic check for required keys before enqueueing
        required_keys = ["pipeline_script_path", "forward_reads_path", "reverse_reads_path", "reference_genome_path", "target_regions_path"]
        if not all(key in job_details for key in required_keys):
             logger.error(f"Corrupted staged job data for {staged_job_id}: Missing required keys. Data: {job_details}")
             redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8')) # Clean up bad entry
             raise HTTPException(status_code=500, detail="Incomplete staged job data found. Please try staging again.")

        # Prepare arguments and metadata for the RQ task
        job_args = (
            job_details["pipeline_script_path"],
            job_details["forward_reads_path"],
            job_details["reverse_reads_path"],
            job_details["reference_genome_path"],
            job_details["target_regions_path"],
            job_details.get("known_variants_path"), # Pass the absolute path or None
        )
        job_meta = {
            "input_params": job_details.get("input_filenames", {}), # Include original filenames
            "staged_job_id_origin": staged_job_id # Keep track of the original staged ID
        }
        job_description = job_details.get("description", f"Run originating from {staged_job_id}")

        # Enqueue the job to RQ
        job = queue.enqueue(
            f=run_pipeline_task,
            args=job_args,
            meta=job_meta,
            job_id_prefix="bio_pipeline_", # Custom prefix for RQ job IDs
            job_timeout=DEFAULT_JOB_TIMEOUT,
            result_ttl=DEFAULT_RESULT_TTL,
            failure_ttl=DEFAULT_FAILURE_TTL,
            description=job_description
        )
        logger.info(f"Successfully enqueued RQ job {job.id} from staged job {staged_job_id}")

        # --- Critical Step: Remove the staged job entry ONLY AFTER successful enqueueing ---
        try:
            redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'))
            logger.info(f"Removed staged job entry {staged_job_id} after enqueueing.")
        except redis.exceptions.RedisError as del_e:
             # Log error but don't fail the request, job is already enqueued
             logger.error(f"Failed to remove staged job entry {staged_job_id} after enqueueing: {del_e}")

        return JSONResponse(status_code=202, content={"message": "Job successfully enqueued.", "job_id": job.id})

    except HTTPException as e:
         # Re-raise HTTP exceptions (like 404)
         raise e
    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error during start job process for {staged_job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable: Could not access job storage.")
    except Exception as e:
        logger.exception(f"Unexpected error starting/enqueuing staged job {staged_job_id}.")
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
    # ... (keep existing code for get_jobs_list) ...
    all_jobs_dict = {}

    # 1. Get Staged Jobs from Redis Hash
    try:
        # hgetall returns Dict[bytes, bytes] when decode_responses=False
        staged_jobs_raw = redis_conn.hgetall(STAGED_JOBS_KEY)
        for job_id_bytes, job_details_bytes in staged_jobs_raw.items():
            try:
                job_id = job_id_bytes.decode('utf-8')
                details = json.loads(job_details_bytes.decode('utf-8'))
                # Construct a dictionary similar to RQ job structure for consistency
                all_jobs_dict[job_id] = {
                    "id": job_id, # Use 'id' key consistently across this endpoint's response
                    "status": "staged",
                    "description": details.get("description", f"Staged job {job_id[:8]}..."),
                    "enqueued_at": None,
                    "started_at": None,
                    "ended_at": None,
                    "result": None,
                    "error": None,
                    "meta": {"input_params": details.get("input_filenames", {}),"staged_job_id_origin": job_id},
                    "staged_at": details.get("staged_at"), # Timestamp when staged
                    "resources": None # No resources for staged jobs
                }
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as e:
                logger.error(f"Error decoding/parsing staged job data for key {job_id_bytes}: {e}. Skipping entry.")
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error fetching staged jobs from '{STAGED_JOBS_KEY}': {e}")
        # Continue to fetch RQ jobs even if staged jobs fail, but maybe raise 503?
        # raise HTTPException(status_code=503, detail="Failed to retrieve staged jobs list from storage.")

    # 2. Get RQ Jobs from Relevant Registries
    # Define registries to check
    registries_to_check = {
        "queued": queue, # Queue object itself contains queued job IDs
        "started": StartedJobRegistry(queue=queue),
        "finished": FinishedJobRegistry(queue=queue),
        "failed": FailedJobRegistry(queue=queue),
        # Add DeferredJobRegistry(queue=queue), ScheduledJobRegistry(queue=queue) if needed
    }

    # Use RQ's Job.fetch_many for efficiency where possible
    rq_job_ids_to_fetch = set()
    for status_name, registry_or_queue in registries_to_check.items():
        try:
            job_ids = []
            if isinstance(registry_or_queue, Queue):
                job_ids = registry_or_queue.get_job_ids() # Get all currently queued IDs
            elif isinstance(registry_or_queue, (StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry)):
                # Limit finished/failed history to avoid fetching too many
                limit = -1 if status_name == "started" else MAX_REGISTRY_JOBS
                # Fetch IDs from the beginning (0) up to the limit
                job_ids = registry_or_queue.get_job_ids(0, limit -1) # get_job_ids(start, end) is inclusive
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
            fetched_jobs = Job.fetch_many(list(rq_job_ids_to_fetch), connection=redis_conn, serializer=queue.serializer)
            for job in fetched_jobs:
                if job: # fetch_many can return None for missing jobs
                    job.refresh() # Ensure meta and latest status are loaded
                    current_status = job.get_status(refresh=False) # Status is already refreshed
                    error_summary = None

                    if current_status == JobStatus.FAILED:
                         # Try to get a concise error summary
                         error_summary = job.meta.get('error_message', "Job failed processing")
                         stderr_snippet = job.meta.get('stderr_snippet')
                         # If default message, try to get last line of traceback
                         if error_summary == "Job failed processing" and job.exc_info:
                             try:
                                 lines = job.exc_info.strip().split('\n')
                                 if lines: error_summary = lines[-1]
                             except Exception: pass # Ignore parsing errors
                         if stderr_snippet:
                             error_summary += f" (stderr: {stderr_snippet}...)" # Append snippet

                    # Add or update the job in our dictionary
                    # Important: Don't overwrite a final state (failed/finished) with an earlier state (started/queued)
                    # if the same ID somehow appeared in multiple registries momentarily.
                    # Also, don't overwrite a staged job if the RQ job is somehow older.
                    if job.id not in all_jobs_dict or all_jobs_dict[job.id]['status'] == 'staged':
                         all_jobs_dict[job.id] = {
                            "id": job.id, # Use 'id' key consistently
                            "status": current_status,
                            "description": job.description or f"RQ job {job.id[:12]}...",
                            "enqueued_at": dt_to_timestamp(job.enqueued_at),
                            "started_at": dt_to_timestamp(job.started_at),
                            "ended_at": dt_to_timestamp(job.ended_at),
                            "result": job.result, # Task's return value
                            "error": error_summary,
                            "meta": job.meta or {}, # Include full meta for potential UI use
                            "staged_at": None, # Not applicable to RQ jobs directly
                            # Extract resource stats from meta for top-level access
                            "resources": {
                                "peak_memory_mb": job.meta.get("peak_memory_mb"),
                                "average_cpu_percent": job.meta.get("average_cpu_percent"),
                                "duration_seconds": job.meta.get("duration_seconds")
                            }
                        }
        except redis.exceptions.RedisError as e:
             logger.error(f"Redis error during Job.fetch_many: {e}")
             # Might indicate a broader Redis issue
             raise HTTPException(status_code=503, detail="Failed to retrieve job details from storage.")
        except Exception as e:
            logger.exception("Unexpected error fetching RQ job details.")
            raise HTTPException(status_code=500, detail="Internal server error fetching job details.")


    # 3. Sort the Combined List
    # Sort primarily by time: staged_at or enqueued_at descending (newest first)
    # Use 0 as a fallback time if somehow both are missing
    try:
        all_jobs_list = sorted(
            all_jobs_dict.values(),
            key=lambda j: j.get('staged_at') or j.get('enqueued_at') or 0,
            reverse=True
        )
    except Exception as e:
        logger.exception("Error sorting combined jobs list.")
        # Return unsorted list as a fallback? Or raise 500?
        all_jobs_list = list(all_jobs_dict.values()) # Fallback to unsorted
        # raise HTTPException(status_code=500, detail="Internal server error sorting jobs.")


    return all_jobs_list


@router.get("/job_status/{job_id}", summary="Get RQ Job Status and Details")
async def get_job_status(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue) # Need queue for serializer
):
    """
    Fetches the status, result/error, metadata, and resource usage for a specific RQ job ID.
    Handles cases where the job might not be found in RQ.
    """
    # ... (keep existing code for get_job_status) ...
    logger.debug(f"Fetching status for RQ job ID: {job_id}")
    try:
        # Fetch the job using the connection and serializer from the queue
        job = Job.fetch(job_id, connection=redis_conn, serializer=queue.serializer)
        job.refresh() # Load meta, status, result etc.
    except NoSuchJobError:
        logger.warning(f"Job status request failed: RQ job ID '{job_id}' not found.")
        # Before raising 404, quickly check if it's a currently staged job ID.
        # This helps differentiate "never started" from "finished and disappeared".
        try:
             if job_id.startswith("staged_") and redis_conn.hexists(STAGED_JOBS_KEY, job_id.encode('utf-8')):
                  logger.info(f"Job ID {job_id} corresponds to a currently staged job.")
                  # Return a specific response indicating it's staged? Or let 404 stand?
                  # Let's raise 404 as it's not an *RQ* job that can be polled for status.
                  raise HTTPException(status_code=404, detail=f"Job '{job_id}' is currently staged but not running.")
             else:
                  # Standard 404 if not found in RQ and not currently staged
                  raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found in active queues or recent history.")
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error checking staged status for {job_id}: {e}")
            # Fallback to the original 404 if Redis check fails
            raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found (storage check failed).")

    except redis.exceptions.RedisError as e:
         logger.error(f"Redis error fetching RQ job {job_id}: {e}")
         raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to status backend.")
    except Exception as e:
        logger.exception(f"Unexpected error fetching or refreshing job {job_id}.")
        raise HTTPException(status_code=500, detail="Internal server error fetching job status.")

    # Process the fetched job data
    status = job.get_status(refresh=False) # Already refreshed
    result = None
    meta_data = job.meta or {}
    error_info_summary = None

    try:
        if status == JobStatus.FINISHED:
            result = job.result # Contains {'status': 'success', 'results_path': ...} or whatever task returns
        elif status == JobStatus.FAILED:
            # Construct the error summary as before
            error_info_summary = meta_data.get('error_message', "Job failed processing")
            stderr_snippet = meta_data.get('stderr_snippet')
            if error_info_summary == "Job failed processing" and job.exc_info:
                 try:
                     lines = job.exc_info.strip().split('\n')
                     if lines: error_info_summary = lines[-1]
                 except Exception: pass
            if stderr_snippet:
                 error_info_summary += f" (stderr: {stderr_snippet}...)"
    except Exception as e:
        logger.exception(f"Error accessing result/error info for job {job_id} (status: {status}).")
        error_info_summary = error_info_summary or "Could not retrieve job result/error details."

    # Extract resource stats from meta
    resource_stats = {
        "peak_memory_mb": meta_data.get("peak_memory_mb"),
        "average_cpu_percent": meta_data.get("average_cpu_percent"),
        "duration_seconds": meta_data.get("duration_seconds")
    }

    # Return a consistent structure
    return JSONResponse(content={
        "job_id": job.id, # Use 'job_id' key in the response JSON
        "status": status,
        "result": result,
        "error": error_info_summary,
        "meta": meta_data, # Full meta might be useful for debugging/display
        "resources": resource_stats, # Include extracted resources
        "enqueued_at": dt_to_timestamp(job.enqueued_at),
        "started_at": dt_to_timestamp(job.started_at),
        "ended_at": dt_to_timestamp(job.ended_at)
        })


@router.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued RQ Job")
async def stop_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    """
    Sends a stop signal to a specific RQ job if it's running or queued.
    """
    # ... (keep existing code for stop_job) ...
    logger.info(f"Received request to stop RQ job: {job_id}")
    try:
        job = Job.fetch(job_id, connection=redis_conn)
        status = job.get_status(refresh=True) # Refresh status before checking

        # Check if job is already in a terminal state
        if job.is_finished or job.is_failed or job.is_stopped or job.is_canceled:
            logger.warning(f"Attempted to stop job {job_id} which is already in state: {status}")
            # Return 200 OK but indicate the job was already done/stopped
            return JSONResponse(status_code=200, content={"message": f"Job already in terminal state: {status}.", "job_id": job_id})

        # If queued or started, attempt to send the stop signal
        logger.info(f"Job {job_id} is in state {status}. Attempting to send stop signal.")
        message = f"Stop signal sent to job {job_id}."
        try:
            # Use RQ's official command sender
            send_stop_job_command(redis_conn, job.id)
            logger.info(f"Successfully sent stop signal command via RQ for job {job_id}.")
            # Optionally update meta immediately to reflect stopping attempt?
            # job.meta['status_override'] = 'stopping'
            # job.save_meta()
        except Exception as sig_err:
            # Log the error but proceed; signal sending is best-effort. Worker needs to handle it.
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


# --- REMOVE OLD remove_staged_job Endpoint ---
# @router.delete("/remove_staged_job/{staged_job_id}", ...) <-- DELETE THIS FUNCTION


# +++ ADD NEW remove_job Endpoint +++
@router.delete("/remove_job/{job_id}", status_code=200, summary="Remove Staged or RQ Job Data")
async def remove_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue) # Needed for RQ job fetching/deleting
):
    """
    Removes a job's data from Redis.
    Handles both 'staged_*' IDs (removing from Redis hash) and RQ job IDs
    (using job.delete() to remove from RQ's storage).
    """
    logger.info(f"Request received to remove job/data for ID: {job_id}")

    # --- Case 1: Handle Staged Jobs ---
    if job_id.startswith("staged_"):
        logger.info(f"Attempting to remove staged job '{job_id}' from hash '{STAGED_JOBS_KEY}'.")
        try:
            # hdel returns the number of fields removed (0 or 1)
            num_deleted = redis_conn.hdel(STAGED_JOBS_KEY, job_id.encode('utf-8'))

            if num_deleted == 1:
                logger.info(f"Successfully removed staged job: {job_id}")
                return JSONResponse(status_code=200, content={"message": f"Staged job '{job_id}' removed.", "removed_id": job_id})
            else:
                logger.warning(f"Staged job '{job_id}' not found in hash for removal.")
                # It might have been started or already removed. Consider 404.
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
            # Fetch the job first to see if it exists
            job = Job.fetch(job_id, connection=redis_conn, serializer=queue.serializer)

            # Delete the job data (main hash and from registries)
            # remove_from_registries=True is more thorough
            job.delete()

            logger.info(f"Successfully deleted RQ job '{job_id}' and associated data.")
            # Stop any active polling for this job ID if necessary (though frontend usually handles row removal)
            # Note: Backend doesn't track frontend polling state directly.
            return JSONResponse(status_code=200, content={"message": f"RQ Job '{job_id}' data removed.", "removed_id": job_id})

        except NoSuchJobError:
            logger.warning(f"RQ Job '{job_id}' not found for removal. It might have already expired or been deleted.")
            # Return 404 Not Found if the job doesn't exist in RQ
            raise HTTPException(status_code=404, detail=f"RQ Job '{job_id}' not found.")
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error removing RQ job {job_id}: {e}")
            raise HTTPException(status_code=503, detail="Service unavailable: Could not remove RQ job due to storage error.")
        except InvalidJobOperation as e:
            # This might occur if trying to delete a job that's currently running, depending on RQ version/config.
            # Decide how to handle this - maybe return a 409 Conflict? Or allow deletion?
            logger.warning(f"Invalid operation trying to remove RQ job {job_id} (possibly running?): {e}")
            # For now, let's report it as an error preventing removal.
            raise HTTPException(status_code=409, detail=f"Cannot remove job '{job_id}': Invalid operation (job might be active or locked).")
        except Exception as e:
            logger.exception(f"Unexpected error removing RQ job {job_id}.")
            raise HTTPException(status_code=500, detail="Internal server error removing RQ job.")
