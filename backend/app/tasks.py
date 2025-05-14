# backend/app/tasks.py
import subprocess
import logging
from pathlib import Path
import time
import psutil
# import math # Not strictly needed for this feature, can be removed if not used elsewhere
import json
import os
import select
import redis
import re
from typing import Optional, List, Dict, Any, Set # Added Set

from rq import get_current_job, Queue
from rq.job import Job, JobStatus

from .core.config import (
    RESULTS_DIR, REDIS_HOST, REDIS_PORT, REDIS_DB,
    LOG_CHANNEL_PREFIX, LOG_HISTORY_PREFIX,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL
)

APP_NOTIFICATIONS_CHANNEL = "app_notifications" # From previous feature

logging.basicConfig(
    level=logging.INFO, # Consider logging.DEBUG for development of this feature
    format='%(asctime)s - %(process)d - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

MONITORING_INTERVAL_SECONDS = 5
METADATA_FILENAME = "run_metadata.json"
TRACE_FILENAME = "execution_trace.txt" # Must match what's in sarek_pipeline.sh

TRACE_CHECK_INTERVAL_SECONDS = 10
META_SAVE_INTERVAL_SECONDS = 15

try:
    redis_log_handler = redis.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        db=REDIS_DB,
        decode_responses=True
    )
    redis_log_handler.ping()
    logger.info("Redis log handler connection successful for tasks (Publish/List).")
except redis.exceptions.ConnectionError as e:
    logger.error(f"FATAL: Could not connect Redis log handler in tasks.py: {e}")
    redis_log_handler = None
except Exception as e:
    logger.error(f"FATAL: Unexpected error connecting Redis log handler in tasks.py: {e}")
    redis_log_handler = None

def get_current_job_id():
    job = get_current_job()
    return job.id if job else "N/A (Not in RQ context)"

def publish_and_store_log(job_id: str, log_type: str, line: str):
    if not redis_log_handler:
        return
    if not job_id or job_id.startswith("N/A"):
        return
    channel = f"{LOG_CHANNEL_PREFIX}{job_id}"
    list_key = f"{LOG_HISTORY_PREFIX}{job_id}"
    message = json.dumps({"type": log_type, "line": line.strip()})
    try:
        pipe = redis_log_handler.pipeline()
        pipe.publish(channel, message)
        pipe.rpush(list_key, message)
        pipe.execute()
    except redis.exceptions.RedisError as e:
        logger.error(f"[Job {job_id}] Redis error publishing/storing log to {channel}/{list_key}: {e}")
    except Exception as e:
        logger.error(f"[Job {job_id}] Unexpected error publishing/storing log: {e}")


def parse_trace_file_incrementally(
    job_id_for_log: str,
    trace_file_path: Path,
    last_read_size: int,
    submitted_hashes_set: Set[str],
    completed_hashes_set: Set[str]
) -> tuple[int, Set[str], Set[str]]:
    try:
        if not trace_file_path.is_file():
            return last_read_size, submitted_hashes_set, completed_hashes_set

        current_size = trace_file_path.stat().st_size
        if current_size <= last_read_size:
            return last_read_size, submitted_hashes_set, completed_hashes_set

        new_lines_parsed_count = 0
        with open(trace_file_path, 'r', encoding='utf-8', errors='replace') as f:
            if last_read_size > 0 : # Only seek if we've read before
                f.seek(last_read_size)
            
            for line in f:
                new_lines_parsed_count +=1
                line = line.strip()
                if not line or line.startswith("task_id\t"): # Skip header or empty lines
                    continue

                parts = line.split('\t')
                # From provided trace: hash=index 1, status=index 4, name=index 3
                if len(parts) >= 5: # Need at least 5 columns for status
                    task_hash = parts[1]
                    task_name_full = parts[3] # For current_task update
                    task_status = parts[4].upper()

                    if task_hash and task_hash != '-':
                        if task_hash not in submitted_hashes_set:
                            submitted_hashes_set.add(task_hash)
                            # Update current_task in job.meta when a new task hash is first seen (submitted)
                            # This gives a more "live" feel to current_task
                            job_obj = get_current_job()
                            if job_obj:
                                simple_task_name = task_name_full.split('(')[0].strip().split(':')[-1]
                                if job_obj.meta.get('current_task') != simple_task_name:
                                     job_obj.meta['current_task'] = simple_task_name
                                     # job_obj.save_meta() # Avoid saving meta too frequently here, do it in main loop
                                     logger.debug(f"[Job {job_id_for_log}] Trace: New task submitted/seen: {simple_task_name} ({task_hash})")


                        if task_status == 'COMPLETED':
                            completed_hashes_set.add(task_hash)
                else:
                    logger.warning(f"[Job {job_id_for_log}] Malformed trace line (columns < 5): {line}")
        
        if new_lines_parsed_count > 0:
            logger.info(f"[Job {job_id_for_log}] Parsed {new_lines_parsed_count} new lines from trace. Total unique submitted: {len(submitted_hashes_set)}, Total unique completed: {len(completed_hashes_set)}")
        return current_size, submitted_hashes_set, completed_hashes_set

    except FileNotFoundError:
        return last_read_size, submitted_hashes_set, completed_hashes_set
    except Exception as e:
        logger.error(f"[Job {job_id_for_log}] Error parsing trace file {trace_file_path}: {e}", exc_info=True)
        return last_read_size, submitted_hashes_set, completed_hashes_set


