# backend/app/routers/jobs.py
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
from rq.registry import StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry
from rq.command import send_stop_job_command

# App specific imports
from ..core.config import (
    STAGED_JOBS_KEY, DEFAULT_JOB_TIMEOUT,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL, MAX_REGISTRY_JOBS,
    SAREK_DEFAULT_PROFILE, SAREK_DEFAULT_TOOLS, SAREK_DEFAULT_STEP, SAREK_DEFAULT_ALIGNER,
    RESULTS_DIR, DATA_DIR
)
from ..core.redis_rq import get_redis_connection, get_pipeline_queue
from ..models.pipeline import PipelineInput, SampleInfo, JobStatusDetails, JobResourceInfo
from ..utils.validation import validate_pipeline_input
from ..utils.time import dt_to_timestamp
from ..tasks import run_pipeline_task

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Jobs Management"]
)

# --- Job Staging and Control Routes ---

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
                 existing_job = Job.fetch(rq_job_id, connection=redis_conn)
                 if existing_job:
                     logger.warning(f"RQ job {rq_job_id} already exists (Status: {existing_job.get_status()}). Generating new ID.")
                     rq_job_id = f"running_{uuid.uuid4()}"
            except NoSuchJobError:
                pass
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
    registries_to_check = { "queued": queue, "started": StartedJobRegistry(queue=queue), "finished": FinishedJobRegistry(queue=queue), "failed": FailedJobRegistry(queue=queue), }
    rq_job_ids_to_fetch = set()
    for status_name, registry_or_queue in registries_to_check.items():
        try:
            job_ids = []
            limit = MAX_REGISTRY_JOBS if status_name in ["finished", "failed"] else -1
            if isinstance(registry_or_queue, Queue):
                job_ids = registry_or_queue.get_job_ids()
            # --- THIS BLOCK IS NOW CORRECTED ---
            elif isinstance(registry_or_queue, (StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry)):
                total_count = registry_or_queue.count
                start_index = max(0, total_count - limit) if limit > 0 else 0
                end_index = total_count - 1
                if start_index <= end_index:
                     job_ids = registry_or_queue.get_job_ids(start_index, end_index)
                     job_ids.reverse()
            # --- END CORRECTION ---
            else:
                 logger.warning(f"Unsupported type for job fetching: {type(registry_or_queue)}")
                 continue
            if job_ids:
                 rq_job_ids_to_fetch.update(job_ids)
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error fetching job IDs from {status_name} registry/queue: {e}")
        except Exception as e:
            logger.exception(f"Unexpected error fetching job IDs from {status_name} registry/queue.")

    if rq_job_ids_to_fetch:
        try:
            redis_conn_bytes = redis.Redis( host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False )
            fetched_jobs = Job.fetch_many(list(rq_job_ids_to_fetch), connection=redis_conn_bytes, serializer=queue.serializer)
            for job in fetched_jobs:
                if job:
                    job.refresh()
                    current_status = job.get_status(refresh=False)
                    error_summary = None
                    job_meta = job.meta or {}
                    if current_status == JobStatus.FAILED:
                        error_summary = job_meta.get('error_message', "Job failed processing")
                        stderr_snippet = job_meta.get('stderr_snippet')
                        if error_summary == "Job failed processing" and job.exc_info:
                            try: error_summary = job.exc_info.strip().split('\n')[-1]
                            except Exception: pass
                        if stderr_snippet: error_summary += f" (stderr: {stderr_snippet}...)"
                    resources = { "peak_memory_mb": job_meta.get("peak_memory_mb"), "average_cpu_percent": job_meta.get("average_cpu_percent"), "duration_seconds": job_meta.get("duration_seconds") }
                    if job.id not in all_jobs_dict or all_jobs_dict[job.id].get('status') == 'staged':
                         all_jobs_dict[job.id] = { "id": job.id, "status": current_status, "description": job_meta.get("description") or job.description or f"RQ job {job.id[:12]}...", "enqueued_at": dt_to_timestamp(job.enqueued_at), "started_at": dt_to_timestamp(job.started_at), "ended_at": dt_to_timestamp(job.ended_at), "result": job.result, "error": error_summary, "meta": job_meta, "staged_at": None, "resources": resources if any(v is not None for v in resources.values()) else None }
        except redis.exceptions.RedisError as e: logger.error(f"Redis error during Job.fetch_many: {e}")
        except Exception as e: logger.exception("Unexpected error fetching RQ job details.")

    # 3. Sort Combined List
    try: all_jobs_list = sorted( all_jobs_dict.values(), key=lambda j: j.get('ended_at') or j.get('started_at') or j.get('enqueued_at') or j.get('staged_at') or 0, reverse=True )
    except Exception as e: logger.exception("Error sorting combined jobs list."); all_jobs_list = list(all_jobs_dict.values())

    # 4. Limit Finished/Failed jobs
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
                 final_list.append(job_item)
        all_jobs_list = final_list

    return all_jobs_list


