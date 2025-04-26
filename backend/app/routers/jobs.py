# File: backend/app/routers/jobs.py
import logging
import json
import uuid
import time
import redis # Import redis exceptions
import os # Import os for cleanup
from pathlib import Path # Import Path
import tempfile
import csv
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

# RQ Imports
from rq import Queue, Worker
from rq.job import Job, JobStatus
from rq.exceptions import NoSuchJobError, InvalidJobOperation
# Need all registries for removal
from rq.registry import StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry, DeferredJobRegistry, ScheduledJobRegistry, CanceledJobRegistry # Added CanceledJobRegistry
from rq.command import send_stop_job_command

# App specific imports
from ..core.config import (
    STAGED_JOBS_KEY, DEFAULT_JOB_TIMEOUT,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL, MAX_REGISTRY_JOBS,
    SAREK_DEFAULT_PROFILE, SAREK_DEFAULT_TOOLS, SAREK_DEFAULT_STEP, SAREK_DEFAULT_ALIGNER,
    RESULTS_DIR, DATA_DIR,
    LOG_HISTORY_PREFIX # <<< Import LOG_HISTORY_PREFIX
)
from ..core.redis_rq import get_redis_connection, get_pipeline_queue
from ..models.pipeline import PipelineInput, SampleInfo, JobStatusDetails, JobResourceInfo
from ..utils.validation import validate_pipeline_input
from ..utils.time import dt_to_timestamp
from ..tasks import run_pipeline_task
# Import get_safe_path for resolving paths during rerun
from ..utils.files import get_safe_path


logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Jobs Management"]
)

