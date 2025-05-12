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
    RESULTS_DIR, LOG_HISTORY_PREFIX, DATA_DIR # Ensure DATA_DIR is imported
)
from ..core.redis_rq import get_redis_connection, get_pipeline_queue
from ..models.pipeline import PipelineInput, JobStatusDetails, JobResourceInfo, JobMeta, SampleInfo
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

    sanitized_run_name = input_data.run_name.replace(" ", "_").strip()
    if not sanitized_run_name: # Pydantic should catch min_len=1, but defensive
        validation_errors.append("Run Name cannot be empty or only spaces after sanitization.")

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

            "joint_germline": input_data.joint_germline, "wes": input_data.wes,
            "trim_fastq": input_data.trim_fastq, "skip_qc": input_data.skip_qc,
            "skip_annotation": input_data.skip_annotation, "skip_baserecalibrator": input_data.skip_baserecalibrator,

            "staged_at": time.time(), # Timestamp for when it was staged
            "input_type": input_data.input_type,
            # Store original relative paths for input_filenames for potential re-run reference
            "input_filenames": {k: getattr(input_data, k) for k in ["intervals_file", "dbsnp", "known_indels", "pon"] if getattr(input_data, k) is not None},
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
    user_run_description = details.get("run_description")
    sarek_config_description = details.get("sarek_internal_description")

    job_args_for_task = (
        run_name,
        details["input_csv_path"], details["outdir_base_path"], details["genome"],
        details.get("tools"), details["step"], details.get("profile"),
        details.get("intervals_path"), details.get("dbsnp_path"),
        details.get("known_indels_path"), details.get("pon_path"),
        details.get("aligner"), details.get("joint_germline", False),
        details.get("wes", False), details.get("trim_fastq", False),
        details.get("skip_qc", False), details.get("skip_annotation", False),
        details.get("skip_baserecalibrator", False),
        details.get("is_rerun", False),
    )

    rq_job_id = staged_job_id.replace("staged_", "rqjob_")
    if rq_job_id == staged_job_id: rq_job_id = f"rqjob_{uuid.uuid4()}"
    try:
        if Job.exists(rq_job_id, connection=queue.connection):
            logger.warning(f"RQ job ID {rq_job_id} already exists. Generating new unique ID.")
            rq_job_id = f"rqjob_{uuid.uuid4()}"
    except Exception: pass

    meta_for_rq_job_obj = JobMeta(
        run_name=run_name,
        input_type=details.get("input_type"),
        input_params=details.get("input_filenames"),
        sarek_params={
            "genome": details.get("genome"), "tools": details.get("tools"), "step": details.get("step"),
            "profile": details.get("profile"), "aligner": details.get("aligner"),
            "joint_germline": details.get("joint_germline"), "wes": details.get("wes"),
            "trim_fastq": details.get("trim_fastq"), "skip_qc": details.get("skip_qc"),
            "skip_annotation": details.get("skip_annotation"), "skip_baserecalibrator": details.get("skip_baserecalibrator"),
            "description": sarek_config_description,
        },
        sample_info=details.get("sample_info"),
        staged_job_id_origin=staged_job_id,
        input_csv_path_used=details.get("input_csv_path"),
        is_rerun_execution=details.get("is_rerun", False),
        original_job_id=details.get("original_job_id"),
    )
    meta_as_dict_for_rq = meta_for_rq_job_obj.model_dump(exclude_none=True)

    try:
        rq_job = queue.enqueue(
            run_pipeline_task, args=job_args_for_task, job_timeout=DEFAULT_JOB_TIMEOUT,
            result_ttl=DEFAULT_RESULT_TTL, failure_ttl=DEFAULT_FAILURE_TTL,
            job_id=rq_job_id, meta=meta_as_dict_for_rq,
            description=user_run_description
        )
        logger.info(f"Enqueued job {rq_job.id} (Run Name: '{run_name}').")
    except Exception as e:
        logger.exception(f"Failed to enqueue job to RQ for {staged_job_id}: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Could not enqueue job.")

    redis_conn.hdel(STAGED_JOBS_KEY, staged_job_id)
    logger.info(f"Removed staged job entry {staged_job_id} after enqueue.")
    return JSONResponse(status_code=202, content={"message": "Job enqueued.", "job_id": rq_job.id, "status": "queued"})