def run_pipeline_task(
    run_name_from_caller: str,
    input_csv_path_str: str,
    outdir_base_path_str: str,
    genome: str,
    tools: Optional[str],
    step: Optional[str],
    profile: Optional[str],
    intervals_path_str: Optional[str] = None,
    dbsnp_path_str: Optional[str] = None,
    known_indels_path_str: Optional[str] = None,
    pon_path_str: Optional[str] = None,
    aligner: Optional[str] = None,
    joint_germline: bool = False,
    wes: bool = False,
    trim_fastq: bool = False,
    skip_qc: bool = False,
    skip_annotation: bool = False,
    skip_baserecalibrator: bool = False,
    is_rerun: bool = False,
) -> Dict[str, Any]:
    job = get_current_job()
    job_id = job.id if job else get_current_job_id()
    final_results_dir_str: Optional[str] = None
    job_succeeded = False

    trace_file_path_obj: Optional[Path] = None
    last_trace_file_size: int = 0
    processed_task_hashes: Set[str] = set()
    completed_task_hashes: Set[str] = set()
    last_meta_save_time: float = time.time()
    last_trace_check_time: float = time.time()

    current_run_name = run_name_from_caller
    if not current_run_name:
        current_run_name = f"sarek_run_{time.strftime('%Y%m%d%H%M%S')}"
    job_id_suffix = "NOSUFF"
    if job_id and not job_id.startswith("N/A (") and len(job_id) >= 6:
        job_id_suffix = job_id[-6:]

    logger.info(f"[Job {job_id}] Starting Sarek pipeline task for Run Name: '{current_run_name}', Suffix: '{job_id_suffix}'...")
    publish_and_store_log(job_id, "info", f"Starting Sarek task (Run Name: '{current_run_name}', Suffix: '{job_id_suffix}', Input: {Path(input_csv_path_str).name}, Genome: {genome}, Step: {step})")
    
    script_path = Path(__file__).resolve().parent / "sarek_pipeline.sh"
    # ... (script path checks) ...
    if not script_path.exists():
         error_msg = f"CRITICAL: Sarek wrapper script not found at {script_path}"; logger.error(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", error_msg); raise FileNotFoundError(f"Sarek wrapper script not found: {script_path}") # fmt: skip
    if not os.access(script_path, os.X_OK):
        error_msg = f"CRITICAL: Sarek wrapper script is not executable: {script_path}"; logger.error(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", error_msg); raise PermissionError(f"Sarek wrapper script not executable: {script_path}") # fmt: skip

    command = [
        "bash", str(script_path), current_run_name, input_csv_path_str, outdir_base_path_str, genome,
        tools if tools else "", step if step else "", profile if profile else "",
        aligner if aligner else "", intervals_path_str if intervals_path_str else "",
        dbsnp_path_str if dbsnp_path_str else "", known_indels_path_str if known_indels_path_str else "",
        pon_path_str if pon_path_str else "", "true" if joint_germline else "false",
        "true" if wes else "false", "true" if trim_fastq else "false",
        "true" if skip_qc else "false", "true" if skip_annotation else "false",
        "true" if skip_baserecalibrator else "false", "true" if is_rerun else "false",
        job_id_suffix,
    ]
    script_working_dir = script_path.parent
    command_str = ' '.join(f'"{arg}"' if ' ' in arg else arg for arg in command)
    logger.info(f"[Job {job_id}] Executing in {script_working_dir}: {command_str}")
    publish_and_store_log(job_id, "info", f"Executing: {command_str}")

    subprocess_env = os.environ.copy(); user_home = os.path.expanduser("~"); subprocess_env["HOME"] = user_home; subprocess_env["NXF_HOME"] = os.path.join(user_home, ".nextflow"); subprocess_env["NXF_ANSI_LOG"] = "false"
    logger.info(f"[Job {job_id}] Subprocess HOME={subprocess_env['HOME']}, NXF_HOME={subprocess_env['NXF_HOME']}")

    peak_memory_mb = 0; cpu_percentages = []; process_psutil = None; start_time_task = time.time(); process = None
    nf_process_regex = re.compile(r"(?:Submitted process|Starting process) >\s*([^\s\(]+)")
    nf_overall_progress_regex = re.compile(r"\[\s*(\d+)%\s*\]\s*(\d+)\s*of\s*(\d+)\s*processes")

    try:
        publish_and_store_log(job_id, "info", "Pipeline process starting...")
        process = subprocess.Popen(command, cwd=str(script_working_dir), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=subprocess_env)
        logger.info(f"[Job {job_id}] Pipeline process started (PID: {process.pid}).")
        publish_and_store_log(job_id, "info", f"Pipeline process started (PID: {process.pid}).")
        
        try: process_psutil = psutil.Process(process.pid); process_psutil.cpu_percent(interval=None); time.sleep(0.1)
        except psutil.NoSuchProcess: logger.warning(f"[Job {job_id}] Process {process.pid} ended before monitoring."); process_psutil = None
        except Exception as e_mon: logger.error(f"[Job {job_id}] Error init monitor for PID {process.pid}: {e_mon}"); process_psutil = None

        stdout_buffer = ""; stderr_buffer = ""; streams = []
        if process.stdout: streams.append(process.stdout)
        if process.stderr: streams.append(process.stderr)
        if not streams: raise IOError("Subprocess streams unavailable.")

        while streams:
            return_code = process.poll()
            # If process ended and no more data in select, break (handles final reads)
            if return_code is not None and not select.select(streams, [], [], 0)[0]: break 
            
            readable, _, _ = select.select(streams, [], [], 0.2) # Short timeout for responsiveness

            for stream in readable:
                data = stream.read(4096)
                if not data: # EOF
                    logger.debug(f"[Job {job_id}] EOF for stream {stream.fileno()}.")
                    stream.close(); streams.remove(stream)
                    continue
                
                if stream is process.stdout:
                    stdout_buffer += data
                    while '\n' in stdout_buffer:
                        line, stdout_buffer = stdout_buffer.split('\n', 1)
                        publish_and_store_log(job_id, "stdout", line.strip())
                        # Parse current task from stdout (Nextflow process name)
                        match_pn = nf_process_regex.search(line)
                        if match_pn and job:
                            full_pn = match_pn.group(1); simple_pn = full_pn.split(':')[-1]
                            if job.meta.get('current_task') != simple_pn: job.meta['current_task'] = simple_pn # Updated later with progress
                        # Parse Nextflow's own progress line
                        match_nf_prog = nf_overall_progress_regex.search(line)
                        if match_nf_prog and job:
                            job.meta['overall_progress'] = int(match_nf_prog.group(1))
                            job.meta['completed_task_count'] = int(match_nf_prog.group(2)) # Tentative
                            job.meta['submitted_task_count'] = int(match_nf_prog.group(3)) # Tentative
                        # Parse results directory
                        if not final_results_dir_str and "Results directory:" in line:
                            final_results_dir_str = line.split("Results directory:",1)[1].strip()
                            logger.info(f"[Job {job_id}] Parsed results directory: {final_results_dir_str}")
                            if final_results_dir_str: trace_file_path_obj = Path(final_results_dir_str) / TRACE_FILENAME; logger.info(f"[Job {job_id}] Trace file path set: {trace_file_path_obj}")
                elif stream is process.stderr:
                    stderr_buffer += data
                    while '\n' in stderr_buffer:
                        line, stderr_buffer = stderr_buffer.split('\n', 1)
                        publish_and_store_log(job_id, "stderr", line.strip())
            
            # Resource Monitoring
            if process_psutil and process.poll() is None:
                try: cpu = process_psutil.cpu_percent(interval=0.1); peak_memory_mb = max(peak_memory_mb, process_psutil.memory_info().rss / (1024*1024)); cpu_percentages.append(cpu)
                except (psutil.NoSuchProcess, psutil.AccessDenied): process_psutil = None

            # Trace File Parsing & Meta Update
            current_time = time.time()
            if job and trace_file_path_obj and (current_time - last_trace_check_time > TRACE_CHECK_INTERVAL_SECONDS):
                last_trace_check_time = current_time
                if trace_file_path_obj.is_file(): # Check if file exists before parsing
                    new_size, updated_submitted, updated_completed = parse_trace_file_incrementally(job_id, trace_file_path_obj, last_trace_file_size, processed_task_hashes.copy(), completed_task_hashes.copy())
                    last_trace_file_size = new_size
                    processed_task_hashes = updated_submitted # Update sets
                    completed_task_hashes = updated_completed

                    s_count = len(processed_task_hashes)
                    c_count = len(completed_task_hashes)
                    
                    # Update meta if trace parsing provides data
                    if s_count > 0:
                        o_progress = round((c_count / s_count) * 100, 1)
                        job.meta['overall_progress'] = o_progress
                        job.meta['submitted_task_count'] = s_count
                        job.meta['completed_task_count'] = c_count
                        logger.info(f"[Job {job_id}] Progress (Trace): {c_count}/{s_count} ({o_progress:.1f}%)")
                        publish_and_store_log(job_id, "info", f"Progress: {c_count}/{s_count} tasks ({o_progress:.1f}%)")
                    
                    if current_time - last_meta_save_time > META_SAVE_INTERVAL_SECONDS:
                        try: job.save_meta(); last_meta_save_time = current_time; logger.info(f"[Job {job_id}] Job meta saved with progress. Task: {job.meta.get('current_task')}, Overall: {job.meta.get('overall_progress', 'N/A')}%")
                        except Exception as e_ms: logger.error(f"[Job {job_id}] Failed to save meta (progress): {e_ms}")
                else:
                    logger.debug(f"[Job {job_id}] Trace file not found for periodic check: {trace_file_path_obj}")


            if return_code is not None and not streams: break # Process ended and streams are now empty

        # Final processing of any buffered output
        if stdout_buffer: publish_and_store_log(job_id, "stdout", stdout_buffer.strip())
        if stderr_buffer: publish_and_store_log(job_id, "stderr", stderr_buffer.strip())

        if return_code is None: return_code = process.wait()
        end_time_task = time.time(); duration_seconds = end_time_task - start_time_task
        logger.info(f"[Job {job_id}] Pipeline process {process.pid} finished with code {return_code} after {duration_seconds:.2f}s.")
        publish_and_store_log(job_id, "info", f"Pipeline process finished (code {return_code}, {duration_seconds:.2f}s).")

        # Final trace parse
        if job and trace_file_path_obj and trace_file_path_obj.is_file():
            _, processed_task_hashes, completed_task_hashes = parse_trace_file_incrementally(job_id, trace_file_path_obj, last_trace_file_size, processed_task_hashes, completed_task_hashes)
            job.meta['submitted_task_count'] = len(processed_task_hashes)
            job.meta['completed_task_count'] = len(completed_task_hashes)
            if len(processed_task_hashes) > 0:
                job.meta['overall_progress'] = round((len(completed_task_hashes) / len(processed_task_hashes)) * 100, 1)
            elif return_code == 0 : # If successful and no tasks (e.g. all cached, or very small)
                 job.meta['overall_progress'] = 100.0


        if job:
            job.meta['peak_memory_mb'] = round(peak_memory_mb,1); job.meta['average_cpu_percent'] = round(sum(cpu_percentages)/len(cpu_percentages),1) if cpu_percentages else 0; job.meta['duration_seconds'] = round(duration_seconds,2)
            job.meta['current_task'] = "Completed" if return_code == 0 else f"Failed: {job.meta.get('current_task', 'Unknown')}"
            job.save_meta()

        job_succeeded = (return_code == 0 and "status::success" in "".join(stdout_lines))
        if job_succeeded:
            # ... (success handling as before, ensure final_results_dir_str is used)
            if final_results_dir_str:
                # ... save metadata to results_dir ...
                return { "status": "success", "results_path": final_results_dir_str, "resources": job.meta if job else {} }
            # ... (handle missing final_results_dir_str on success) ...
            return { "status": "success", "message": "Pipeline finished, results directory unclear.", "resources": job.meta if job else {} }

        else: # Failure
            # ... (failure handling as before) ...
            raise subprocess.CalledProcessError(return_code or 1, command, output="".join(stdout_lines), stderr="".join(stderr_lines))

    except subprocess.CalledProcessError as e: # Specific catch for CalledProcessError
        error_msg = f"Sarek pipeline execution failed. Exit Code: {e.returncode}."
        logger.error(f"[Job {job_id}] {error_msg}\nSTDOUT: {e.stdout}\nSTDERR: {e.stderr}")
        publish_and_store_log(job_id, "error", error_msg)
        if job: job.meta['error_message'] = error_msg; job.meta['stderr_snippet'] = (e.stderr or "")[-2000:]; job.save_meta()
        job_succeeded = False; raise # Re-raise to mark job as failed in RQ
    # ... (other specific exception handling: TimeoutExpired, FileNotFoundError) ...
    except subprocess.TimeoutExpired as e:
        error_msg = "Sarek pipeline timed out."; logger.error(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", error_msg)
        if job: job.meta['error_message'] = error_msg; job.meta['stderr_snippet'] = (e.stderr or "")[:1000]; job.meta['current_task'] = "Timed Out"; job.save_meta()
        job_succeeded = False; raise
    except FileNotFoundError as e:
         error_msg = f"Error executing pipeline (file not found): {e}"; logger.error(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", error_msg)
         if job: job.meta['error_message'] = f"Task execution error: {e}"; job.meta['current_task'] = "Setup Error"; job.save_meta()
         job_succeeded = False; raise
    except Exception as e:
        error_msg = f"An unexpected error occurred: {type(e).__name__}"; logger.exception(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", f"{error_msg}: {e}")
        if job: job.meta['error_message'] = error_msg; job.meta['error_details'] = str(e); job.meta['current_task'] = "Unexpected Error"; job.save_meta()
        job_succeeded = False; raise
    finally:
        # ... (existing finally block for EOF, TTL, notifications, CSV cleanup) ...
        # Ensure job_succeeded is correctly set before this block for notification
        list_key = f"{LOG_HISTORY_PREFIX}{job_id}"
        try:
            if job_id and not job_id.startswith("N/A") and redis_log_handler:
                publish_and_store_log(job_id, "control", "EOF")
                if job: # Publish notification
                    event_type = "job_completed" if job_succeeded else "job_failed"
                    status_text = "completed successfully" if job_succeeded else "failed"
                    run_name_for_noti = job.meta.get('run_name', job_id) if job.meta else job_id
                    user_message = f"Job '{run_name_for_noti}' {status_text}."
                    if not job_succeeded and job.meta:
                        failure_reason = job.meta.get('error_message', 'Unknown error')
                        if len(failure_reason) > 150: failure_reason = failure_reason[:147] + "..."
                        user_message += f" Reason: {failure_reason}"
                    notification_payload = { "event_type": event_type, "job_id": job_id, "run_name": run_name_for_noti, "message": user_message, "status_variant": "success" if job_succeeded else "error" }
                    try: redis_log_handler.publish(APP_NOTIFICATIONS_CHANNEL, json.dumps(notification_payload)); logger.info(f"[Job {job_id}] Published '{event_type}' notification.")
                    except Exception as e_pub: logger.error(f"[Job {job_id}] Failed to publish job status notification: {e_pub}")
                
                final_ttl = DEFAULT_RESULT_TTL if job_succeeded else DEFAULT_FAILURE_TTL
                # ... (TTL logic as before) ...
                if job:
                    ttl_to_use = job.result_ttl if job_succeeded else job.failure_ttl
                    if ttl_to_use is not None and ttl_to_use >= 0 : final_ttl = ttl_to_use
                    elif ttl_to_use == -1: final_ttl = -1 # Persist
                if final_ttl > 0: redis_log_handler.expire(list_key, final_ttl)
                elif final_ttl == -1: redis_log_handler.persist(list_key)
                else: redis_log_handler.delete(list_key) # Expire immediately if 0 or invalid
        except Exception as e_final: logger.error(f"[Job {job_id}] Error in final task cleanup: {e_final}")

        if input_csv_path_str and Path(input_csv_path_str).exists():
            try: os.remove(input_csv_path_str); logger.info(f"[Job {job_id}] Cleaned up temp CSV: {input_csv_path_str}")
            except OSError as e_rm: logger.warning(f"[Job {job_id}] Could not clean up temp CSV {input_csv_path_str}: {e_rm}")
