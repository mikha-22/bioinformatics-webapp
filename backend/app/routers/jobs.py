# File: backend/app/routers/jobs.py
import logging
import json
import uuid
import time
import redis
import os
from pathlib import Path
import tempfile
import csv
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from rq import Queue
from rq.job import Job, JobStatus
from rq.exceptions import NoSuchJobError, InvalidJobOperation
from rq.registry import StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry, DeferredJobRegistry, ScheduledJobRegistry, CanceledJobRegistry
from rq.command import send_stop_job_command

from ..core.config import (
    STAGED_JOBS_KEY, DEFAULT_JOB_TIMEOUT,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL, MAX_REGISTRY_JOBS,
    RESULTS_DIR, LOG_HISTORY_PREFIX, DATA_DIR # Ensure DATA_DIR is imported if used by get_safe_path in rerun
)
from ..core.redis_rq import get_redis_connection, get_pipeline_queue
from ..models.pipeline import PipelineInput, JobStatusDetails, JobResourceInfo, JobMeta, SampleInfo # Import SampleInfo
from ..utils.validation import validate_pipeline_input
from ..utils.time import dt_to_timestamp
from ..tasks import run_pipeline_task
from ..utils.files import get_safe_path


logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Jobs Management"]
)

@router.post("/run_pipeline", status_code=200, summary="Stage Pipeline Job")
async def stage_pipeline_job(
    input_data: PipelineInput,
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    logger.info(f"Received staging request. Run Name: '{input_data.run_name}', Input type: {input_data.input_type}")
    paths_map, validation_errors = validate_pipeline_input(input_data)

    sanitized_run_name = input_data.run_name.replace(" ", "_")
    if not sanitized_run_name: # Pydantic should catch min_len=1, but defensive
        validation_errors.append("Run Name cannot be empty or only spaces.")

    input_csv_path = paths_map.get("input_csv")
    if not input_csv_path and not any("At least one sample" in e for e in validation_errors):
        if "Internal server error: Could not create samplesheet." not in validation_errors and "Cannot generate samplesheet" not in validation_errors:
            validation_errors.append("Failed to generate samplesheet from provided sample data.")

    if validation_errors:
        if input_csv_path and input_csv_path.exists():
            try: os.remove(input_csv_path)
            except OSError as e: logger.warning(f"Could not clean up temp CSV {input_csv_path}: {e}")
        error_message = "Validation errors:\n" + "\n".join(f"- {error}" for error in validation_errors)
        logger.warning(f"Validation errors staging job: {error_message}")
        raise HTTPException(status_code=400, detail=error_message)

    if not isinstance(input_csv_path, Path): # Should not happen if validation is correct
        logger.error(f"input_csv_path is not a Path object after validation: {input_csv_path}")
        raise HTTPException(status_code=500, detail="Internal server error: Samplesheet path invalid after validation.")

    try:
        staged_job_id = f"staged_{uuid.uuid4()}"
        # Prepare details for Redis, ensuring all relevant fields from PipelineInput are captured
        job_details_for_redis = {
            "run_name": sanitized_run_name,
            "run_description": input_data.run_description,
            "sarek_internal_description": input_data.description, # Sarek's own description field

            "input_csv_path": str(input_csv_path),
            "outdir_base_path": str(RESULTS_DIR), # From config

            "genome": input_data.genome,
            "tools": ",".join(input_data.tools) if input_data.tools else None,
            "step": input_data.step,
            "profile": input_data.profile,
            "aligner": input_data.aligner,

            "intervals_path": str(paths_map["intervals"]) if paths_map.get("intervals") else None,
            "dbsnp_path": str(paths_map["dbsnp"]) if paths_map.get("dbsnp") else None,
            "known_indels_path": str(paths_map["known_indels"]) if paths_map.get("known_indels") else None,
            "pon_path": str(paths_map["pon"]) if paths_map.get("pon") else None,

            "joint_germline": input_data.joint_germline,
            "wes": input_data.wes,
            "trim_fastq": input_data.trim_fastq,
            "skip_qc": input_data.skip_qc,
            "skip_annotation": input_data.skip_annotation,
            "skip_baserecalibrator": input_data.skip_baserecalibrator,

            "staged_at": time.time(), # Timestamp for when it was staged
            "input_type": input_data.input_type,
            # Store original relative paths for input_filenames for potential re-run reference
            "input_filenames": {
                "intervals_file": input_data.intervals_file,
                "dbsnp": input_data.dbsnp,
                "known_indels": input_data.known_indels,
                "pon": input_data.pon
            },
            "sample_info": [s.model_dump(exclude_unset=True) for s in input_data.samples] # Store original sample info
        }
        redis_conn.hset(STAGED_JOBS_KEY, staged_job_id, json.dumps(job_details_for_redis))
        logger.info(f"Staged Sarek job '{staged_job_id}' (Run Name: '{sanitized_run_name}').")
        return JSONResponse(status_code=200, content={"message": "Job staged successfully.", "staged_job_id": staged_job_id})
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error staging job: {e}")
        if input_csv_path and input_csv_path.exists():
            try: os.remove(input_csv_path)
            except OSError as remove_e: logger.warning(f"Could not clean up temp CSV {input_csv_path}: {remove_e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not stage job.")
    except Exception as e:
        logger.exception(f"Unexpected error during job staging for run name: {input_data.run_name}")
        if input_csv_path and input_csv_path.exists():
            try: os.remove(input_csv_path)
            except OSError as remove_e: logger.warning(f"Could not clean up temp CSV {input_csv_path}: {remove_e}")
        raise HTTPException(status_code=500, detail="Internal server error during job staging.")


@router.post("/start_job/{staged_job_id}", status_code=202, summary="Enqueue Staged Job")
async def start_job(
    staged_job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    logger.info(f"Attempting to start job from staged ID: {staged_job_id}")
    job_details_bytes = redis_conn.hget(STAGED_JOBS_KEY, staged_job_id)
    if not job_details_bytes:
        raise HTTPException(status_code=404, detail=f"Staged job '{staged_job_id}' not found.")
    try:
        details = json.loads(job_details_bytes.decode('utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        logger.error(f"Corrupted staged job data for {staged_job_id}: {e}. Removing entry.")
        redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id) # Clean up corrupted entry
        raise HTTPException(status_code=500, detail="Corrupted staged job data. Please re-stage.")

    run_name = details.get("run_name", f"run_{staged_job_id.replace('staged_','')[:8]}")
    run_description = details.get("run_description")
    sarek_internal_description = details.get("sarek_internal_description")

    # Arguments for the run_pipeline_task function
    job_args_for_task = (
        run_name, # First argument is now run_name
        details["input_csv_path"], details["outdir_base_path"], details["genome"],
        details.get("tools"), details["step"], details.get("profile"),
        details.get("intervals_path"), details.get("dbsnp_path"),
        details.get("known_indels_path"), details.get("pon_path"),
        details.get("aligner"), details.get("joint_germline", False),
        details.get("wes", False), details.get("trim_fastq", False),
        details.get("skip_qc", False), details.get("skip_annotation", False),
        details.get("skip_baserecalibrator", False),
        details.get("is_rerun", False), # For re-runs
    )

    rq_job_id = staged_job_id.replace("staged_", "rqjob_") # Use a distinct prefix for RQ jobs
    if rq_job_id == staged_job_id: # Should not happen with new prefix
        rq_job_id = f"rqjob_{uuid.uuid4()}"
    try: # Check if this ID already exists in RQ (rare, but possible with manual intervention/crashes)
        if Job.exists(rq_job_id, connection=queue.connection):
            logger.warning(f"RQ job ID {rq_job_id} (derived from {staged_job_id}) already exists. Generating a new unique ID.")
            rq_job_id = f"rqjob_{uuid.uuid4()}"
    except Exception: # Catch potential errors from Job.exists if Redis is temporarily down
        pass

    # Prepare metadata for the RQ job, using the JobMeta Pydantic model for structure
    meta_for_rq_job = JobMeta(
        run_name=run_name,
        description=run_description, # User's overall run description
        input_type=details.get("input_type"),
        input_params=details.get("input_filenames"), # Original relative paths for reference
        sarek_params={ # Nested Sarek-specific parameters
            "genome": details.get("genome"), "tools": details.get("tools"), "step": details.get("step"),
            "profile": details.get("profile"), "aligner": details.get("aligner"),
            "joint_germline": details.get("joint_germline"), "wes": details.get("wes"),
            "trim_fastq": details.get("trim_fastq"), "skip_qc": details.get("skip_qc"),
            "skip_annotation": details.get("skip_annotation"), "skip_baserecalibrator": details.get("skip_baserecalibrator"),
            "description": sarek_internal_description, # Sarek's internal config description
        },
        sample_info=details.get("sample_info"), # Original sample info for reference
        staged_job_id_origin=staged_job_id,
        input_csv_path_used=details.get("input_csv_path"), # Absolute path used for this run
        is_rerun_execution=details.get("is_rerun", False),
        original_job_id=details.get("original_job_id"), # For re-runs
    ).model_dump(exclude_none=True) # Convert Pydantic model to dict for RQ meta

    try:
        rq_job = queue.enqueue(
            run_pipeline_task, args=job_args_for_task, job_timeout=DEFAULT_JOB_TIMEOUT,
            result_ttl=DEFAULT_RESULT_TTL, failure_ttl=DEFAULT_FAILURE_TTL,
            job_id=rq_job_id, meta=meta_for_rq_job
        )
        logger.info(f"Successfully enqueued job {rq_job.id} to RQ queue (Run Name: '{run_name}').")
    except Exception as e:
        logger.exception(f"Failed to enqueue job to RQ from staged ID {staged_job_id}: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not enqueue job for execution.")

    redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id) # Clean up staged entry
    logger.info(f"Removed staged job entry {staged_job_id} after successful enqueue.")
    return JSONResponse(status_code=202, content={"message": "Job enqueued for execution.", "job_id": rq_job.id, "status": "queued"})


@router.get("/jobs_list", response_model=List[JobStatusDetails], summary="List All Relevant Jobs")
async def get_jobs_list(
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    all_jobs_for_frontend: List[JobStatusDetails] = []
    # Keep track of RQ job IDs to avoid processing them if they were somehow also in staged_jobs (should not happen)
    processed_rq_ids = set()

    # 1. Get Staged Jobs
    try:
        staged_jobs_raw = redis_conn.hgetall(STAGED_JOBS_KEY)
        for job_id_bytes, job_details_bytes in staged_jobs_raw.items():
            job_id_str = job_id_bytes.decode('utf-8')
            try:
                details = json.loads(job_details_bytes.decode('utf-8'))
                # Construct meta using the JobMeta model for consistency and validation
                meta_obj = JobMeta(
                    run_name=details.get("run_name"),
                    description=details.get("run_description"), # User's overall run description
                    input_type=details.get("input_type"),
                    input_params=details.get("input_filenames"),
                    sarek_params={
                        "genome": details.get("genome"), "tools": details.get("tools"),
                        "step": details.get("step"), "profile": details.get("profile"),
                        "aligner": details.get("aligner"), "joint_germline": details.get("joint_germline"),
                        "wes": details.get("wes"), "trim_fastq": details.get("trim_fastq"),
                        "skip_qc": details.get("skip_qc"), "skip_annotation": details.get("skip_annotation"),
                        "skip_baserecalibrator": details.get("skip_baserecalibrator"),
                        "description": details.get("sarek_internal_description"), # Sarek's internal config description
                    },
                    sample_info=details.get("sample_info"),
                    staged_job_id_origin=job_id_str, # The ID of this staged job entry
                    input_csv_path_used=details.get("input_csv_path")
                    # is_rerun_execution and original_job_id would be set if this staged job IS a rerun
                )
                all_jobs_for_frontend.append(JobStatusDetails(
                    job_id=job_id_str,
                    run_name=details.get("run_name"),
                    status="staged",
                    description=details.get("run_description"), # User's run description
                    staged_at=details.get("staged_at"), # Populate staged_at
                    enqueued_at=None, started_at=None, ended_at=None, # Explicitly None for staged
                    result=None, error=None,
                    meta=meta_obj, # Pass the structured JobMeta object
                    resources=None, # No resources for staged jobs
                ))
                processed_rq_ids.add(job_id_str) # To avoid potential (though unlikely) clashes if an RQ job ID was manually made "staged_..."
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as e: # Added ValueError for Pydantic
                logger.error(f"Error parsing staged job data for key {job_id_str}: {e}. Skipping entry.")
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error fetching staged jobs from '{STAGED_JOBS_KEY}': {e}")

    # 2. Get RQ Jobs
    registries_to_check_config = {
        "queued": {"registry": queue, "limit": -1}, # No limit for queued
        "started": {"registry": StartedJobRegistry(queue=queue), "limit": -1}, # No limit for started
        "finished": {"registry": FinishedJobRegistry(queue=queue), "limit": MAX_REGISTRY_JOBS},
        "failed": {"registry": FailedJobRegistry(queue=queue), "limit": MAX_REGISTRY_JOBS},
        "canceled": {"registry": CanceledJobRegistry(queue=queue), "limit": MAX_REGISTRY_JOBS},
    }
    all_rq_job_ids_to_fetch = set()

    for status_name, config in registries_to_check_config.items():
        try:
            registry_or_queue = config["registry"]
            limit = config["limit"]
            job_ids_in_registry = []

            if isinstance(registry_or_queue, (StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry, CanceledJobRegistry)):
                total_count = registry_or_queue.count
                start_index = max(0, total_count - limit) if limit > 0 else 0
                end_index = total_count - 1
                if start_index <= end_index:
                    job_ids_in_registry = registry_or_queue.get_job_ids(start_index, end_index)
                    job_ids_in_registry.reverse() # Show most recent first for these terminal/limited states
            elif isinstance(registry_or_queue, Queue): # For 'queued'
                job_ids_in_registry = registry_or_queue.get_job_ids() # Fetches all, order is FIFO
            else:
                logger.warning(f"Unsupported registry type for job fetching: {type(registry_or_queue)}")
                continue
            if job_ids_in_registry:
                all_rq_job_ids_to_fetch.update(job_ids_in_registry)
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error fetching job IDs from {status_name} registry: {e}")
        except Exception as e:
            logger.exception(f"Unexpected error fetching job IDs from {status_name} registry.")

    unique_rq_ids_to_process = list(all_rq_job_ids_to_fetch - processed_rq_ids)

    if unique_rq_ids_to_process:
        try:
            fetched_rq_jobs = Job.fetch_many(unique_rq_ids_to_process, connection=queue.connection, serializer=queue.serializer)
            for job in fetched_rq_jobs:
                if job:
                    current_status = job.get_status(refresh=False)
                    job_meta_dict = job.meta or {}
                    meta_obj = JobMeta(**job_meta_dict) # Parse into Pydantic model

                    error_summary = None
                    if current_status == JobStatus.FAILED:
                        error_summary = meta_obj.error_message or "Job failed processing"
                        if meta_obj.error_message == "Job failed processing" and job.exc_info: # Check if default message and exc_info exists
                            try: error_summary = job.exc_info.strip().split('\n')[-1] # Get last line of traceback
                            except Exception: pass # Ignore if parsing exc_info fails
                        if meta_obj.stderr_snippet:
                             error_summary += f" (stderr: ...{meta_obj.stderr_snippet[-100:]})"

                    # Get resource info from the raw meta dict as they are direct fields there
                    resources = JobResourceInfo(
                        peak_memory_mb=job_meta_dict.get("peak_memory_mb"),
                        average_cpu_percent=job_meta_dict.get("average_cpu_percent"),
                        duration_seconds=job_meta_dict.get("duration_seconds")
                    )
                    all_jobs_for_frontend.append(JobStatusDetails(
                        job_id=job.id,
                        run_name=meta_obj.run_name, # From parsed JobMeta
                        status=current_status,
                        description=meta_obj.description, # User's run description from parsed JobMeta
                        staged_at=None, # <<< EXPLICITLY SET TO NONE FOR RQ JOBS
                        enqueued_at=dt_to_timestamp(job.enqueued_at),
                        started_at=dt_to_timestamp(job.started_at),
                        ended_at=dt_to_timestamp(job.ended_at),
                        result=job.result,
                        error=error_summary,
                        meta=meta_obj, # Pass the structured JobMeta object
                        resources=resources if any(v is not None for v in resources.model_dump().values()) else None
                    ))
        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error during Job.fetch_many: {e}")
        except Exception as e:
            logger.exception("Unexpected error fetching RQ job details for list.")

    # 3. Sort Combined List
    def get_sort_key(job_detail: JobStatusDetails) -> float:
        # Ensure all timestamps are treated as floats for comparison, default to 0 if None
        ts_ended = job_detail.ended_at or 0
        ts_started = job_detail.started_at or 0
        ts_enqueued = job_detail.enqueued_at or 0
        ts_staged = job_detail.staged_at or 0 # This will be 0 for non-staged jobs if not set

        # Prioritize based on latest available timestamp indicating activity
        if ts_ended > 0: return ts_ended
        if ts_started > 0: return ts_started
        if ts_enqueued > 0: return ts_enqueued # Includes staged_at if it was mapped to enqueued_at for staged
        if ts_staged > 0 : return ts_staged # Explicitly check staged_at
        return 0

    all_jobs_for_frontend.sort(key=get_sort_key, reverse=True)

    return all_jobs_for_frontend


@router.get("/job_status/{job_id}", response_model=JobStatusDetails, summary="Get Job Status and Details")
async def get_job_status_endpoint(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    logger.debug(f"Fetching status for job ID: {job_id}")
    try:
        if job_id.startswith("staged_"):
            details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id)
            if not details_bytes:
                raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found.")
            details = json.loads(details_bytes.decode('utf-8'))
            meta_obj = JobMeta(
                run_name=details.get("run_name"),
                description=details.get("run_description"),
                input_type=details.get("input_type"),
                input_params=details.get("input_filenames"),
                sarek_params={
                    "genome": details.get("genome"), "tools": details.get("tools"), "step": details.get("step"),
                    "profile": details.get("profile"), "aligner": details.get("aligner"),
                    "joint_germline": details.get("joint_germline"), "wes": details.get("wes"),
                    "trim_fastq": details.get("trim_fastq"), "skip_qc": details.get("skip_qc"),
                    "skip_annotation": details.get("skip_annotation"), "skip_baserecalibrator": details.get("skip_baserecalibrator"),
                    "description": details.get("sarek_internal_description"),
                },
                sample_info=details.get("sample_info"),
                staged_job_id_origin=job_id,
                input_csv_path_used=details.get("input_csv_path")
            )
            return JobStatusDetails(
                job_id=job_id,
                run_name=details.get("run_name"),
                status="staged",
                description=details.get("run_description"),
                staged_at=details.get("staged_at"),
                enqueued_at=None, started_at=None, ended_at=None, # Explicitly None
                meta=meta_obj
                # resources will be None by default
            )
        else: # RQ Job
            job = Job.fetch(job_id, connection=queue.connection, serializer=queue.serializer)
            status = job.get_status(refresh=True)
            job_meta_dict = job.meta or {}
            meta_obj = JobMeta(**job_meta_dict)

            error_summary = None
            if status == JobStatus.FAILED:
                error_summary = meta_obj.error_message or "Job failed processing"
                if meta_obj.error_message == "Job failed processing" and job.exc_info:
                    try: error_summary = job.exc_info.strip().split('\n')[-1]
                    except: pass
                if meta_obj.stderr_snippet: error_summary += f" (stderr: ...{meta_obj.stderr_snippet[-100:]})"

            resources = JobResourceInfo(
                peak_memory_mb=job_meta_dict.get("peak_memory_mb"),
                average_cpu_percent=job_meta_dict.get("average_cpu_percent"),
                duration_seconds=job_meta_dict.get("duration_seconds")
            )
            return JobStatusDetails(
                job_id=job.id,
                run_name=meta_obj.run_name,
                status=status,
                description=meta_obj.description,
                staged_at=None, # <<< EXPLICITLY SET TO NONE FOR RQ JOBS
                enqueued_at=dt_to_timestamp(job.enqueued_at),
                started_at=dt_to_timestamp(job.started_at),
                ended_at=dt_to_timestamp(job.ended_at),
                result=job.result,
                error=error_summary,
                meta=meta_obj,
                resources=resources if any(v is not None for v in resources.model_dump().values()) else None
            )
    except NoSuchJobError:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e: # Added ValueError for Pydantic
        logger.error(f"Error parsing data for job {job_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Corrupted data for job '{job_id}'.")
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error for job {job_id}: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Storage error.")
    except Exception as e:
        logger.exception(f"Unexpected error for job {job_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error.")

# ... (stop_job, remove_job, rerun_job remain the same as the last provided version,
#      ensure they use job_id correctly and handle run_name/run_description for rerun_job's new staged entry)
# For rerun_job, ensure the new staged entry's "details" includes "run_name", "run_description", and "staged_at".

@router.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued RQ Job")
async def stop_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    if job_id.startswith("staged_"):
        raise HTTPException(status_code=400, detail="Cannot stop 'staged' job. Remove it.")
    logger.info(f"Request to stop/cancel RQ job: {job_id}")
    message = f"Action processed for job {job_id}."
    try:
        job = Job.fetch(job_id, connection=queue.connection)
        status = job.get_status(refresh=True)
        if job.is_finished or job.is_failed or job.is_stopped or job.is_canceled:
            message = f"Job already in terminal state: {status}."
        elif status == JobStatus.QUEUED:
            job.cancel(); message = f"Queued job {job_id} canceled."
        elif status == JobStatus.STARTED or status == JobStatus.RUNNING :
            redis_conn_for_command = redis.Redis(
                host=queue.connection.connection_pool.connection_kwargs.get('host', 'localhost'),
                port=queue.connection.connection_pool.connection_kwargs.get('port', 6379),
                db=queue.connection.connection_pool.connection_kwargs.get('db', 0),
                decode_responses=False
            )
            send_stop_job_command(redis_conn_for_command, job.id)
            message = f"Stop signal sent to job {job_id}."
        else: message = f"Job {job_id} has status '{status}', cannot stop/cancel."
        return JSONResponse(content={"message": message, "job_id": job_id})
    except NoSuchJobError:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    except Exception as e:
        logger.exception(f"Error stopping/canceling job {job_id}: {e}")
        raise HTTPException(status_code=500, detail="Error stopping/canceling job.")


@router.delete("/remove_job/{job_id}", status_code=200, summary="Remove Job Data")
async def remove_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    logger.info(f"Request to remove job/data for ID: {job_id}")
    csv_path_to_remove = None
    job_removed_flag = False
    log_history_key = f"{LOG_HISTORY_PREFIX}{job_id}"

    if job_id.startswith("staged_"):
        details_bytes = redis_conn.hget(STAGED_JOBS_KEY, job_id)
        if details_bytes:
            try: csv_path_to_remove = json.loads(details_bytes.decode('utf-8')).get("input_csv_path")
            except: pass
        if redis_conn.hdel(STAGED_JOBS_KEY, job_id) == 1: job_removed_flag = True
        elif not details_bytes: raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found.")
    else:
        try:
            job = Job.fetch(job_id, connection=queue.connection)
            if job.meta: csv_path_to_remove = job.meta.get("input_csv_path_used") or job.meta.get("input_csv_path")
            job.delete(remove_from_registries=True)
            job_removed_flag = True
        except NoSuchJobError:
            if not redis_conn.exists(f"rq:job:{job_id}"): job_removed_flag = True
            else: raise HTTPException(status_code=404, detail=f"RQ Job '{job_id}' not found.")
        except Exception as e: raise HTTPException(status_code=500, detail=f"Error removing RQ job: {str(e)}")

    if job_removed_flag:
        if csv_path_to_remove:
            try:
                csv_p = Path(csv_path_to_remove)
                if csv_p.is_file() and csv_p.suffix == '.csv' and str(csv_p.parent).startswith(tempfile.gettempdir()):
                    os.remove(csv_p); logger.info(f"Cleaned up temp CSV: {csv_p}")
            except Exception as e: logger.warning(f"Error cleaning up CSV {csv_path_to_remove}: {e}")
        if not job_id.startswith("staged_"):
            if redis_conn.delete(log_history_key) > 0: logger.info(f"Cleaned up log history for {job_id}")
        return JSONResponse(content={"message": f"Job {job_id} removed.", "removed_id": job_id})
    else: raise HTTPException(status_code=404, detail=f"Job {job_id} not found for removal.")


@router.post("/rerun_job/{job_id}", status_code=200, summary="Re-stage Failed/Finished Job")
async def rerun_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    if job_id.startswith("staged_"):
        raise HTTPException(status_code=400, detail="Cannot re-run 'staged' job. Start it first.")
    logger.info(f"Attempting to re-stage job based on RQ job: {job_id}")
    new_temp_csv_file_path = None
    try:
        original_job = Job.fetch(job_id, connection=queue.connection)
        if not original_job.meta:
            raise HTTPException(status_code=400, detail=f"Missing original parameters for job {job_id}.")

        original_meta = JobMeta(**original_job.meta)

        original_run_name = original_meta.run_name or f"run_{job_id.replace('rqjob_','')[:8]}"
        new_rerun_name = f"{original_run_name}_rerun_{time.strftime('%Y%m%d%H%M%S')}"
        new_rerun_description = f"Re-run of '{original_run_name}'. Original desc: {original_meta.description or 'N/A'}"
        sarek_internal_desc_orig = original_meta.sarek_params.get("description") if original_meta.sarek_params else None


        if not original_meta.input_type or not original_meta.sarek_params or not original_meta.sarek_params.get("step") or not original_meta.sample_info:
            raise HTTPException(status_code=400, detail="Essential original parameters missing for re-run.")

        csv_headers, new_sample_rows_for_csv, validation_errors_rerun = [], [], []
        if original_meta.input_type == "fastq": csv_headers = ['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2']
        elif original_meta.input_type == "bam_cram":
            first_s_info = original_meta.sample_info[0] if original_meta.sample_info else {}
            bam_cram_col_name = 'cram' if first_s_info.get('bam_cram','').endswith('.cram') else 'bam'
            csv_headers = ['patient', 'sample', 'sex', 'status', bam_cram_col_name, 'index']
        elif original_meta.input_type == "vcf": csv_headers = ['patient', 'sample', 'sex', 'status', 'vcf', 'index']
        else: raise ValueError(f"Unsupported input type for rerun: {original_meta.input_type}")

        for i, sample_data_dict in enumerate(original_meta.sample_info):
            sample_obj = SampleInfo(**sample_data_dict)
            current_row = [sample_obj.patient, sample_obj.sample, sample_obj.sex, sample_obj.status]
            def _resolve(path_str, req, exts):
                if not path_str:
                    if req: validation_errors_rerun.append(f"Sample {i+1}: Missing required path."); return None
                    return ""
                try:
                    abs_p = get_safe_path(DATA_DIR, path_str)
                    if not abs_p.is_file(): validation_errors_rerun.append(f"Sample {i+1}: File {path_str} not found."); return None
                    if exts and not any(abs_p.name.lower().endswith(e.lower()) for e in exts): validation_errors_rerun.append(f"Sample {i+1}: File {path_str} bad ext."); return None
                    return str(abs_p)
                except Exception as e: validation_errors_rerun.append(f"Sample {i+1}: Path error for {path_str}: {e}"); return None

            if original_meta.input_type == "fastq":
                current_row.extend([sample_obj.lane, _resolve(sample_obj.fastq_1, True, ['.fq.gz','.fastq.gz','.fq','.fastq']), _resolve(sample_obj.fastq_2, True, ['.fq.gz','.fastq.gz','.fq','.fastq'])])
            elif original_meta.input_type == "bam_cram":
                bc_path = _resolve(sample_obj.bam_cram, True, ['.bam','.cram'])
                idx_path = _resolve(sample_obj.index, bc_path.endswith('.cram') if bc_path else False, ['.bai','.crai'])
                current_row.extend([bc_path, idx_path])
            elif original_meta.input_type == "vcf":
                vcf_p = _resolve(sample_obj.vcf, True, ['.vcf','.vcf.gz'])
                idx_p = _resolve(sample_obj.index, vcf_p.endswith('.vcf.gz') if vcf_p else False, ['.tbi','.csi'])
                current_row.extend([vcf_p, idx_p])
            new_sample_rows_for_csv.append(current_row)

        if validation_errors_rerun:
            raise HTTPException(status_code=400, detail="Re-run validation errors:\n" + "\n".join(validation_errors_rerun))

        with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv:
            csv_writer = csv.writer(temp_csv); csv_writer.writerow(csv_headers); csv_writer.writerows(new_sample_rows_for_csv)
            new_temp_csv_file_path = temp_csv.name

        new_staged_job_id = f"staged_{uuid.uuid4()}"
        sarek_p = original_meta.sarek_params or {}
        input_p = original_meta.input_params or {}
        new_job_details_for_redis = {
            "run_name": new_rerun_name, "run_description": new_rerun_description,
            "sarek_internal_description": sarek_internal_desc_orig,
            "input_csv_path": new_temp_csv_file_path, "outdir_base_path": str(RESULTS_DIR),
            "genome": sarek_p.get("genome"), "tools": sarek_p.get("tools"), "step": sarek_p.get("step"),
            "profile": sarek_p.get("profile"), "aligner": sarek_p.get("aligner"),
            "intervals_path": get_safe_path(DATA_DIR, input_p["intervals_file"]).as_posix() if input_p.get("intervals_file") else None,
            "dbsnp_path": get_safe_path(DATA_DIR, input_p["dbsnp"]).as_posix() if input_p.get("dbsnp") else None,
            "known_indels_path": get_safe_path(DATA_DIR, input_p["known_indels"]).as_posix() if input_p.get("known_indels") else None,
            "pon_path": get_safe_path(DATA_DIR, input_p["pon"]).as_posix() if input_p.get("pon") else None,
            "joint_germline": sarek_p.get("joint_germline", False), "wes": sarek_p.get("wes", False),
            "trim_fastq": sarek_p.get("trim_fastq", False), "skip_qc": sarek_p.get("skip_qc", False),
            "skip_annotation": sarek_p.get("skip_annotation", False), "skip_baserecalibrator": sarek_p.get("skip_baserecalibrator", False),
            "staged_at": time.time(), "input_type": original_meta.input_type,
            "input_filenames": input_p, "sample_info": original_meta.sample_info,
            "is_rerun": True, "original_job_id": job_id,
        }
        redis_conn.hset(STAGED_JOBS_KEY, new_staged_job_id, json.dumps(new_job_details_for_redis))
        logger.info(f"Re-staged job {job_id} as {new_staged_job_id} with run name '{new_rerun_name}'.")
        return JSONResponse(content={"message": f"Re-staged as {new_staged_job_id}.", "staged_job_id": new_staged_job_id})

    except NoSuchJobError: raise HTTPException(status_code=404, detail=f"Original job '{job_id}' not found.")
    except HTTPException as e:
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): os.remove(new_temp_csv_file_path)
        raise e
    except Exception as e:
        logger.exception(f"Error re-staging job {job_id}: {e}")
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists(): os.remove(new_temp_csv_file_path)
        raise HTTPException(status_code=500, detail=f"Error re-staging job: {str(e)}")