@router.get("/job_status/{job_id}", response_model=JobStatusDetails, summary="Get RQ Job Status and Details")
async def get_job_status(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    # ... (get_job_status logic - unchanged, includes previous fix) ...
    logger.debug(f"Fetching status for job ID: {job_id}")
    try:
        if not job_id.startswith("staged_"):
            try:
                redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False)
                job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
                job.refresh()
                status = job.get_status(refresh=False)
                result = None
                meta_data = job.meta or {}
                error_info_summary = None
                try:
                    if status == JobStatus.FINISHED: result = job.result
                    elif status == JobStatus.FAILED: error_info_summary = meta_data.get('error_message', "Job failed processing"); stderr_snippet = meta_data.get('stderr_snippet'); if error_info_summary == "Job failed processing" and job.exc_info: try: error_info_summary = job.exc_info.strip().split('\n')[-1]; except Exception: pass; if stderr_snippet: error_info_summary += f" (stderr: {stderr_snippet}...)"
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


@router.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued RQ Job")
async def stop_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    # ... (stop_job logic - unchanged) ...
     if job_id.startswith("staged_"): raise HTTPException(status_code=400, detail="Cannot stop a 'staged' job. Remove it instead.")
     logger.info(f"Received request to stop RQ job: {job_id}")
     try:
         redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False)
         job = Job.fetch(job_id, connection=redis_conn_bytes); status = job.get_status(refresh=True)
         if job.is_finished or job.is_failed or job.is_stopped or job.is_canceled: logger.warning(f"Attempted to stop job {job_id} which is already in state: {status}"); return JSONResponse(status_code=200, content={"message": f"Job already in terminal state: {status}.", "job_id": job_id})
         logger.info(f"Job {job_id} is in state {status}. Attempting to send stop signal.")
         message = f"Stop signal sent to job {job_id}."
         try: send_stop_job_command(redis_conn_bytes, job.id); logger.info(f"Successfully sent stop signal command via RQ for job {job_id}.")
         except Exception as sig_err: logger.warning(f"Could not send stop signal command via RQ for job {job_id}. Worker may not stop immediately. Error: {sig_err}"); message = f"Stop signal attempted for job {job_id} (check worker logs)."
         return JSONResponse(status_code=200, content={"message": message, "job_id": job_id})
     except NoSuchJobError: logger.warning(f"Stop job request failed: Job ID '{job_id}' not found."); raise HTTPException(status_code=404, detail=f"Cannot stop job: Job '{job_id}' not found.")
     except redis.exceptions.RedisError as e: logger.error(f"Redis error interacting with job {job_id} for stopping: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to job backend.")
     except Exception as e: logger.exception(f"Unexpected error stopping job {job_id}."); raise HTTPException(status_code=500, detail="Internal server error attempting to stop job.")