# --- Job Staging and Control Routes ---
# (stage_pipeline_job and start_job remain unchanged)
@router.post("/run_pipeline", status_code=200, summary="Stage Pipeline Job")
async def stage_pipeline_job(
    input_data: PipelineInput,
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    logger.info(f"Received staging request for Sarek pipeline. Input type: {input_data.input_type}, Step: {input_data.step}, Samples: {len(input_data.samples)}")
    paths_map: Dict[str, Optional[Path]]
    validation_errors: List[str]
    paths_map, validation_errors = validate_pipeline_input(input_data)
    input_csv_path = paths_map.get("input_csv")
    if not input_csv_path and not any("At least one sample" in e for e in validation_errors):
        if "Internal server error: Could not create samplesheet." not in validation_errors and "Cannot generate samplesheet" not in validation_errors :
             validation_errors.append("Failed to generate samplesheet from provided sample data.")
    if validation_errors:
        if input_csv_path and input_csv_path.exists():
             try: os.remove(input_csv_path); logger.info(f"Cleaned up temporary CSV file due to validation errors: {input_csv_path}")
             except OSError as e: logger.warning(f"Could not clean up temporary CSV file {input_csv_path}: {e}")
        error_message = "Validation errors:\n" + "\n".join(f"- {error}" for error in validation_errors)
        logger.warning(f"Validation errors staging job: {error_message}")
        raise HTTPException(status_code=400, detail=error_message)
    if not isinstance(input_csv_path, Path):
         logger.error("Validation passed but input_csv_path is not a Path object. Aborting staging.")
         raise HTTPException(status_code=500, detail="Internal server error during job staging preparation.")
    logger.info(f"Input validation successful. Samplesheet: {input_csv_path}")
    try:
        staged_job_id = f"staged_{uuid.uuid4()}"
        input_filenames = { "intervals_file": input_data.intervals_file, "dbsnp": input_data.dbsnp, "known_indels": input_data.known_indels, "pon": input_data.pon }
        sample_info_list = [s.model_dump(exclude_unset=True) for s in input_data.samples]
        tools_str = ",".join(input_data.tools) if input_data.tools else None
        job_details = {
            "input_csv_path": str(input_csv_path), "intervals_path": str(paths_map["intervals"]) if paths_map.get("intervals") else None, "dbsnp_path": str(paths_map["dbsnp"]) if paths_map.get("dbsnp") else None,
            "known_indels_path": str(paths_map["known_indels"]) if paths_map.get("known_indels") else None, "pon_path": str(paths_map["pon"]) if paths_map.get("pon") else None, "outdir_base_path": str(RESULTS_DIR),
            "genome": input_data.genome, "tools": tools_str, "step": input_data.step, "profile": input_data.profile if input_data.profile is not None else SAREK_DEFAULT_PROFILE,
            "aligner": input_data.aligner if input_data.input_type == 'fastq' and input_data.aligner is not None else None, "joint_germline": input_data.joint_germline or False, "wes": input_data.wes or False,
            "trim_fastq": input_data.trim_fastq if input_data.input_type == 'fastq' else False, "skip_qc": input_data.skip_qc or False, "skip_annotation": input_data.skip_annotation if input_data.step != 'annotation' else False,
            "skip_baserecalibrator": input_data.skip_baserecalibrator if input_data.step not in ['variant_calling', 'annotation'] else False,
            "description": input_data.description or f"Sarek run ({len(input_data.samples)} samples, Genome: {input_data.genome}, Step: {input_data.step})", "staged_at": time.time(),
            "input_type": input_data.input_type, "input_filenames": input_filenames, "sample_info": sample_info_list
        }
        redis_conn.hset(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'), json.dumps(job_details).encode('utf-8'))
        logger.info(f"Staged Sarek job '{staged_job_id}' (Input: {input_data.input_type}, Step: {input_data.step}).")
        return JSONResponse(status_code=200, content={"message": "Job staged successfully.", "staged_job_id": staged_job_id})
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error staging job: {e}")
        if input_csv_path and input_csv_path.exists():
             try: os.remove(input_csv_path); logger.info(f"Cleaned up temporary CSV file due to Redis error: {input_csv_path}")
             except OSError as remove_e: logger.warning(f"Could not clean up temporary CSV file {input_csv_path} after Redis error: {remove_e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not stage job due to storage error.")
    except Exception as e:
         logger.exception(f"Unexpected error during job staging for input: {input_data}")
         if input_csv_path and input_csv_path.exists():
             try: os.remove(input_csv_path); logger.info(f"Cleaned up temporary CSV file due to unexpected error: {input_csv_path}")
             except OSError as remove_e: logger.warning(f"Could not clean up temporary CSV file {input_csv_path} after error: {remove_e}")
         raise HTTPException(status_code=500, detail="Internal server error during job staging.")


@router.post("/start_job/{staged_job_id}", status_code=202, summary="Enqueue Staged Job")
async def start_job(
    staged_job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    logger.info(f"Attempting to start job from staged ID: {staged_job_id}")
    job_details = None
    try:
        job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, staged_job_id.encode('utf-8'))
        if not job_details_bytes: logger.warning(f"Start job request failed: Staged job ID '{staged_job_id}' not found."); raise HTTPException(status_code=404, detail=f"Staged job '{staged_job_id}' not found.")
        try: job_details = json.loads(job_details_bytes.decode('utf-8'))
        except (json.JSONDecodeError, UnicodeDecodeError) as e: logger.error(f"Corrupted staged job data for {staged_job_id}: {e}. Removing entry."); redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8')); raise HTTPException(status_code=500, detail="Corrupted staged job data found. Please try staging again.")
        required_base_keys = ["input_csv_path", "outdir_base_path", "genome", "step"]
        if not all(key in job_details for key in required_base_keys): missing_keys = [key for key in required_base_keys if key not in job_details]; logger.error(f"Corrupted staged job data for {staged_job_id}: Missing required keys: {missing_keys}. Data: {job_details}"); redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8')); raise HTTPException(status_code=500, detail="Incomplete staged job data found. Please try staging again.")
        job_args = ( job_details["input_csv_path"], job_details["outdir_base_path"], job_details["genome"], job_details.get("tools"), job_details["step"], job_details.get("profile", SAREK_DEFAULT_PROFILE), job_details.get("intervals_path"), job_details.get("dbsnp_path"), job_details.get("known_indels_path"), job_details.get("pon_path"), job_details.get("aligner"), job_details.get("joint_germline", False), job_details.get("wes", False), job_details.get("trim_fastq", False), job_details.get("skip_qc", False), job_details.get("skip_annotation", False), job_details.get("skip_baserecalibrator", False), job_details.get("is_rerun", False), )
        try:
            rq_job_id = staged_job_id.replace("staged_", "running_")
            if rq_job_id == staged_job_id: rq_job_id = f"running_{uuid.uuid4()}"
            try:
                 # Use the queue's connection to check existence
                 existing_job = Job.fetch(rq_job_id, connection=queue.connection)
                 if existing_job:
                     logger.warning(f"RQ job {rq_job_id} already exists (Status: {existing_job.get_status()}). Generating new ID.")
                     rq_job_id = f"running_{uuid.uuid4()}"
            except NoSuchJobError:
                pass # Job ID is available
            job_meta_to_store = { "staged_job_id_origin": staged_job_id, "input_type": job_details.get("input_type"), "input_params": job_details.get("input_filenames"), "sarek_params": { "genome": job_details.get("genome"), "tools": job_details.get("tools"), "step": job_details.get("step"), "profile": job_details.get("profile"), "aligner": job_details.get("aligner"), "joint_germline": job_details.get("joint_germline", False), "wes": job_details.get("wes", False), "trim_fastq": job_details.get("trim_fastq", False), "skip_qc": job_details.get("skip_qc", False), "skip_annotation": job_details.get("skip_annotation", False), "skip_baserecalibrator": job_details.get("skip_baserecalibrator", False), }, "sample_info": job_details.get("sample_info"), "description": job_details.get("description"), "input_csv_path_used": job_details.get("input_csv_path"), "is_rerun_execution": job_details.get("is_rerun", False), "original_job_id": job_details.get("original_job_id"), }
            rq_job = queue.enqueue( run_pipeline_task, args=job_args, job_timeout=DEFAULT_JOB_TIMEOUT, result_ttl=DEFAULT_RESULT_TTL, failure_ttl=DEFAULT_FAILURE_TTL, job_id=rq_job_id, meta=job_meta_to_store )
            logger.info(f"Successfully enqueued job {rq_job.id} to RQ queue.")
        except Exception as e: logger.exception(f"Failed to enqueue job to RQ: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not enqueue job for execution.")
        try: redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id.encode('utf-8')); logger.info(f"Removed staged job entry {staged_job_id} after successful enqueue.")
        except redis.exceptions.RedisError as e: logger.warning(f"Could not remove staged job entry {staged_job_id} after enqueue: {e}")
        return JSONResponse( status_code=202, content={ "message": "Job enqueued for execution.", "job_id": rq_job.id, "status": "queued" } )
    except redis.exceptions.RedisError as e: logger.error(f"Redis error starting job: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not start job due to storage error.")
    except Exception as e: logger.exception(f"Unexpected error starting job {staged_job_id}"); raise HTTPException(status_code=500, detail="Internal server error during job start.")


# --- Job Listing and Status Routes ---
# (get_jobs_list and get_job_status remain unchanged)
@router.get("/jobs_list", response_model=List[Dict[str, Any]], summary="List All Relevant Jobs (Staged & RQ)")
async def get_jobs_list(
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    all_jobs_dict = {}
    # 1. Get Staged Jobs
    try:
        staged_jobs_raw = redis_conn.hgetall(STAGED_JOBS_KEY)
        for job_id_bytes, job_details_bytes in staged_jobs_raw.items():
            try:
                job_id = job_id_bytes.decode('utf-8'); details = json.loads(job_details_bytes.decode('utf-8'))
                staged_meta = { "input_type": details.get("input_type"), "input_params": details.get("input_filenames", {}), "sarek_params": { "genome": details.get("genome"), "tools": details.get("tools"), "step": details.get("step"), "profile": details.get("profile"), "aligner": details.get("aligner"), "joint_germline": details.get("joint_germline", False), "wes": details.get("wes", False), "trim_fastq": details.get("trim_fastq", False), "skip_qc": details.get("skip_qc", False), "skip_annotation": details.get("skip_annotation", False), "skip_baserecalibrator": details.get("skip_baserecalibrator", False), }, "sample_info": details.get("sample_info", []), "staged_job_id_origin": job_id, "description": details.get("description"), }
                all_jobs_dict[job_id] = { "id": job_id, "status": "staged", "description": details.get("description", f"Staged: {job_id[:8]}..."), "enqueued_at": None, "started_at": None, "ended_at": None, "result": None, "error": None, "meta": staged_meta, "staged_at": details.get("staged_at"), "resources": None }
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as e: logger.error(f"Error decoding/parsing staged job data for key {job_id_bytes}: {e}. Skipping entry.")
    except redis.exceptions.RedisError as e: logger.error(f"Redis error fetching staged jobs from '{STAGED_JOBS_KEY}': {e}")

    # 2. Get RQ Jobs
    registries_to_check = {
        "queued": queue, "started": StartedJobRegistry(queue=queue),
        "finished": FinishedJobRegistry(queue=queue), "failed": FailedJobRegistry(queue=queue),
        "canceled": CanceledJobRegistry(queue=queue),
    }
    rq_job_ids_to_fetch = set()
    for status_name, registry_or_queue in registries_to_check.items():
        try:
            job_ids = []
            if isinstance(registry_or_queue, (StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry, CanceledJobRegistry)):
                limit = MAX_REGISTRY_JOBS if status_name in ["finished", "failed", "canceled"] else -1
                total_count = registry_or_queue.count
                start_index = max(0, total_count - limit) if limit > 0 else 0
                end_index = total_count - 1
                if start_index <= end_index: job_ids = registry_or_queue.get_job_ids(start_index, end_index); job_ids.reverse()
            elif isinstance(registry_or_queue, Queue): job_ids = registry_or_queue.get_job_ids()
            else: logger.warning(f"Unsupported type for job fetching: {type(registry_or_queue)}"); continue
            if job_ids: rq_job_ids_to_fetch.update(job_ids)
        except redis.exceptions.RedisError as e: logger.error(f"Redis error fetching job IDs from {status_name}: {e}")
        except Exception as e: logger.exception(f"Unexpected error fetching job IDs from {status_name}.")

    if rq_job_ids_to_fetch:
        try:
            fetched_jobs = Job.fetch_many(list(rq_job_ids_to_fetch), connection=queue.connection, serializer=queue.serializer)
            for job in fetched_jobs:
                if job:
                    current_status = job.get_status(refresh=False); error_summary = None; job_meta = job.meta or {}
                    if current_status == JobStatus.FAILED:
                        error_summary = job_meta.get('error_message', "Job failed processing"); stderr_snippet = job_meta.get('stderr_snippet')
                        if error_summary == "Job failed processing" and job.exc_info: try: error_summary = job.exc_info.strip().split('\n')[-1]; except Exception: pass
                        if stderr_snippet: error_summary += f" (stderr: ...{stderr_snippet[-100:]})" # Show tail of snippet
                    resources = { "peak_memory_mb": job_meta.get("peak_memory_mb"), "average_cpu_percent": job_meta.get("average_cpu_percent"), "duration_seconds": job_meta.get("duration_seconds") }
                    if job.id not in all_jobs_dict or all_jobs_dict[job.id].get('status') != current_status:
                         all_jobs_dict[job.id] = { "id": job.id, "status": current_status, "description": job_meta.get("description") or job.description or f"RQ job {job.id[:12]}...", "enqueued_at": dt_to_timestamp(job.enqueued_at), "started_at": dt_to_timestamp(job.started_at), "ended_at": dt_to_timestamp(job.ended_at), "result": job.result, "error": error_summary, "meta": job_meta, "staged_at": None, "resources": resources if any(v is not None for v in resources.values()) else None }
        except redis.exceptions.RedisError as e: logger.error(f"Redis error during Job.fetch_many: {e}")
        except Exception as e: logger.exception("Unexpected error fetching RQ job details.")

    # 3. Sort Combined List
    try: all_jobs_list = sorted( all_jobs_dict.values(), key=lambda j: j.get('ended_at') or j.get('started_at') or j.get('enqueued_at') or j.get('staged_at') or 0, reverse=True )
    except Exception as e: logger.exception("Error sorting combined jobs list."); all_jobs_list = list(all_jobs_dict.values())

    # 4. Limit Finished/Failed/Canceled jobs
    if MAX_REGISTRY_JOBS > 0:
        final_list = []; terminal_count = 0
        for job_item in all_jobs_list:
             status = job_item.get('status', '').lower(); is_terminal = status in ['finished', 'failed', 'stopped', 'canceled']
             if is_terminal:
                 if terminal_count < MAX_REGISTRY_JOBS: final_list.append(job_item); terminal_count += 1
             else: final_list.append(job_item)
        all_jobs_list = final_list

    return all_jobs_list


@router.get("/job_status/{job_id}", response_model=JobStatusDetails, summary="Get RQ Job Status and Details")
async def get_job_status(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    logger.debug(f"Fetching status for job ID: {job_id}")
    try:
        if not job_id.startswith("staged_"):
            try:
                job = Job.fetch(job_id, connection=queue.connection, serializer=queue.serializer); status = job.get_status(refresh=False)
                result = None; meta_data = job.meta or {}; error_info_summary = None
                try:
                    if status == JobStatus.FINISHED: result = job.result
                    elif status == JobStatus.FAILED:
                        error_info_summary = meta_data.get('error_message', "Job failed processing"); stderr_snippet = meta_data.get('stderr_snippet')
                        if error_info_summary == "Job failed processing" and job.exc_info: try: error_info_summary = job.exc_info.strip().split('\n')[-1]; except Exception: pass
                        if stderr_snippet: error_info_summary += f" (stderr: ...{stderr_snippet[-100:]})"
                except Exception as e: logger.exception(f"Error accessing result/error info for job {job_id} (status: {status})."); error_info_summary = error_info_summary or "Could not retrieve job result/error details."
                resource_stats = {"peak_memory_mb": meta_data.get("peak_memory_mb"), "average_cpu_percent": meta_data.get("average_cpu_percent"), "duration_seconds": meta_data.get("duration_seconds")}
                return JobStatusDetails(job_id=job.id, status=status, description=meta_data.get("description") or job.description, enqueued_at=dt_to_timestamp(job.enqueued_at), started_at=dt_to_timestamp(job.started_at), ended_at=dt_to_timestamp(job.ended_at), result=result, error=error_info_summary, meta=meta_data, resources=JobResourceInfo(**resource_stats) if any(v is not None for v in resource_stats.values()) else None)
            except NoSuchJobError: logger.warning(f"RQ Job ID '{job_id}' not found.")
            except redis.exceptions.RedisError as e: logger.error(f"Redis error fetching RQ job {job_id}: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to status backend.")
            except Exception as e: logger.exception(f"Unexpected error fetching or refreshing RQ job {job_id}."); raise HTTPException(status_code=500, detail="Internal server error fetching job status.")
        if job_id.startswith("staged_"):
            try:
                 staged_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id.encode('utf-8'))
                 if staged_details_bytes:
                     logger.info(f"Job ID {job_id} corresponds to a currently staged job.")
                     try:
                         details = json.loads(staged_details_bytes.decode('utf-8'))
                         staged_meta = { "input_type": details.get("input_type"), "input_params": details.get("input_filenames", {}), "sarek_params": { "genome": details.get("genome"), "tools": details.get("tools"), "step": details.get("step"), "profile": details.get("profile"), "aligner": details.get("aligner"), "joint_germline": details.get("joint_germline", False), "wes": details.get("wes", False), "trim_fastq": details.get("trim_fastq", False), "skip_qc": details.get("skip_qc", False), "skip_annotation": details.get("skip_annotation", False), "skip_baserecalibrator": details.get("skip_baserecalibrator", False), }, "sample_info": details.get("sample_info", []), "staged_job_id_origin": job_id, "description": details.get("description"), }
                         return JobStatusDetails( job_id=job_id, status="staged", description=details.get("description"), enqueued_at=None, started_at=None, ended_at=None, result=None, error=None, meta=staged_meta, resources=None )
                     except (json.JSONDecodeError, UnicodeDecodeError, TypeError) as parse_err: logger.error(f"Error parsing staged job details for {job_id} in status check: {parse_err}")
                 else: logger.warning(f"Staged job ID '{job_id}' not found in Redis hash.")
            except redis.exceptions.RedisError as e: logger.error(f"Redis error checking staged status for {job_id}: {e}")
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    except HTTPException as http_exc: raise http_exc
    except Exception as e: logger.exception(f"Unexpected error in get_job_status for {job_id}."); raise HTTPException(status_code=500, detail="Internal server error retrieving job status.")


# (stop_job remains unchanged)
@router.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued RQ Job")
async def stop_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection), # Use standard connection
    queue: Queue = Depends(get_pipeline_queue) # Inject queue
):
    if job_id.startswith("staged_"):
        raise HTTPException(status_code=400, detail="Cannot stop a 'staged' job. Remove it instead.")

    logger.info(f"Received request to stop/cancel RQ job: {job_id}")
    message = f"Action processed for job {job_id}." # Default message

    try:
        job = Job.fetch(job_id, connection=queue.connection, serializer=queue.serializer); status = job.get_status(refresh=True)
        if job.is_finished or job.is_failed or job.is_stopped or job.is_canceled:
            logger.warning(f"Attempted to stop/cancel job {job_id} which is already in terminal state: {status}"); message = f"Job already in terminal state: {status}."
        elif status == JobStatus.QUEUED:
            logger.info(f"Job {job_id} is queued. Attempting to cancel...")
            try: job.cancel(); logger.info(f"Successfully canceled queued job {job_id}."); message = f"Queued job {job_id} canceled successfully."
            except Exception as cancel_err: logger.error(f"Failed to cancel queued job {job_id}: {cancel_err}"); message = f"Failed to cancel queued job {job_id}."
        elif status == JobStatus.STARTED or status == JobStatus.RUNNING:
            logger.info(f"Job {job_id} is {status}. Attempting to send stop signal...")
            try:
                redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False)
                send_stop_job_command(redis_conn_bytes, job.id); logger.info(f"Successfully sent stop signal command via RQ for job {job_id}."); message = f"Stop signal sent to job {job_id}."
            except Exception as sig_err: logger.warning(f"Could not send stop signal command via RQ for job {job_id}. Worker may not stop immediately. Error: {sig_err}"); message = f"Stop signal attempted for job {job_id} (check worker logs)."
        else: logger.warning(f"Job {job_id} has unexpected status '{status}', cannot stop/cancel."); message = f"Job {job_id} has status '{status}', cannot stop/cancel."
        return JSONResponse(status_code=200, content={"message": message, "job_id": job_id})
    except NoSuchJobError: logger.warning(f"Stop/cancel job request failed: Job ID '{job_id}' not found."); raise HTTPException(status_code=404, detail=f"Cannot stop/cancel job: Job '{job_id}' not found.")
    except redis.exceptions.RedisError as e: logger.error(f"Redis error interacting with job {job_id} for stopping/canceling: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to job backend.")
    except Exception as e: logger.exception(f"Unexpected error stopping/canceling job {job_id}."); raise HTTPException(status_code=500, detail="Internal server error attempting to stop/cancel job.")