@router.get("/jobs_list", response_model=List[JobStatusDetails], summary="List All Relevant Jobs")
async def get_jobs_list(
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    all_jobs_for_frontend: List[JobStatusDetails] = []
    processed_rq_ids = set()

    try:
        staged_jobs_raw = redis_conn.hgetall(STAGED_JOBS_KEY)
        for job_id_bytes, job_details_bytes in staged_jobs_raw.items():
            job_id_str = job_id_bytes.decode('utf-8')
            try:
                details = json.loads(job_details_bytes.decode('utf-8'))
                meta_obj = JobMeta(
                    run_name=details.get("run_name"),
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
                    staged_job_id_origin=job_id_str,
                    input_csv_path_used=details.get("input_csv_path")
                )
                all_jobs_for_frontend.append(JobStatusDetails(
                    job_id=job_id_str,
                    run_name=details.get("run_name"),
                    status="staged",
                    description=details.get("run_description"),
                    staged_at=details.get("staged_at"),
                    enqueued_at=None, started_at=None, ended_at=None,
                    meta=meta_obj
                ))
                processed_rq_ids.add(job_id_str)
            except Exception as e: logger.error(f"Error parsing staged job {job_id_str}: {e}")
    except redis.exceptions.RedisError as e: logger.error(f"Redis error fetching staged jobs: {e}")

    registries_config = {
        "queued": {"registry": queue, "limit": -1},
        "started": {"registry": StartedJobRegistry(queue=queue), "limit": -1},
        "finished": {"registry": FinishedJobRegistry(queue=queue), "limit": MAX_REGISTRY_JOBS},
        "failed": {"registry": FailedJobRegistry(queue=queue), "limit": MAX_REGISTRY_JOBS},
        "canceled": {"registry": CanceledJobRegistry(queue=queue), "limit": MAX_REGISTRY_JOBS},
    }
    all_rq_job_ids = set()
    for status_name, config in registries_config.items():
        try:
            ids_in_reg = config["registry"].get_job_ids() if isinstance(config["registry"], Queue) else \
                         config["registry"].get_job_ids(0, config["limit"] -1 if config["limit"] > 0 else -1)
            if status_name in ["finished", "failed", "canceled"] and config["limit"] > 0 and ids_in_reg : ids_in_reg.reverse()
            all_rq_job_ids.update(ids_in_reg)
        except Exception as e: logger.error(f"Error fetching from {status_name} registry: {e}")

    unique_rq_ids_to_fetch = list(all_rq_job_ids - processed_rq_ids)
    if unique_rq_ids_to_fetch:
        try:
            fetched_rq_jobs = Job.fetch_many(unique_rq_ids_to_fetch, connection=queue.connection, serializer=queue.serializer)
            for job in fetched_rq_jobs:
                if job:
                    current_status = job.get_status(refresh=False)
                    job_meta_dict = job.meta or {}
                    meta_obj = JobMeta(**job_meta_dict)

                    error_summary = None
                    if current_status == JobStatus.FAILED:
                        error_summary = meta_obj.error_message or "Job failed"
                        if job.exc_info and (not meta_obj.error_message or meta_obj.error_message == "Job failed") :
                            try: error_summary = job.exc_info.strip().split('\n')[-1]
                            except: pass
                        if meta_obj.stderr_snippet: error_summary += f" (stderr: ...{meta_obj.stderr_snippet[-100:]})"

                    resources = JobResourceInfo(
                        peak_memory_mb=job_meta_dict.get("peak_memory_mb"),
                        average_cpu_percent=job_meta_dict.get("average_cpu_percent"),
                        duration_seconds=job_meta_dict.get("duration_seconds")
                    )
                    all_jobs_for_frontend.append(JobStatusDetails(
                        job_id=job.id,
                        run_name=meta_obj.run_name,
                        status=current_status,
                        description=job.description, # Use RQ Job's own description
                        staged_at=None, # Explicitly None for RQ jobs
                        enqueued_at=dt_to_timestamp(job.enqueued_at),
                        started_at=dt_to_timestamp(job.started_at),
                        ended_at=dt_to_timestamp(job.ended_at),
                        result=job.result, error=error_summary, meta=meta_obj,
                        resources=resources if any(v is not None for v in resources.model_dump().values()) else None
                    ))
        except Exception as e: logger.exception("Error fetching RQ job details for list.")

    def get_sort_key(job_detail: JobStatusDetails) -> float:
        return job_detail.ended_at or job_detail.started_at or \
               job_detail.enqueued_at or job_detail.staged_at or 0
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
            if not details_bytes: raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found.")
            details = json.loads(details_bytes.decode('utf-8'))
            meta_obj = JobMeta(
                run_name=details.get("run_name"),
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
                job_id=job_id, run_name=details.get("run_name"), status="staged",
                description=details.get("run_description"), staged_at=details.get("staged_at"),
                enqueued_at=None, started_at=None, ended_at=None, meta=meta_obj
            )
        else: # RQ Job
            job = Job.fetch(job_id, connection=queue.connection, serializer=queue.serializer)
            status = job.get_status(refresh=True)
            job_meta_dict = job.meta or {}
            meta_obj = JobMeta(**job_meta_dict)
            error_summary = None
            if status == JobStatus.FAILED:
                error_summary = meta_obj.error_message or "Job failed"
                if job.exc_info and (not meta_obj.error_message or meta_obj.error_message == "Job failed"):
                    try: error_summary = job.exc_info.strip().split('\n')[-1]
                    except: pass
                if meta_obj.stderr_snippet: error_summary += f" (stderr: ...{meta_obj.stderr_snippet[-100:]})"
            resources = JobResourceInfo(
                peak_memory_mb=job_meta_dict.get("peak_memory_mb"),
                average_cpu_percent=job_meta_dict.get("average_cpu_percent"),
                duration_seconds=job_meta_dict.get("duration_seconds")
            )
            return JobStatusDetails(
                job_id=job.id, run_name=meta_obj.run_name, status=status,
                description=job.description, # User's run description from RQ Job object
                staged_at=None, # Explicitly None for RQ jobs
                enqueued_at=dt_to_timestamp(job.enqueued_at),
                started_at=dt_to_timestamp(job.started_at),
                ended_at=dt_to_timestamp(job.ended_at),
                result=job.result, error=error_summary, meta=meta_obj,
                resources=resources if any(v is not None for v in resources.model_dump().values()) else None
            )
    except NoSuchJobError: raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e: # Added ValueError for Pydantic
        logger.error(f"Error parsing data for job {job_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Corrupted data for job '{job_id}'.")
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error for job {job_id}: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable: Storage error.")
    except Exception as e:
        logger.exception(f"Unexpected error for job {job_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error.")


@router.post("/stop_job/{job_id}", status_code=200, summary="Cancel Running/Queued RQ Job")
async def stop_job(
    job_id: str,
    redis_conn: redis.Redis = Depends(get_redis_connection),
    queue: Queue = Depends(get_pipeline_queue)
):
    if job_id.startswith("staged_"):
        raise HTTPException(status_code=400, detail="Cannot stop 'staged' job. Remove it instead.")
    logger.info(f"Request to stop/cancel RQ job: {job_id}")
    message = f"Action processed for job {job_id}."
    try:
        job = Job.fetch(job_id, connection=queue.connection)
        status = job.get_status(refresh=True)
        if job.is_finished or job.is_failed or job.is_stopped or job.is_canceled:
            message = f"Job already in terminal state: {status}."
        elif status == JobStatus.QUEUED:
            job.cancel()
            message = f"Queued job {job_id} canceled successfully."
            logger.info(message)
        elif status == JobStatus.STARTED or status == JobStatus.RUNNING :
            logger.info(f"Job {job_id} is {status}. Attempting to send stop signal...")
            redis_conn_for_command = redis.Redis(
                host=queue.connection.connection_pool.connection_kwargs.get('host', 'localhost'),
                port=queue.connection.connection_pool.connection_kwargs.get('port', 6379),
                db=queue.connection.connection_pool.connection_kwargs.get('db', 0),
                decode_responses=False
            )
            send_stop_job_command(redis_conn_for_command, job.id)
            message = f"Stop signal sent to job {job_id}."
            logger.info(message)
        else:
            message = f"Job {job_id} has status '{status}', cannot stop/cancel."
            logger.warning(message)
        return JSONResponse(content={"message": message, "job_id": job_id})
    except NoSuchJobError:
        logger.warning(f"Stop/cancel job request failed: Job ID '{job_id}' not found.")
        raise HTTPException(status_code=404, detail=f"Cannot stop/cancel job: Job '{job_id}' not found.")
    except Exception as e:
        logger.exception(f"Error stopping/canceling job {job_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Error stopping/canceling job: {str(e)}")


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
            try:
                details = json.loads(details_bytes.decode('utf-8'))
                csv_path_to_remove = details.get("input_csv_path")
            except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
                logger.warning(f"Could not parse details for staged job {job_id} during CSV path retrieval.")
        
        if redis_conn.hdel(STAGED_JOBS_KEY, job_id) == 1:
            job_removed_flag = True
            logger.info(f"Removed staged job: {job_id}")
        elif not details_bytes:
            logger.warning(f"Staged job '{job_id}' not found for removal (already gone).")
            job_removed_flag = True
        else:
             logger.error(f"Failed to remove staged job {job_id} despite it existing (hdel returned 0).")
             # Consider if this should be an error or if we proceed with cleanup if csv_path_to_remove was found
    else: # RQ Job
        try:
            job = Job.fetch(job_id, connection=queue.connection, serializer=queue.serializer)
            logger.debug(f"Fetched RQ job {job_id} successfully for removal.")

            if job.meta:
                csv_path_to_remove = job.meta.get("input_csv_path_used") or job.meta.get("input_csv_path")
                logger.debug(f"Identified potential CSV path for RQ job {job_id}: {csv_path_to_remove}")

            try:
                logger.info(f"Attempting to remove/cancel job {job_id} from queue/registries...")
                if job.is_queued: job.cancel()
                
                FinishedJobRegistry(queue=queue).remove(job, delete_job=False)
                FailedJobRegistry(queue=queue).remove(job, delete_job=False)
                CanceledJobRegistry(queue=queue).remove(job, delete_job=False)
                StartedJobRegistry(queue=queue).remove(job, delete_job=False)
                DeferredJobRegistry(queue=queue).remove(job, delete_job=False)
                ScheduledJobRegistry(queue=queue).remove(job, delete_job=False)
                logger.info(f"Attempted removal of job {job_id} from all registries.")
            except InvalidJobOperation as e:
                logger.debug(f"Job {job_id} state issue during registry removal: {e}")
            except Exception as reg_remove_err:
                logger.warning(f"Error during registry removal for job {job_id}: {reg_remove_err}")

            job.delete() # No arguments for RQ's Job.delete()
            job_removed_flag = True
            logger.info(f"RQ Job hash for {job_id} deleted.")

        except NoSuchJobError:
            logger.warning(f"RQ Job '{job_id}' not found for removal.")
            if not redis_conn.exists(f"rq:job:{job_id}"):
                job_removed_flag = True
        except Exception as e:
            logger.exception(f"Error removing RQ job {job_id}: {e}")
            job_removed_flag = False # Ensure it's false if an error occurred during RQ job removal

    if job_removed_flag:
        if csv_path_to_remove:
            try:
                csv_p = Path(csv_path_to_remove)
                if csv_p.is_file() and csv_p.suffix == '.csv' and str(csv_p.parent).startswith(tempfile.gettempdir()):
                    os.remove(csv_p)
                    logger.info(f"Cleaned up temp CSV: {csv_p}")
            except Exception as e:
                logger.warning(f"Error cleaning up CSV {csv_path_to_remove} for job {job_id}: {e}")

        if not job_id.startswith("staged_"):
            if redis_conn.delete(log_history_key) > 0:
                logger.info(f"Cleaned up log history for {job_id}: {log_history_key}")
        return JSONResponse(content={"message": f"Job {job_id} removal processed.", "removed_id": job_id})
    else:
        logger.warning(f"Job {job_id} not definitively removed or was not found.")
        if job_id.startswith("staged_"):
            if not redis_conn.hexists(STAGED_JOBS_KEY, job_id):
                 raise HTTPException(status_code=404, detail=f"Staged job '{job_id}' not found.")
        else:
            try:
                Job.fetch(job_id, connection=queue.connection)
                raise HTTPException(status_code=500, detail=f"Failed to remove RQ job '{job_id}'.")
            except NoSuchJobError:
                 raise HTTPException(status_code=404, detail=f"RQ job '{job_id}' not found.")
        raise HTTPException(status_code=500, detail=f"Failed to process removal for job {job_id}.")


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
        original_user_run_description = original_job.description # User's overall run description
        sarek_config_desc_orig = original_meta.sarek_params.get("description") if original_meta.sarek_params else None
        original_run_name_from_meta = original_meta.run_name or f"run_{job_id.replace('rqjob_','')[:8]}"

        new_rerun_name = f"{original_run_name_from_meta}_rerun_{time.strftime('%Y%m%d%H%M%S')}"
        new_rerun_user_description = f"Re-run of '{original_run_name_from_meta}'. Original desc: {original_user_run_description or 'N/A'}"

        if not original_meta.input_type or not original_meta.sarek_params or not original_meta.sarek_params.get("step") or not original_meta.sample_info:
            raise HTTPException(status_code=400, detail="Essential original parameters missing for re-run.")

        csv_headers, new_sample_rows_for_csv, validation_errors_rerun = [], [], []
        # Determine CSV headers based on input type
        current_input_type = original_meta.input_type
        if current_input_type == "fastq": csv_headers = ['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2']
        elif current_input_type == "bam_cram":
            first_s_info = original_meta.sample_info[0] if original_meta.sample_info else {}
            bam_cram_file_name = first_s_info.get('bam_cram','')
            bam_cram_col_name = 'cram' if bam_cram_file_name and bam_cram_file_name.lower().endswith('.cram') else 'bam'
            csv_headers = ['patient', 'sample', 'sex', 'status', bam_cram_col_name, 'index']
        elif current_input_type == "vcf": csv_headers = ['patient', 'sample', 'sex', 'status', 'vcf', 'index']
        else: raise ValueError(f"Unsupported input type for rerun: {current_input_type}")

        for i, sample_data_dict in enumerate(original_meta.sample_info):
            sample_obj = SampleInfo(**sample_data_dict) # Parse each sample dict into SampleInfo model
            current_row_values = [sample_obj.patient, sample_obj.sample, sample_obj.sex, sample_obj.status]

            def _resolve_path_for_rerun(relative_path_str: Optional[str], is_required: bool, allowed_extensions: Optional[List[str]] = None) -> Optional[str]:
                if not relative_path_str:
                    if is_required: validation_errors_rerun.append(f"Sample {i+1}: Missing required path string for a field."); return None
                    return "" # Return empty string for optional non-provided paths in CSV
                try:
                    # Ensure DATA_DIR is a Path object
                    base_dir = Path(DATA_DIR) if isinstance(DATA_DIR, str) else DATA_DIR
                    abs_path = get_safe_path(base_dir, relative_path_str)
                    if not abs_path.is_file():
                        validation_errors_rerun.append(f"Sample {i+1}: File '{relative_path_str}' (abs: {abs_path}) not found."); return None
                    if allowed_extensions and not any(abs_path.name.lower().endswith(ext.lower()) for ext in allowed_extensions):
                        validation_errors_rerun.append(f"Sample {i+1}: File '{relative_path_str}' has invalid extension. Allowed: {', '.join(allowed_extensions)}"); return None
                    return str(abs_path)
                except HTTPException as e_http: validation_errors_rerun.append(f"Sample {i+1}: Path error for '{relative_path_str}': {e_http.detail}"); return None
                except Exception as e_gen: validation_errors_rerun.append(f"Sample {i+1}: General error for '{relative_path_str}': {str(e_gen)}"); return None

            if current_input_type == "fastq":
                if not sample_obj.lane: validation_errors_rerun.append(f"Sample {i+1}: Missing lane for FASTQ.")
                current_row_values.extend([sample_obj.lane, _resolve_path_for_rerun(sample_obj.fastq_1, True, ['.fq.gz','.fastq.gz','.fq','.fastq']), _resolve_path_for_rerun(sample_obj.fastq_2, True, ['.fq.gz','.fastq.gz','.fq','.fastq'])])
            elif current_input_type == "bam_cram":
                bc_p = _resolve_path_for_rerun(sample_obj.bam_cram, True, ['.bam','.cram'])
                # Index is required for CRAM, optional for BAM (but Sarek might still need it)
                idx_p = _resolve_path_for_rerun(sample_obj.index, bool(bc_p and bc_p.lower().endswith('.cram')), ['.bai','.crai'])
                current_row_values.extend([bc_p, idx_p])
            elif current_input_type == "vcf":
                vcf_p_val = _resolve_path_for_rerun(sample_obj.vcf, True, ['.vcf','.vcf.gz'])
                idx_p_val = _resolve_path_for_rerun(sample_obj.index, bool(vcf_p_val and vcf_p_val.lower().endswith('.vcf.gz')), ['.tbi','.csi'])
                current_row_values.extend([vcf_p_val, idx_p_val])
            new_sample_rows_for_csv.append(current_row_values)

        if validation_errors_rerun:
            raise HTTPException(status_code=400, detail="Re-run validation errors creating samplesheet:\n" + "\n".join(validation_errors_rerun))

        with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv:
            csv_writer = csv.writer(temp_csv); csv_writer.writerow(csv_headers); csv_writer.writerows(new_sample_rows_for_csv)
            new_temp_csv_file_path = temp_csv.name

        new_staged_job_id = f"staged_{uuid.uuid4()}"
        sarek_p_orig = original_meta.sarek_params or {} # Ensure it's a dict
        input_p_orig = original_meta.input_params or {} # Ensure it's a dict

        new_job_details_for_redis = {
            "run_name": new_rerun_name, "run_description": new_rerun_user_description,
            "sarek_internal_description": sarek_config_desc_orig,
            "input_csv_path": new_temp_csv_file_path, "outdir_base_path": str(RESULTS_DIR),
            "genome": sarek_p_orig.get("genome"), "tools": sarek_p_orig.get("tools"), "step": sarek_p_orig.get("step"),
            "profile": sarek_p_orig.get("profile"), "aligner": sarek_p_orig.get("aligner"),
            "intervals_path": _resolve_path_for_rerun(input_p_orig.get("intervals_file"), False) if input_p_orig.get("intervals_file") else None,
            "dbsnp_path": _resolve_path_for_rerun(input_p_orig.get("dbsnp"), False) if input_p_orig.get("dbsnp") else None,
            "known_indels_path": _resolve_path_for_rerun(input_p_orig.get("known_indels"), False) if input_p_orig.get("known_indels") else None,
            "pon_path": _resolve_path_for_rerun(input_p_orig.get("pon"), False) if input_p_orig.get("pon") else None,
            "joint_germline": sarek_p_orig.get("joint_germline", False), "wes": sarek_p_orig.get("wes", False),
            "trim_fastq": sarek_p_orig.get("trim_fastq", False), "skip_qc": sarek_p_orig.get("skip_qc", False),
            "skip_annotation": sarek_p_orig.get("skip_annotation", False), "skip_baserecalibrator": sarek_p_orig.get("skip_baserecalibrator", False),
            "staged_at": time.time(), "input_type": original_meta.input_type,
            "input_filenames": input_p_orig, # Store original relative paths for record
            "sample_info": original_meta.sample_info, # Store original sample info for record
            "is_rerun": True, "original_job_id": job_id,
        }
        redis_conn.hset(STAGED_JOBS_KEY, new_staged_job_id, json.dumps(new_job_details_for_redis))
        logger.info(f"Re-staged job {job_id} as {new_staged_job_id} with run name '{new_rerun_name}'.")
        return JSONResponse(content={"message": f"Re-staged as {new_staged_job_id}.", "staged_job_id": new_staged_job_id})

    except NoSuchJobError: raise HTTPException(status_code=404, detail=f"Original job '{job_id}' not found.")
    except HTTPException as e:
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists():
            try: os.remove(new_temp_csv_file_path)
            except OSError: logger.warning(f"Failed to cleanup temp CSV {new_temp_csv_file_path} after HTTP error during rerun.")
        raise e
    except Exception as e:
        logger.exception(f"Error re-staging job {job_id}: {e}")
        if new_temp_csv_file_path and Path(new_temp_csv_file_path).exists():
            try: os.remove(new_temp_csv_file_path)
            except OSError: logger.warning(f"Failed to cleanup temp CSV {new_temp_csv_file_path} after unexpected error during rerun.")
        raise HTTPException(status_code=500, detail=f"Error re-staging job: {str(e)}")