@router.delete("/remove_job/{job_id}", status_code=200, summary="Remove Staged or RQ Job Data")
async def remove_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    # ... (remove_job logic - unchanged) ...
    logger.info(f"Request received to remove job/data for ID: {job_id}")
    csv_path_to_remove = None
    if job_id.startswith("staged_"):
        logger.info(f"Attempting to remove staged job '{job_id}' from hash '{STAGED_JOBS_KEY}'.")
        try:
            job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id.encode('utf-8'))
            if job_details_bytes: try: details = json.loads(job_details_bytes.decode('utf-8')); csv_path_to_remove = details.get("input_csv_path"); except (json.JSONDecodeError, UnicodeDecodeError): logger.warning(f"Could not parse details for staged job {job_id} during removal, cannot identify CSV.")
            num_deleted = redis_conn.hdel(STAGED_JOBS_KEY, job_id.encode('utf-8'))
            if num_deleted == 1: logger.info(f"Successfully removed staged job entry: {job_id}")
            else: logger.warning(f"Staged job '{job_id}' not found in hash for removal."); raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found.")
        except redis.exceptions.RedisError as e: logger.error(f"Redis error removing staged job {job_id}: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not remove job due to storage error.")
        except HTTPException as e: raise e
        except Exception as e: logger.exception(f"Unexpected error during staged job removal check for {job_id}."); raise HTTPException(status_code=500, detail="Internal server error removing staged job.")
    else:
        logger.info(f"Attempting to remove RQ job '{job_id}' data.")
        try:
             redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False, socket_timeout=5, socket_connect_timeout=5)
             try: job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer);
             except NoSuchJobError: logger.warning(f"RQ Job '{job_id}' not found for removal."); raise HTTPException(status_code=404, detail=f"RQ Job '{job_id}' not found.")
             except Exception as fetch_err: logger.error(f"Error fetching job {job_id}: {fetch_err}"); raise HTTPException(status_code=500, detail=f"Could not fetch job {job_id} for removal")
             if not job: raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
             if job and job.meta: csv_path_to_remove = job.meta.get("input_csv_path_used") or job.meta.get("input_csv_path")
             try: job_status = job.get_status()
             except Exception as status_err: logger.error(f"Error getting status for job {job_id}: {status_err}"); job_status = None
             if job_status == 'started': try: logger.info(f"Sending stop signal to running job {job_id} before removal"); send_stop_job_command(redis_conn_bytes, job.id); time.sleep(1); except Exception as stop_err: logger.warning(f"Could not stop running job {job_id} before removal: {stop_err}")
             registries = [ queue, StartedJobRegistry(queue=queue), FinishedJobRegistry(queue=queue), FailedJobRegistry(queue=queue), ]
             for reg in registries:
                 try: reg.remove(job); logger.debug(f"Removed job {job_id} from registry {type(reg).__name__}")
                 except (InvalidJobOperation, ValueError, TypeError) as reg_err: logger.debug(f"Job {job_id} not found or error removing from {type(reg).__name__}: {reg_err}")
                 except Exception as reg_err: logger.warning(f"Unexpected error removing job {job_id} from registry {type(reg).__name__}: {reg_err}")
             try: job.delete(); logger.info(f"Successfully deleted RQ job data for {job_id}")
             except InvalidJobOperation as e: logger.warning(f"Invalid operation trying to delete RQ job {job_id}: {e}"); raise HTTPException(status_code=409, detail=f"Cannot remove job '{job_id}': Invalid operation (job might be active or locked). Try stopping first.")
             except Exception as delete_err: logger.error(f"Error deleting job {job_id}: {delete_err}"); raise HTTPException(status_code=500, detail=f"Could not delete job {job_id}")
        except HTTPException as e: raise e
        except redis.exceptions.RedisError as e: logger.error(f"Redis error removing RQ job {job_id}: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not remove RQ job due to storage error.")
        except Exception as e: logger.exception(f"Unexpected error during RQ job removal for {job_id}: {str(e)}"); raise HTTPException(status_code=500, detail=f"Internal server error removing RQ job: {str(e)}")
    if csv_path_to_remove:
        try:
            csv_path = Path(csv_path_to_remove)
            if csv_path.exists() and csv_path.is_file() and csv_path.suffix == '.csv': os.remove(csv_path); logger.info(f"Cleaned up temporary CSV file for removed job {job_id}: {csv_path}")
            else: logger.warning(f"Temporary CSV path {csv_path} not found, invalid, or not a CSV for removal associated with job {job_id}.")
        except OSError as e: logger.warning(f"Could not clean up temporary CSV file {csv_path_to_remove} for job {job_id}: {e}")
        except Exception as e: logger.warning(f"Unexpected error during CSV cleanup for job {job_id}: {e}")
    return JSONResponse(status_code=200, content={"message": f"Successfully removed job {job_id}.", "removed_id": job_id})