@router.delete("/remove_job/{job_id}", status_code=200, summary="Remove Staged or RQ Job Data")
async def remove_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    logger.info(f"Request received to remove job/data for ID: {job_id}")
    csv_path_to_remove = None
    job_removed = False
    log_history_key = f"{LOG_HISTORY_PREFIX}{job_id}" # Define log history key

    if job_id.startswith("staged_"):
        logger.info(f"Attempting to remove staged job '{job_id}' from hash '{STAGED_JOBS_KEY}'.")
        try:
            job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id.encode('utf-8'))
            if job_details_bytes:
                try: details = json.loads(job_details_bytes.decode('utf-8')); csv_path_to_remove = details.get("input_csv_path"); logger.debug(f"Identified potential CSV path for staged job {job_id}: {csv_path_to_remove}")
                except (json.JSONDecodeError, UnicodeDecodeError, TypeError) as parse_err: logger.warning(f"Could not parse details for staged job {job_id} during removal, cannot identify CSV. Error: {parse_err}")
            else: logger.warning(f"Staged job '{job_id}' not found in hash for removal."); raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found.")

            num_deleted = redis_conn.hdel(STAGED_JOBS_KEY, job_id.encode('utf-8'))
            if num_deleted == 1: logger.info(f"Successfully removed staged job entry: {job_id}"); job_removed = True
            else:
                logger.warning(f"Staged job '{job_id}' disappeared before hdel could complete.")
                if not redis_conn.hexists(STAGED_JOBS_KEY, job_id.encode('utf-8')): job_removed = True
                else: logger.error(f"Inconsistent state removing staged job {job_id}. HDEL returned 0 but job still exists?"); raise HTTPException(status_code=500, detail="Inconsistent state during job removal.")
        except redis.exceptions.RedisError as e: logger.error(f"Redis error removing staged job {job_id}: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not remove job due to storage error.")
        except HTTPException as e: raise e
        except Exception as e: logger.exception(f"Unexpected error during staged job removal for {job_id}."); raise HTTPException(status_code=500, detail="Internal server error removing staged job.")
    else:
        # Handle RQ Job Removal
        logger.info(f"Attempting to remove RQ job '{job_id}' data.")
        job = None
        try:
            try: job = Job.fetch(job_id, connection=queue.connection, serializer=queue.serializer); logger.debug(f"Fetched RQ job {job_id} successfully.")
            except NoSuchJobError: logger.warning(f"RQ Job '{job_id}' not found for removal."); raise HTTPException(status_code=404, detail=f"RQ Job '{job_id}' not found.")
            except Exception as fetch_err: logger.error(f"Error fetching job {job_id}: {fetch_err}"); raise HTTPException(status_code=500, detail=f"Could not fetch job {job_id} for removal")

            if job.meta: csv_path_to_remove = job.meta.get("input_csv_path_used") or job.meta.get("input_csv_path"); logger.debug(f"Identified potential CSV path for RQ job {job_id}: {csv_path_to_remove}")

            # 1. Remove from queue and registries FIRST
            try:
                logger.info(f"Attempting to remove job {job_id} from queue/registries..."); job.cancel()
                FinishedJobRegistry(queue=queue).remove(job, delete_job=False); FailedJobRegistry(queue=queue).remove(job, delete_job=False); CanceledJobRegistry(queue=queue).remove(job, delete_job=False)
                logger.info(f"Successfully removed/cancelled job {job_id} from relevant registries/queue.")
            except InvalidJobOperation as e: logger.debug(f"Job {job_id} might have already been removed from registries/queue or in unexpected state: {e}")
            except Exception as reg_remove_err: logger.warning(f"Error removing job {job_id} from registries/queue: {reg_remove_err}")

            # 2. Delete the job HASH itself
            try: job.delete(); logger.info(f"Successfully deleted RQ job hash for {job_id}"); job_removed = True
            except InvalidJobOperation as e: logger.warning(f"Invalid operation trying to delete RQ job hash for {job_id}: {e}."); raise HTTPException(status_code=409, detail=f"Cannot remove job '{job_id}': Invalid operation (job might be active or locked). Try stopping first.")
            except Exception as delete_err: logger.error(f"Error deleting job hash for {job_id}: {delete_err}"); raise HTTPException(status_code=500, detail=f"Could not delete job {job_id}")

        except HTTPException as e: raise e
        except redis.exceptions.RedisError as e: logger.error(f"Redis error removing RQ job {job_id}: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not remove RQ job due to storage error.")
        except Exception as e: logger.exception(f"Unexpected error during RQ job removal for {job_id}: {str(e)}"); raise HTTPException(status_code=500, detail=f"Internal server error removing RQ job: {str(e)}")

    # --- Cleanup CSV and Log History ---
    if job_removed:
        # Cleanup CSV
        if csv_path_to_remove:
            try:
                csv_path = Path(csv_path_to_remove)
                if csv_path.is_file() and csv_path.suffix == '.csv' and str(csv_path.parent).startswith(tempfile.gettempdir()):
                    os.remove(csv_path); logger.info(f"Cleaned up temporary CSV file for removed job {job_id}: {csv_path}")
                elif csv_path.exists(): logger.warning(f"Temporary CSV path '{csv_path_to_remove}' exists but not cleaned up for job {job_id}.")
                else: logger.debug(f"Temporary CSV path '{csv_path_to_remove}' not found. No cleanup needed for job {job_id}.")
            except Exception as e: logger.warning(f"Unexpected error during CSV cleanup for job {job_id}: {e}")

        # --- ADDED: Cleanup Log History List ---
        if not job_id.startswith("staged_"): # Don't cleanup history for staged jobs (they don't have one)
            try:
                deleted_count = redis_conn.delete(log_history_key)
                if deleted_count > 0:
                    logger.info(f"Cleaned up log history list for removed job {job_id}: {log_history_key}")
                else:
                    logger.debug(f"Log history list not found or already deleted for job {job_id}: {log_history_key}")
            except redis.exceptions.RedisError as e:
                logger.error(f"Redis error deleting log history list {log_history_key} for job {job_id}: {e}")
            except Exception as e:
                 logger.error(f"Unexpected error deleting log history list {log_history_key} for job {job_id}: {e}")
        # --- END ADDED ---

    if not job_removed:
        logger.error(f"Job removal process completed for {job_id}, but job_removed flag is false. Removal likely failed.")
        raise HTTPException(status_code=500, detail=f"Failed to remove job {job_id}.")

    return JSONResponse(status_code=200, content={"message": f"Successfully removed job {job_id}.", "removed_id": job_id})