@router.post("/rerun_job/{job_id}", status_code=202, summary="Re-stage Failed/Finished Job")
async def rerun_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    # ... (rerun_job logic - unchanged) ...
    if job_id.startswith("staged_"): raise HTTPException(status_code=400, detail="Cannot re-run a job that is still 'staged'. Start it first.")
    logger.info(f"Attempting to re-stage job based on RQ job: {job_id}")
    new_temp_csv_file_path = None
    try:
        redis_conn_bytes = redis.Redis( host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False )
        try: original_job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
        except NoSuchJobError: logger.warning(f"Re-stage request failed: Original RQ job ID '{job_id}' not found."); raise HTTPException(status_code=404, detail=f"Original job '{job_id}' not found to re-stage.")
        if not original_job.meta: logger.error(f"Cannot re-stage job {job_id}: Original job metadata is missing."); raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Missing original parameters.")
        original_meta = original_job.meta
        original_sarek_params = original_meta.get("sarek_params", {})
        original_input_params = original_meta.get("input_params", {})
        original_sample_info = original_meta.get("sample_info", [])
        original_description = original_meta.get("description", f"Sarek run")
        original_input_type = original_meta.get("input_type")
        original_step = original_sarek_params.get("step")
        if not original_input_type or not original_step: raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Original input type or step missing from metadata.")
        if not original_sample_info: raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Original sample info missing from metadata.")
        new_sample_rows_for_csv = []
        csv_headers = []
        if original_input_type == "fastq": csv_headers = ['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2']; for sample_data in original_sample_info: if not all(k in sample_data for k in ['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2']): raise HTTPException(status_code=400, detail=f"Cannot re-stage: Incomplete sample data in original job {job_id} for FASTQ input."); new_sample_rows_for_csv.append([ sample_data.get('patient'), sample_data.get('sample'), sample_data.get('sex'), sample_data.get('status'), sample_data.get('lane'), sample_data.get('fastq_1'), sample_data.get('fastq_2') ])
        elif original_input_type == "bam_cram": first_file = original_sample_info[0].get('bam_cram') if original_sample_info else None; if not first_file: raise HTTPException(status_code=400, detail=f"Cannot re-stage: Missing bam_cram path in original job {job_id}."); bam_cram_col = 'cram' if first_file.endswith('.cram') else 'bam'; csv_headers = ['patient', 'sample', 'sex', 'status', bam_cram_col, 'index']; for sample_data in original_sample_info: if not all(k in sample_data for k in ['patient', 'sample', 'sex', 'status', 'bam_cram']): raise HTTPException(status_code=400, detail=f"Cannot re-stage: Incomplete sample data in original job {job_id} for BAM/CRAM input."); new_sample_rows_for_csv.append([ sample_data.get('patient'), sample_data.get('sample'), sample_data.get('sex'), sample_data.get('status'), sample_data.get('bam_cram'), sample_data.get('index') or '' ])
        elif original_input_type == "vcf": csv_headers = ['patient', 'sample', 'sex', 'status', 'vcf', 'index']; for sample_data in original_sample_info: if not all(k in sample_data for k in ['patient', 'sample', 'sex', 'status', 'vcf']): raise HTTPException(status_code=400, detail=f"Cannot re-stage: Incomplete sample data in original job {job_id} for VCF input."); new_sample_rows_for_csv.append([ sample_data.get('patient'), sample_data.get('sample'), sample_data.get('sex'), sample_data.get('status'), sample_data.get('vcf'), sample_data.get('index') or '' ])
        else: raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Unknown original input type '{original_input_type}'.")
        try:
            with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv: csv_writer = csv.writer(temp_csv); csv_writer.writerow(csv_headers); csv_writer.writerows(new_sample_rows_for_csv); new_temp_csv_file_path = temp_csv.name; logger.info(f"Created new temporary samplesheet for re-run: {new_temp_csv_file_path}")
        except (OSError, csv.Error) as e: logger.error(f"Failed to create new temporary samplesheet for re-run of {job_id}: {e}"); raise HTTPException(status_code=500, detail="Internal server error: Could not create samplesheet for re-run.")
        def get_optional_path_str(key): file_name = original_input_params.get(key); if file_name: try: full_path = (DATA_DIR / file_name).resolve(); if DATA_DIR.resolve() in full_path.parents and full_path.is_file(): return str(full_path); else: logger.warning(f"Optional file '{file_name}' for key '{key}' not found or invalid during re-stage of {job_id}. Setting to None."); return None; except Exception as e: logger.warning(f"Error resolving optional file path '{file_name}' for key '{key}' during re-stage of {job_id}: {e}. Setting to None."); return None; return None
        intervals_path = get_optional_path_str("intervals_file"); dbsnp_path = get_optional_path_str("dbsnp"); known_indels_path = get_optional_path_str("known_indels"); pon_path = get_optional_path_str("pon")
        new_staged_job_id = f"staged_{uuid.uuid4()}"
        new_job_details = { "input_csv_path": new_temp_csv_file_path, "intervals_path": intervals_path, "dbsnp_path": dbsnp_path, "known_indels_path": known_indels_path, "pon_path": pon_path, "outdir_base_path": str(RESULTS_DIR), "genome": original_sarek_params.get("genome", "GATK.GRCh38"), "tools": original_sarek_params.get("tools"), "step": original_step, "profile": original_sarek_params.get("profile", SAREK_DEFAULT_PROFILE), "aligner": original_sarek_params.get("aligner"), "joint_germline": original_sarek_params.get("joint_germline", False), "wes": original_sarek_params.get("wes", False), "trim_fastq": original_sarek_params.get("trim_fastq", False), "skip_qc": original_sarek_params.get("skip_qc", False), "skip_annotation": original_sarek_params.get("skip_annotation", False), "skip_baserecalibrator": original_sarek_params.get("skip_baserecalibrator", False), "description": f"Re-run of job {job_id} ({original_description})", "staged_at": time.time(), "input_type": original_input_type, "input_filenames": original_input_params, "sample_info": original_sample_info, "is_rerun": True, "original_job_id": job_id, }
        redis_conn.hset(STAGED_JOBS_KEY, new_staged_job_id.encode('utf-8'), json.dumps(new_job_details).encode('utf-8'))
        logger.info(f"Created new staged job {new_staged_job_id} for re-run of {job_id}")
        return JSONResponse( status_code=200, content={ "message": f"Job {job_id} re-staged successfully as {new_staged_job_id}. Please start the new job.", "staged_job_id": new_staged_job_id } )
    except redis.exceptions.RedisError as e: logger.error(f"Redis error during job re-stage for {job_id}: {e}"); if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): try: os.remove(new_temp_csv_file_path); except OSError: pass; raise HTTPException(status_code=503, detail="Service unavailable: Could not access job storage.")
    except HTTPException as e: if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): try: os.remove(new_temp_csv_file_path); except OSError: pass; raise e
    except Exception as e: logger.exception(f"Unexpected error during job re-stage for {job_id}: {e}"); if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): try: os.remove(new_temp_csv_file_path); except OSError: pass; raise HTTPException(status_code=500, detail="Internal server error during job re-stage.")# backend/app/routers/jobs.py
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
from rq.registry import StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry
from rq.command import send_stop_job_command

# App specific imports
from ..core.config import (
    STAGED_JOBS_KEY, DEFAULT_JOB_TIMEOUT,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL, MAX_REGISTRY_JOBS,
    SAREK_DEFAULT_PROFILE, SAREK_DEFAULT_TOOLS, SAREK_DEFAULT_STEP, SAREK_DEFAULT_ALIGNER,
    RESULTS_DIR, DATA_DIR
)
from ..core.redis_rq import get_redis_connection, get_pipeline_queue
from ..models.pipeline import PipelineInput, SampleInfo, JobStatusDetails, JobResourceInfo
from ..utils.validation import validate_pipeline_input
from ..utils.time import dt_to_timestamp
from ..tasks import run_pipeline_task

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Jobs Management"]
)

# --- Job Staging and Control Routes ---

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
                 existing_job = Job.fetch(rq_job_id, connection=redis_conn)
                 if existing_job:
                     logger.warning(f"RQ job {rq_job_id} already exists (Status: {existing_job.get_status()}). Generating new ID.")
                     rq_job_id = f"running_{uuid.uuid4()}"
            except NoSuchJobError:
                pass
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
    registries_to_check = { "queued": queue, "started": StartedJobRegistry(queue=queue), "finished": FinishedJobRegistry(queue=queue), "failed": FailedJobRegistry(queue=queue), }
    rq_job_ids_to_fetch = set()
    for status_name, registry_or_queue in registries_to_check.items():
        try:
            job_ids = []
            limit = MAX_REGISTRY_JOBS if status_name in ["finished", "failed"] else -1
            if isinstance(registry_or_queue, Queue):
                job_ids = registry_or_queue.get_job_ids()
            # --- THIS BLOCK IS NOW CORRECTED ---
            elif isinstance(registry_or_queue, (StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry)):
                total_count = registry_or_queue.count
                start_index = max(0, total_count - limit) if limit > 0 else 0
                end_index = total_count - 1
                if start_index <= end_index:
                     job_ids = registry_or_queue.get_job_ids(start_index, end_index)
                     job_ids.reverse()
            # --- END CORRECTION ---
            else:
                 logger.warning(f"Unsupported type for job fetching: {type(registry_or_queue)}")
                 continue
            if job_ids:
                 rq_job_ids_to_fetch.update(job_ids)
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error fetching job IDs from {status_name} registry/queue: {e}")
        except Exception as e:
            logger.exception(f"Unexpected error fetching job IDs from {status_name} registry/queue.")

    if rq_job_ids_to_fetch:
        try:
            redis_conn_bytes = redis.Redis( host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False )
            fetched_jobs = Job.fetch_many(list(rq_job_ids_to_fetch), connection=redis_conn_bytes, serializer=queue.serializer)
            for job in fetched_jobs:
                if job:
                    job.refresh()
                    current_status = job.get_status(refresh=False)
                    error_summary = None
                    job_meta = job.meta or {}
                    if current_status == JobStatus.FAILED:
                        error_summary = job_meta.get('error_message', "Job failed processing")
                        stderr_snippet = job_meta.get('stderr_snippet')
                        if error_summary == "Job failed processing" and job.exc_info:
                            try: error_summary = job.exc_info.strip().split('\n')[-1]
                            except Exception: pass
                        if stderr_snippet: error_summary += f" (stderr: {stderr_snippet}...)"
                    resources = { "peak_memory_mb": job_meta.get("peak_memory_mb"), "average_cpu_percent": job_meta.get("average_cpu_percent"), "duration_seconds": job_meta.get("duration_seconds") }
                    if job.id not in all_jobs_dict or all_jobs_dict[job.id].get('status') == 'staged':
                         all_jobs_dict[job.id] = { "id": job.id, "status": current_status, "description": job_meta.get("description") or job.description or f"RQ job {job.id[:12]}...", "enqueued_at": dt_to_timestamp(job.enqueued_at), "started_at": dt_to_timestamp(job.started_at), "ended_at": dt_to_timestamp(job.ended_at), "result": job.result, "error": error_summary, "meta": job_meta, "staged_at": None, "resources": resources if any(v is not None for v in resources.values()) else None }
        except redis.exceptions.RedisError as e: logger.error(f"Redis error during Job.fetch_many: {e}")
        except Exception as e: logger.exception("Unexpected error fetching RQ job details.")

    # 3. Sort Combined List
    try: all_jobs_list = sorted( all_jobs_dict.values(), key=lambda j: j.get('ended_at') or j.get('started_at') or j.get('enqueued_at') or j.get('staged_at') or 0, reverse=True )
    except Exception as e: logger.exception("Error sorting combined jobs list."); all_jobs_list = list(all_jobs_dict.values())

    # 4. Limit Finished/Failed jobs
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
                 final_list.append(job_item)
        all_jobs_list = final_list

    return all_jobs_list