# (rerun_job remains unchanged)
@router.post("/rerun_job/{job_id}", status_code=200, summary="Re-stage Failed/Finished Job")
async def rerun_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    if job_id.startswith("staged_"):
        raise HTTPException(status_code=400, detail="Cannot re-run a job that is still 'staged'. Start it first.")

    logger.info(f"Attempting to re-stage job based on RQ job: {job_id}")
    new_temp_csv_file_path = None # Initialize path variable

    try:
        # Fetch the original job using the queue's connection
        try: original_job = Job.fetch(job_id, connection=queue.connection, serializer=queue.serializer); logger.debug(f"Fetched original job {job_id} for re-staging.")
        except NoSuchJobError: logger.warning(f"Re-stage request failed: Original RQ job ID '{job_id}' not found."); raise HTTPException(status_code=404, detail=f"Original job '{job_id}' not found to re-stage.")

        if not original_job.meta: logger.error(f"Cannot re-stage job {job_id}: Original job metadata is missing."); raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Missing original parameters.")
        original_meta = original_job.meta; logger.debug(f"Original job metadata found for {job_id}")

        # Extract necessary parameters from metadata
        original_sarek_params = original_meta.get("sarek_params", {}); original_input_params = original_meta.get("input_params", {}); original_sample_info = original_meta.get("sample_info", [])
        original_description = original_meta.get("description", f"Sarek run"); original_input_type = original_meta.get("input_type"); original_step = original_sarek_params.get("step")

        if not original_input_type or not original_step: logger.error(f"Missing input_type ('{original_input_type}') or step ('{original_step}') in original metadata for job {job_id}"); raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Original input type or step missing from metadata.")
        if not original_sample_info: logger.error(f"Missing sample_info in original metadata for job {job_id}"); raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Original sample info missing from metadata.")

        # Recreate Samplesheet with ABSOLUTE Paths
        logger.info(f"Recreating samplesheet for input type: {original_input_type} with absolute paths."); new_sample_rows_for_csv = []; csv_headers = []; validation_errors_rerun = []
        try:
            if original_input_type == "fastq": csv_headers = ['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2']
            elif original_input_type == "bam_cram":
                first_file_rel = original_sample_info[0].get('bam_cram') if original_sample_info else None;
                if not first_file_rel: raise ValueError("Missing bam_cram path in first sample for BAM/CRAM re-stage.")
                bam_cram_col = 'cram' if first_file_rel.lower().endswith('.cram') else 'bam'; csv_headers = ['patient', 'sample', 'sex', 'status', bam_cram_col, 'index']
            elif original_input_type == "vcf": csv_headers = ['patient', 'sample', 'sex', 'status', 'vcf', 'index']
            else: raise ValueError(f"Unknown original input type '{original_input_type}'.")

            for i, sample_data in enumerate(original_sample_info):
                row_dict = {}; for key in ['patient', 'sample', 'sex', 'status']: row_dict[key] = sample_data[key]
                def resolve_and_validate(relative_path_key: str, is_required: bool, allowed_suffixes: Optional[List[str]] = None) -> Optional[str]:
                    relative_path = sample_data.get(relative_path_key)
                    if not relative_path:
                        if is_required: validation_errors_rerun.append(f"Sample {i+1}: Missing required field '{relative_path_key}' in original metadata."); return None
                    try:
                        absolute_path = get_safe_path(DATA_DIR, relative_path)
                        if not absolute_path.is_file(): validation_errors_rerun.append(f"Sample {i+1}: File for '{relative_path_key}' ('{relative_path}') not found at resolved path {absolute_path}."); return None
                        if allowed_suffixes and absolute_path.suffix.lower() not in [s.lower() for s in allowed_suffixes] and not any(absolute_path.name.lower().endswith(s.lower()) for s in allowed_suffixes): validation_errors_rerun.append(f"Sample {i+1}: File for '{relative_path_key}' ('{relative_path}') has invalid suffix. Allowed: {', '.join(allowed_suffixes)}"); return None
                        return str(absolute_path)
                    except HTTPException as e: validation_errors_rerun.append(f"Sample {i+1}: Error validating path for '{relative_path_key}' ('{relative_path}'): {e.detail}"); return None
                    except Exception as e: logger.error(f"Unexpected error resolving path for {relative_path_key} ('{relative_path}') in sample {i+1}: {e}"); validation_errors_rerun.append(f"Sample {i+1}: Internal error resolving path for '{relative_path_key}'."); return None
                if original_input_type == "fastq":
                    row_dict['lane'] = sample_data.get('lane');
                    if not row_dict['lane']: validation_errors_rerun.append(f"Sample {i+1}: Missing 'lane'.")
                    row_dict['fastq_1'] = resolve_and_validate('fastq_1', True, ['.fq.gz', '.fastq.gz', '.fq', '.fastq']); row_dict['fastq_2'] = resolve_and_validate('fastq_2', True, ['.fq.gz', '.fastq.gz', '.fq', '.fastq'])
                elif original_input_type == "bam_cram":
                    row_dict[bam_cram_col] = resolve_and_validate('bam_cram', True, ['.bam', '.cram']); row_dict['index'] = resolve_and_validate('index', False, ['.bai', '.crai'])
                    if row_dict[bam_cram_col] and row_dict[bam_cram_col].lower().endswith('.cram') and not row_dict['index']: validation_errors_rerun.append(f"Sample {i+1}: CRAM file requires a corresponding index file (.crai).")
                elif original_input_type == "vcf":
                    row_dict['vcf'] = resolve_and_validate('vcf', True, ['.vcf', '.vcf.gz']); row_dict['index'] = resolve_and_validate('index', False, ['.tbi', '.csi'])
                    if row_dict['vcf'] and row_dict['vcf'].lower().endswith('.vcf.gz') and not row_dict['index']: validation_errors_rerun.append(f"Sample {i+1}: Compressed VCF (.vcf.gz) requires a corresponding index file (.tbi/.csi).")
                new_sample_rows_for_csv.append([row_dict.get(h) for h in csv_headers])
            if validation_errors_rerun: error_message = "Cannot re-stage job: Errors found validating original file paths:\n" + "\n".join(f"- {e}" for e in validation_errors_rerun); logger.error(error_message); raise HTTPException(status_code=400, detail=error_message)
        except ValueError as sample_err: logger.error(f"Error processing sample structure during re-stage of {job_id}: {sample_err}"); raise HTTPException(status_code=400, detail=f"Cannot re-stage: Incomplete or invalid sample data structure in original job {job_id}.")
        except Exception as sample_err: logger.exception(f"Unexpected error processing sample data during re-stage of {job_id}: {sample_err}"); raise HTTPException(status_code=500, detail="Error processing original sample data for re-run.")

        try:
            with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv: csv_writer = csv.writer(temp_csv); csv_writer.writerow(csv_headers); csv_writer.writerows(new_sample_rows_for_csv); new_temp_csv_file_path = temp_csv.name
            logger.info(f"Created new temporary samplesheet for re-run with absolute paths: {new_temp_csv_file_path}")
        except (OSError, csv.Error) as e: logger.error(f"Failed to create new temporary samplesheet for re-run of {job_id}: {e}"); raise HTTPException(status_code=500, detail="Internal server error: Could not create samplesheet for re-run.")

        def get_original_optional_file_path_str(key):
            filename = original_input_params.get(key);
            if not filename: return None
            try:
                full_path = (DATA_DIR / filename).resolve();
                if os.path.commonpath([DATA_DIR.resolve(), full_path.resolve()]) == str(DATA_DIR.resolve()) and full_path.is_file(): return str(full_path)
                else: logger.warning(f"Optional file '{filename}' (resolved: {full_path}) for key '{key}' not found or invalid during re-stage of {job_id}. Setting to None."); return None
            except Exception as e: logger.warning(f"Error resolving optional file path '{filename}' for key '{key}' during re-stage of {job_id}: {e}. Setting to None."); return None
        intervals_path = get_original_optional_file_path_str("intervals_file"); dbsnp_path = get_original_optional_file_path_str("dbsnp"); known_indels_path = get_original_optional_file_path_str("known_indels"); pon_path = get_original_optional_file_path_str("pon")
        new_staged_job_id = f"staged_{uuid.uuid4()}"
        new_job_details = { "input_csv_path": new_temp_csv_file_path, "intervals_path": intervals_path, "dbsnp_path": dbsnp_path, "known_indels_path": known_indels_path, "pon_path": pon_path, "outdir_base_path": str(RESULTS_DIR), "genome": original_sarek_params.get("genome"), "tools": original_sarek_params.get("tools"), "step": original_step, "profile": original_sarek_params.get("profile", SAREK_DEFAULT_PROFILE), "aligner": original_sarek_params.get("aligner"), "joint_germline": original_sarek_params.get("joint_germline", False), "wes": original_sarek_params.get("wes", False), "trim_fastq": original_sarek_params.get("trim_fastq", False), "skip_qc": original_sarek_params.get("skip_qc", False), "skip_annotation": original_sarek_params.get("skip_annotation", False), "skip_baserecalibrator": original_sarek_params.get("skip_baserecalibrator", False), "description": f"Re-run of job {job_id} ({original_description})", "staged_at": time.time(), "input_type": original_input_type, "input_filenames": original_input_params, "sample_info": original_sample_info, "is_rerun": True, "original_job_id": job_id, }
        redis_conn.hset(STAGED_JOBS_KEY, new_staged_job_id.encode('utf-8'), json.dumps(new_job_details).encode('utf-8'))
        logger.info(f"Created new staged job {new_staged_job_id} for re-run of {job_id}")

        return JSONResponse( status_code=200, content={ "message": f"Job {job_id} re-staged successfully as {new_staged_job_id}. Please start the new job.", "staged_job_id": new_staged_job_id } )
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error during job re-stage for {job_id}: {e}")
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): try: os.remove(new_temp_csv_file_path); except OSError: logger.warning(f"Failed to cleanup temp CSV {new_temp_csv_file_path} after Redis error.")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not access job storage.")
    except HTTPException as e:
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): try: os.remove(new_temp_csv_file_path); except OSError: logger.warning(f"Failed to cleanup temp CSV {new_temp_csv_file_path} after HTTP error.")
        raise e
    except Exception as e:
        logger.exception(f"Unexpected error during job re-stage for {job_id}: {e}")
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): try: os.remove(new_temp_csv_file_path); except OSError: logger.warning(f"Failed to cleanup temp CSV {new_temp_csv_file_path} after unexpected error.")
        raise HTTPException(status_code=500, detail="Internal server error during job re-stage.")