@router.get("/job_status/{job_id}", response_model=JobStatusDetails, summary="Get RQ Job Status and Details")
async def get_job_status(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    # ... (get_job_status logic - unchanged, includes previous fix) ...
    logger.debug(f"Fetching status for job ID: {job_id}")
    try:
        if not job_id.startswith("staged_"):
            try:
                redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False)
                job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
                job.refresh()
                status = job.get_status(refresh=False)
                result = None
                meta_data = job.meta or {}
                error_info_summary = None
                try:
                    if status == JobStatus.FINISHED: result = job.result
                    elif status == JobStatus.FAILED: error_info_summary = meta_data.get('error_message', "Job failed processing"); stderr_snippet = meta_data.get('stderr_snippet'); if error_info_summary == "Job failed processing" and job.exc_info: try: error_info_summary = job.exc_info.strip().split('\n')[-1]; except Exception: pass; if stderr_snippet: error_info_summary += f" (stderr: {stderr_snippet}...)"
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


@router.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued RQ Job")
async def stop_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    # ... (stop_job logic - unchanged) ...
     if job_id.startswith("staged_"): raise HTTPException(status_code=400, detail="Cannot stop a 'staged' job. Remove it instead.")
     logger.info(f"Received request to stop RQ job: {job_id}")
     try:
         redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False)
         job = Job.fetch(job_id, connection=redis_conn_bytes); status = job.get_status(refresh=True)
         if job.is_finished or job.is_failed or job.is_stopped or job.is_canceled: logger.warning(f"Attempted to stop job {job_id} which is already in state: {status}"); return JSONResponse(status_code=200, content={"message": f"Job already in terminal state: {status}.", "job_id": job_id})
         logger.info(f"Job {job_id} is in state {status}. Attempting to send stop signal.")
         message = f"Stop signal sent to job {job_id}."
         try: send_stop_job_command(redis_conn_bytes, job.id); logger.info(f"Successfully sent stop signal command via RQ for job {job_id}.")
         except Exception as sig_err: logger.warning(f"Could not send stop signal command via RQ for job {job_id}. Worker may not stop immediately. Error: {sig_err}"); message = f"Stop signal attempted for job {job_id} (check worker logs)."
         return JSONResponse(status_code=200, content={"message": message, "job_id": job_id})
     except NoSuchJobError: logger.warning(f"Stop job request failed: Job ID '{job_id}' not found."); raise HTTPException(status_code=404, detail=f"Cannot stop job: Job '{job_id}' not found.")
     except redis.exceptions.RedisError as e: logger.error(f"Redis error interacting with job {job_id} for stopping: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not connect to job backend.")
     except Exception as e: logger.exception(f"Unexpected error stopping job {job_id}."); raise HTTPException(status_code=500, detail="Internal server error attempting to stop job.")


@router.delete("/remove_job/{job_id}", status_code=200, summary="Remove Staged or RQ Job Data")
async def remove_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    # ... (remove_job logic - unchanged) ...
    logger.info(f"Request received to remove job/data for ID: {job_id}")
    csv_path_to_remove = None
    if job_id.startswith("staged_"):
        logger.info(f"Attempting to remove staged job '{job_id}' from hash '{STAGED_JOBS_KEY}'.")
        try:
            job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id.encode('utf-8'))
            if job_details_bytes: try: details = json.loads(job_details_bytes.decode('utf-8')); csv_path_to_remove = details.get("input_csv_path"); except (json.JSONDecodeError, UnicodeDecodeError): logger.warning(f"Could not parse details for staged job {job_id} during removal, cannot identify CSV.")
            num_deleted = redis_conn.hdel(STAGED_JOBS_KEY, job_id.encode('utf-8'))
            if num_deleted == 1: logger.info(f"Successfully removed staged job entry: {job_id}")
            else: logger.warning(f"Staged job '{job_id}' not found in hash for removal."); raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found.")
        except redis.exceptions.RedisError as e: logger.error(f"Redis error removing staged job {job_id}: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not remove job due to storage error.")
        except HTTPException as e: raise e
        except Exception as e: logger.exception(f"Unexpected error during staged job removal check for {job_id}."); raise HTTPException(status_code=500, detail="Internal server error removing staged job.")
    else:
        logger.info(f"Attempting to remove RQ job '{job_id}' data.")
        try:
             redis_conn_bytes = redis.Redis(host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False, socket_timeout=5, socket_connect_timeout=5)
             try: job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer);
             except NoSuchJobError: logger.warning(f"RQ Job '{job_id}' not found for removal."); raise HTTPException(status_code=404, detail=f"RQ Job '{job_id}' not found.")
             except Exception as fetch_err: logger.error(f"Error fetching job {job_id}: {fetch_err}"); raise HTTPException(status_code=500, detail=f"Could not fetch job {job_id} for removal")
             if not job: raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
             if job and job.meta: csv_path_to_remove = job.meta.get("input_csv_path_used") or job.meta.get("input_csv_path")
             try: job_status = job.get_status()
             except Exception as status_err: logger.error(f"Error getting status for job {job_id}: {status_err}"); job_status = None
             if job_status == 'started': try: logger.info(f"Sending stop signal to running job {job_id} before removal"); send_stop_job_command(redis_conn_bytes, job.id); time.sleep(1); except Exception as stop_err: logger.warning(f"Could not stop running job {job_id} before removal: {stop_err}")
             registries = [ queue, StartedJobRegistry(queue=queue), FinishedJobRegistry(queue=queue), FailedJobRegistry(queue=queue), ]
             for reg in registries:
                 try: reg.remove(job); logger.debug(f"Removed job {job_id} from registry {type(reg).__name__}")
                 except (InvalidJobOperation, ValueError, TypeError) as reg_err: logger.debug(f"Job {job_id} not found or error removing from {type(reg).__name__}: {reg_err}")
                 except Exception as reg_err: logger.warning(f"Unexpected error removing job {job_id} from registry {type(reg).__name__}: {reg_err}")
             try: job.delete(); logger.info(f"Successfully deleted RQ job data for {job_id}")
             except InvalidJobOperation as e: logger.warning(f"Invalid operation trying to delete RQ job {job_id}: {e}"); raise HTTPException(status_code=409, detail=f"Cannot remove job '{job_id}': Invalid operation (job might be active or locked). Try stopping first.")
             except Exception as delete_err: logger.error(f"Error deleting job {job_id}: {delete_err}"); raise HTTPException(status_code=500, detail=f"Could not delete job {job_id}")
        except HTTPException as e: raise e
        except redis.exceptions.RedisError as e: logger.error(f"Redis error removing RQ job {job_id}: {e}"); raise HTTPException(status_code=503, detail="Service unavailable: Could not remove RQ job due to storage error.")
        except Exception as e: logger.exception(f"Unexpected error during RQ job removal for {job_id}: {str(e)}"); raise HTTPException(status_code=500, detail=f"Internal server error removing RQ job: {str(e)}")
    if csv_path_to_remove:
        try:
            csv_path = Path(csv_path_to_remove)
            if csv_path.exists() and csv_path.is_file() and csv_path.suffix == '.csv': os.remove(csv_path); logger.info(f"Cleaned up temporary CSV file for removed job {job_id}: {csv_path}")
            else: logger.warning(f"Temporary CSV path {csv_path} not found, invalid, or not a CSV for removal associated with job {job_id}.")
        except OSError as e: logger.warning(f"Could not clean up temporary CSV file {csv_path_to_remove} for job {job_id}: {e}")
        except Exception as e: logger.warning(f"Unexpected error during CSV cleanup for job {job_id}: {e}")
    return JSONResponse(status_code=200, content={"message": f"Successfully removed job {job_id}.", "removed_id": job_id})


@router.post("/rerun_job/{job_id}", status_code=202, summary="Re-stage Failed/Finished Job")
async def rerun_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    # ... (rerun_job logic - unchanged) ...
    if job_id.startswith("staged_"): raise HTTPException(status_code=400, detail="Cannot re-run a job that is still 'staged'. Start it first.")
    logger.info(f"Attempting to re-stage job based on RQ job: {job_id}")
    new_temp_csv_file_path = None
    try:
        redis_conn_bytes = redis.Redis( host=redis_conn.connection_pool.connection_kwargs.get('host', 'localhost'), port=redis_conn.connection_pool.connection_kwargs.get('port', 6379), db=redis_conn.connection_pool.connection_kwargs.get('db', 0), decode_responses=False )
        try: original_job = Job.fetch(job_id, connection=redis_conn_bytes, serializer=queue.serializer)
        except NoSuchJobError: logger.warning(f"Re-stage request failed: Original RQ job ID '{job_id}' not found."); raise HTTPException(status_code=404, detail=f"Original job '{job_id}' not found to re-stage.")
        if not original_job.meta: logger.error(f"Cannot re-stage job {job_id}: Original job metadata is missing."); raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Missing original parameters.")
        original_meta = original_job.meta
        original_sarek_params = original_meta.get("sarek_params", {})
        original_input_params = original_meta.get("input_params", {})
        original_sample_info = original_meta.get("sample_info", [])
        original_description = original_meta.get("description", f"Sarek run")
        original_input_type = original_meta.get("input_type")
        original_step = original_sarek_params.get("step")
        if not original_input_type or not original_step: raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Original input type or step missing from metadata.")
        if not original_sample_info: raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Original sample info missing from metadata.")
        new_sample_rows_for_csv = []
        csv_headers = []
        if original_input_type == "fastq": csv_headers = ['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2']; for sample_data in original_sample_info: if not all(k in sample_data for k in ['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2']): raise HTTPException(status_code=400, detail=f"Cannot re-stage: Incomplete sample data in original job {job_id} for FASTQ input."); new_sample_rows_for_csv.append([ sample_data.get('patient'), sample_data.get('sample'), sample_data.get('sex'), sample_data.get('status'), sample_data.get('lane'), sample_data.get('fastq_1'), sample_data.get('fastq_2') ])
        elif original_input_type == "bam_cram": first_file = original_sample_info[0].get('bam_cram') if original_sample_info else None; if not first_file: raise HTTPException(status_code=400, detail=f"Cannot re-stage: Missing bam_cram path in original job {job_id}."); bam_cram_col = 'cram' if first_file.endswith('.cram') else 'bam'; csv_headers = ['patient', 'sample', 'sex', 'status', bam_cram_col, 'index']; for sample_data in original_sample_info: if not all(k in sample_data for k in ['patient', 'sample', 'sex', 'status', 'bam_cram']): raise HTTPException(status_code=400, detail=f"Cannot re-stage: Incomplete sample data in original job {job_id} for BAM/CRAM input."); new_sample_rows_for_csv.append([ sample_data.get('patient'), sample_data.get('sample'), sample_data.get('sex'), sample_data.get('status'), sample_data.get('bam_cram'), sample_data.get('index') or '' ])
        elif original_input_type == "vcf": csv_headers = ['patient', 'sample', 'sex', 'status', 'vcf', 'index']; for sample_data in original_sample_info: if not all(k in sample_data for k in ['patient', 'sample', 'sex', 'status', 'vcf']): raise HTTPException(status_code=400, detail=f"Cannot re-stage: Incomplete sample data in original job {job_id} for VCF input."); new_sample_rows_for_csv.append([ sample_data.get('patient'), sample_data.get('sample'), sample_data.get('sex'), sample_data.get('status'), sample_data.get('vcf'), sample_data.get('index') or '' ])
        else: raise HTTPException(status_code=400, detail=f"Cannot re-stage job {job_id}: Unknown original input type '{original_input_type}'.")
        try:
            with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv: csv_writer = csv.writer(temp_csv); csv_writer.writerow(csv_headers); csv_writer.writerows(new_sample_rows_for_csv); new_temp_csv_file_path = temp_csv.name; logger.info(f"Created new temporary samplesheet for re-run: {new_temp_csv_file_path}")
        except (OSError, csv.Error) as e: logger.error(f"Failed to create new temporary samplesheet for re-run of {job_id}: {e}"); raise HTTPException(status_code=500, detail="Internal server error: Could not create samplesheet for re-run.")
        def get_optional_path_str(key): file_name = original_input_params.get(key); if file_name: try: full_path = (DATA_DIR / file_name).resolve(); if DATA_DIR.resolve() in full_path.parents and full_path.is_file(): return str(full_path); else: logger.warning(f"Optional file '{file_name}' for key '{key}' not found or invalid during re-stage of {job_id}. Setting to None."); return None; except Exception as e: logger.warning(f"Error resolving optional file path '{file_name}' for key '{key}' during re-stage of {job_id}: {e}. Setting to None."); return None; return None
        intervals_path = get_optional_path_str("intervals_file"); dbsnp_path = get_optional_path_str("dbsnp"); known_indels_path = get_optional_path_str("known_indels"); pon_path = get_optional_path_str("pon")
        new_staged_job_id = f"staged_{uuid.uuid4()}"
        new_job_details = { "input_csv_path": new_temp_csv_file_path, "intervals_path": intervals_path, "dbsnp_path": dbsnp_path, "known_indels_path": known_indels_path, "pon_path": pon_path, "outdir_base_path": str(RESULTS_DIR), "genome": original_sarek_params.get("genome", "GATK.GRCh38"), "tools": original_sarek_params.get("tools"), "step": original_step, "profile": original_sarek_params.get("profile", SAREK_DEFAULT_PROFILE), "aligner": original_sarek_params.get("aligner"), "joint_germline": original_sarek_params.get("joint_germline", False), "wes": original_sarek_params.get("wes", False), "trim_fastq": original_sarek_params.get("trim_fastq", False), "skip_qc": original_sarek_params.get("skip_qc", False), "skip_annotation": original_sarek_params.get("skip_annotation", False), "skip_baserecalibrator": original_sarek_params.get("skip_baserecalibrator", False), "description": f"Re-run of job {job_id} ({original_description})", "staged_at": time.time(), "input_type": original_input_type, "input_filenames": original_input_params, "sample_info": original_sample_info, "is_rerun": True, "original_job_id": job_id, }
        redis_conn.hset(STAGED_JOBS_KEY, new_staged_job_id.encode('utf-8'), json.dumps(new_job_details).encode('utf-8'))
        logger.info(f"Created new staged job {new_staged_job_id} for re-run of {job_id}")
        return JSONResponse( status_code=200, content={ "message": f"Job {job_id} re-staged successfully as {new_staged_job_id}. Please start the new job.", "staged_job_id": new_staged_job_id } )
    except redis.exceptions.RedisError as e: logger.error(f"Redis error during job re-stage for {job_id}: {e}"); if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): try: os.remove(new_temp_csv_file_path); except OSError: pass; raise HTTPException(status_code=503, detail="Service unavailable: Could not access job storage.")
    except HTTPException as e: if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): try: os.remove(new_temp_csv_file_path); except OSError: pass; raise e
    except Exception as e: logger.exception(f"Unexpected error during job re-stage for {job_id}: {e}"); if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): try: os.remove(new_temp_csv_file_path); except OSError: pass; raise HTTPException(status_code=500, detail="Internal server error during job re-stage.")
