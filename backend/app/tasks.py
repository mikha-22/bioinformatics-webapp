# backend/app/tasks.py
import subprocess
import logging
from pathlib import Path
import time
import psutil
# import math # Not strictly needed for this change, but was present
import json
import os
import select
import redis
import re
from typing import Optional, List, Dict, Any, Set

from rq import get_current_job, Queue
from rq.job import Job, JobStatus

from .core.config import (
    RESULTS_DIR, REDIS_HOST, REDIS_PORT, REDIS_DB,
    LOG_CHANNEL_PREFIX, LOG_HISTORY_PREFIX,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL
)
APP_NOTIFICATIONS_CHANNEL = "app_notifications"


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(process)d - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

MONITORING_INTERVAL_SECONDS = 5
METADATA_FILENAME = "run_metadata.json"
TRACE_FILENAME = "execution_trace.txt"

TRACE_CHECK_INTERVAL_SECONDS = 10
META_SAVE_INTERVAL_SECONDS = 15

try:
    redis_log_handler = redis.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        db=REDIS_DB,
        decode_responses=True # Keep True for publishing strings
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
    # Ensure line is stripped before JSON encoding
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
            f.seek(last_read_size)
            for line in f:
                new_lines_parsed_count +=1
                line = line.strip()
                if not line or line.startswith("task_id\t"):
                    continue
                parts = line.split('\t')
                if len(parts) > 4: # Basic check for enough columns
                    task_hash = parts[1]
                    task_status = parts[4].upper() # status is typically in column 5 (index 4)
                    if task_hash and task_hash != '-': # Ensure hash is valid
                        submitted_hashes_set.add(task_hash)
                        if task_status == 'COMPLETED':
                            completed_hashes_set.add(task_hash)
                else:
                    logger.warning(f"[Job {job_id_for_log}] Malformed trace line (not enough columns): {line}")
        
        if new_lines_parsed_count > 0:
            logger.debug(f"[Job {job_id_for_log}] Parsed {new_lines_parsed_count} new lines from trace file. Submitted: {len(submitted_hashes_set)}, Completed: {len(completed_hashes_set)}")
        return current_size, submitted_hashes_set, completed_hashes_set
    except FileNotFoundError:
        # This can happen if the trace file is created late or removed.
        logger.warning(f"[Job {job_id_for_log}] Trace file not found during incremental parse: {trace_file_path}")
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
        logger.warning(f"[Job {job_id}] run_name_from_caller was empty, using generated: {current_run_name}")

    job_id_suffix = "NOSUFF"
    if job_id and not job_id.startswith("N/A (") and len(job_id) >= 6:
        job_id_suffix = job_id[-6:]
    else:
        logger.warning(f"[Job {job_id}] Could not generate a 6-char suffix. Using 'NOSUFF'. Original ID: {job_id}")

    logger.info(f"[Job {job_id}] Starting Sarek pipeline task for Run Name: '{current_run_name}', Suffix: '{job_id_suffix}'...")
    publish_and_store_log(job_id, "info", f"Starting Sarek task (Run Name: '{current_run_name}', Suffix: '{job_id_suffix}', Input: {Path(input_csv_path_str).name}, Genome: {genome}, Step: {step})")
    
    script_path = Path(__file__).resolve().parent / "sarek_pipeline.sh"
    if not script_path.exists():
         error_msg = f"CRITICAL: Sarek wrapper script not found at {script_path}"
         logger.error(f"[Job {job_id}] {error_msg}")
         publish_and_store_log(job_id, "error", error_msg)
         raise FileNotFoundError(f"Sarek wrapper script not found: {script_path}")
    if not os.access(script_path, os.X_OK):
        error_msg = f"CRITICAL: Sarek wrapper script is not executable: {script_path}"
        logger.error(f"[Job {job_id}] {error_msg}")
        publish_and_store_log(job_id, "error", error_msg)
        raise PermissionError(f"Sarek wrapper script not executable: {script_path}")

    command = [
        "bash", str(script_path),
        current_run_name,
        input_csv_path_str, outdir_base_path_str, genome,
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
    logger.info(f"[Job {job_id}] Running command in directory: {script_working_dir}")
    command_str = ' '.join(f'"{arg}"' if ' ' in arg else arg for arg in command)
    logger.info(f"[Job {job_id}] Command: {command_str}")
    publish_and_store_log(job_id, "info", f"Executing: {command_str}")

    subprocess_env = os.environ.copy()
    user_home = os.path.expanduser("~")
    subprocess_env["HOME"] = user_home
    subprocess_env["NXF_HOME"] = os.path.join(user_home, ".nextflow")
    logger.info(f"[Job {job_id}] Setting HOME={subprocess_env['HOME']} and NXF_HOME={subprocess_env['NXF_HOME']} for subprocess.")
    subprocess_env["NXF_ANSI_LOG"] = "false" # Disable ANSI color codes in Nextflow output

    peak_memory_mb = 0
    cpu_percentages = []
    process_psutil = None
    start_time_task = time.time()
    process = None
    nf_process_regex = re.compile(r"(?:Submitted process|Starting process) >\s*([^\s\(]+)")
    nf_overall_progress_regex = re.compile(r"\[\s*(\d+)%\s*\]\s*(\d+)\s*of\s*(\d+)\s*processes")

    try:
        logger.info(f"[Job {job_id}] Preparing to execute Popen...")
        publish_and_store_log(job_id, "info", "Pipeline process starting...")
        try:
            process = subprocess.Popen(
                command, cwd=str(script_working_dir), stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, bufsize=1, # line-buffered
                encoding='utf-8', errors='replace', # Ensure proper text handling
                env=subprocess_env,
            )
            logger.info(f"[Job {job_id}] Popen successful. PID: {process.pid}")
            publish_and_store_log(job_id, "info", f"Pipeline process started (PID: {process.pid}).")

            if job and redis_log_handler:
                start_notification_payload = {
                    "event_type": "job_started", "job_id": job_id,
                    "run_name": job.meta.get('run_name', current_run_name),
                    "message": f"Job '{job.meta.get('run_name', current_run_name)}' has started processing.",
                    "status_variant": "info"
                }
                try:
                    redis_log_handler.publish(APP_NOTIFICATIONS_CHANNEL, json.dumps(start_notification_payload))
                    logger.info(f"[Job {job_id}] Published 'job_started' notification.")
                except Exception as e_pub_start:
                    logger.error(f"[Job {job_id}] Failed to publish job_started notification: {e_pub_start}")
        except Exception as popen_err:
            error_msg = f"CRITICAL ERROR starting pipeline process: {popen_err}"
            logger.exception(f"[Job {job_id}] {error_msg}")
            publish_and_store_log(job_id, "error", error_msg)
            raise popen_err

        try:
            process_psutil = psutil.Process(process.pid)
            process_psutil.cpu_percent(interval=None) 
            time.sleep(0.1) 
        except psutil.NoSuchProcess:
            logger.warning(f"[Job {job_id}] Process {process.pid} finished before monitoring could start.")
            process_psutil = None
        except Exception as init_monitor_err:
            logger.error(f"[Job {job_id}] Error initializing resource monitor for PID {process.pid}: {init_monitor_err}")
            process_psutil = None

        stdout_buffer = ""
        stderr_buffer = ""
        
        # Ensure streams are valid before adding to select list
        streams_to_select = []
        if process.stdout and process.stdout.fileno() >= 0: streams_to_select.append(process.stdout)
        if process.stderr and process.stderr.fileno() >= 0: streams_to_select.append(process.stderr)

        if not streams_to_select and process.poll() is None: # Check if process is still running
             error_msg = "Both stdout and stderr are None/invalid after Popen, but process is running."
             logger.error(f"[Job {job_id}] {error_msg}")
             publish_and_store_log(job_id, "error", "Pipeline streams unavailable after start.")
             # Consider if this is a fatal error for the task
             # For now, we might let it proceed to wait() but it won't capture logs.

        while True: # Loop until process finishes and all streams are drained
            return_code = process.poll()
            
            readable_streams = []
            if streams_to_select: # Only call select if there are streams to monitor
                try:
                    readable_streams, _, _ = select.select(streams_to_select, [], [], 0.2)
                except ValueError as select_err: # Happens if a file descriptor is closed/invalid
                    logger.warning(f"[Job {job_id}] Select error (stream likely closed): {select_err}. Pruning streams.")
                    # Remove invalid streams
                    valid_streams = []
                    for s in streams_to_select:
                        try:
                            if s.fileno() >= 0 and not s.closed: valid_streams.append(s)
                        except: pass # Ignore errors checking closed streams
                    streams_to_select = valid_streams
                    if not streams_to_select and return_code is not None: break # All streams gone and process ended
                    continue # Retry select with valid streams

            # Process readable streams
            for stream_item in readable_streams:
                try:
                    data = stream_item.read(4096) # Read available data
                    if not data: # EOF for this specific stream
                        logger.debug(f"[Job {job_id}] EOF for stream {stream_item.fileno()}. Closing and removing.")
                        stream_item.close()
                        streams_to_select.remove(stream_item)
                        continue

                    if stream_item is process.stdout:
                        stdout_buffer += data
                        while '\n' in stdout_buffer:
                            line, stdout_buffer = stdout_buffer.split('\n', 1)
                            log_line = line.strip() # Strip here for consistency
                            if log_line: # Avoid publishing empty lines
                                logger.info(f"[Job {job_id}][STDOUT] {log_line}")
                                publish_and_store_log(job_id, "stdout", log_line)
                                # ... (NF progress parsing, results_dir parsing) ...
                                if not final_results_dir_str and "Results directory:" in line:
                                    try:
                                        final_results_dir_str = line.split("Results directory:", 1)[1].strip()
                                        logger.info(f"[Job {job_id}] Parsed results directory from stdout: {final_results_dir_str}")
                                        if final_results_dir_str:
                                            trace_file_path_obj = Path(final_results_dir_str) / TRACE_FILENAME
                                            logger.info(f"[Job {job_id}] Trace file path set to: {trace_file_path_obj}")
                                    except IndexError:
                                        logger.warning(f"[Job {job_id}] Could not parse results directory from line: {log_line}")

                    elif stream_item is process.stderr:
                        stderr_buffer += data
                        while '\n' in stderr_buffer:
                            line, stderr_buffer = stderr_buffer.split('\n', 1)
                            log_line = line.strip() # Strip here
                            if log_line:
                                logger.warning(f"[Job {job_id}][STDERR] {log_line}")
                                publish_and_store_log(job_id, "stderr", log_line)
                except (OSError, ValueError) as e: # Catch read errors
                     logger.error(f"[Job {job_id}] Error reading from stream {stream_item.fileno()}: {e}")
                     if stream_item in streams_to_select:
                         try: stream_item.close()
                         except Exception: pass
                         streams_to_select.remove(stream_item)
            
            # If process has finished and no streams are left in select list (or were never there)
            if return_code is not None and not streams_to_select:
                logger.debug(f"[Job {job_id}] Process finished and no more streams to select. Exiting read loop.")
                break
            
            # If process finished, but select timed out (no readable streams currently)
            # This means streams might still have data but are not signaling select, or are closed.
            if return_code is not None and not readable_streams:
                logger.debug(f"[Job {job_id}] Process finished, select timed out. Attempting final drain if streams still open.")
                # Try to drain any remaining open streams that weren't caught by select
                for s in streams_to_select[:]: # Iterate copy
                    if not s.closed:
                        try:
                            remaining_data = s.read() # Blocking read
                            if remaining_data:
                                if s is process.stdout: stdout_buffer += remaining_data
                                elif s is process.stderr: stderr_buffer += remaining_data
                            s.close()
                        except Exception as e_drain:
                            logger.error(f"[Job {job_id}] Error during final drain of stream {s.fileno()}: {e_drain}")
                    if s in streams_to_select: streams_to_select.remove(s)
                if not streams_to_select: break # All streams processed/closed

            # Resource monitoring and meta saving (can stay here)
            if process_psutil and process.poll() is None:
                 try:
                     cpu = process_psutil.cpu_percent(interval=0.1) 
                     if cpu is not None: cpu_percentages.append(cpu)
                     mem_info = process_psutil.memory_info()
                     current_memory_mb = mem_info.rss / (1024 * 1024)
                     peak_memory_mb = max(peak_memory_mb, current_memory_mb)
                 except psutil.NoSuchProcess: process_psutil = None
                 except Exception as monitor_err: logger.error(f"[Job {job_id}] Error during resource monitoring: {monitor_err}")

            current_time = time.time()
            if job and trace_file_path_obj and (current_time - last_trace_check_time > TRACE_CHECK_INTERVAL_SECONDS):
                # ... (trace parsing logic - unchanged) ...
                last_trace_check_time = current_time
                logger.debug(f"[Job {job_id}] Checking trace file: {trace_file_path_obj}")
                
                new_size, updated_submitted, updated_completed = parse_trace_file_incrementally(
                    job_id, trace_file_path_obj, last_trace_file_size, processed_task_hashes, completed_task_hashes
                )
                last_trace_file_size = new_size
                processed_task_hashes = updated_submitted
                completed_task_hashes = updated_completed

                submitted_count = len(processed_task_hashes)
                completed_count = len(completed_task_hashes)
                
                if submitted_count > 0:
                    overall_progress_trace = round((completed_count / submitted_count) * 100, 1)
                    if overall_progress_trace > job.meta.get('overall_progress', -1) or submitted_count > job.meta.get('submitted_task_count', 0):
                         job.meta['overall_progress'] = overall_progress_trace
                         job.meta['submitted_task_count'] = submitted_count
                         job.meta['completed_task_count'] = completed_count
                         logger.info(f"[Job {job_id}] Progress (Trace): {completed_count}/{submitted_count} ({overall_progress_trace:.1f}%)")

                if current_time - last_meta_save_time > META_SAVE_INTERVAL_SECONDS:
                    try:
                        job.save_meta()
                        last_meta_save_time = current_time
                        logger.info(f"[Job {job_id}] Job meta saved with progress. Current Task: {job.meta.get('current_task')}, Overall: {job.meta.get('overall_progress')}%")
                    except Exception as e_meta_save:
                        logger.error(f"[Job {job_id}] Failed to save meta during progress update: {e_meta_save}")


        logger.info(f"[Job {job_id}] Exited main read loop.")

        # --- MODIFIED: Process remaining buffer content line by line ---
        if stdout_buffer:
            logger.info(f"[Job {job_id}] Processing remaining stdout buffer ({len(stdout_buffer)} chars).")
            lines = stdout_buffer.split('\n')
            for i, line_part in enumerate(lines):
                log_line = line_part.strip()
                if log_line or (i < len(lines) - 1): # Publish if not empty OR if it's not the last part (which might be empty if buffer ended with \n)
                    logger.info(f"[Job {job_id}][STDOUT_FINAL] {log_line}")
                    publish_and_store_log(job_id, "stdout", log_line)
                    if not final_results_dir_str and "Results directory:" in line_part:
                        try: final_results_dir_str = line_part.split("Results directory:", 1)[1].strip(); logger.info(f"[Job {job_id}] Parsed results directory from final stdout: {final_results_dir_str}")
                        except IndexError: pass
        if stderr_buffer:
            logger.info(f"[Job {job_id}] Processing remaining stderr buffer ({len(stderr_buffer)} chars).")
            lines = stderr_buffer.split('\n')
            for i, line_part in enumerate(lines):
                log_line = line_part.strip()
                if log_line or (i < len(lines) - 1):
                    logger.warning(f"[Job {job_id}][STDERR_FINAL] {log_line}")
                    publish_and_store_log(job_id, "stderr", log_line)
        # --- END MODIFICATION ---

        if process.poll() is None: # Ensure process has truly finished
            logger.info(f"[Job {job_id}] Waiting for process to complete...")
            final_rc = process.wait() # This will block until the process is done
            logger.info(f"[Job {job_id}] Process wait() completed with rc: {final_rc}")
        else:
            final_rc = process.returncode
        
        end_time_task = time.time()
        duration_seconds = end_time_task - start_time_task
        log_message = f"Pipeline process {process.pid} finished with code {final_rc} after {duration_seconds:.2f}s."
        logger.info(f"[Job {job_id}] {log_message}")
        publish_and_store_log(job_id, "info", log_message)
        average_cpu = sum(cpu_percentages) / len(cpu_percentages) if cpu_percentages else 0

        # ... (rest of the meta saving, success/failure logic - largely unchanged) ...
        if job and trace_file_path_obj and trace_file_path_obj.is_file():
            logger.info(f"[Job {job_id}] Performing final trace file parse for {trace_file_path_obj}")
            new_size, updated_submitted, updated_completed = parse_trace_file_incrementally(
                job_id, trace_file_path_obj, last_trace_file_size, processed_task_hashes, completed_task_hashes
            )
            processed_task_hashes = updated_submitted
            completed_task_hashes = updated_completed
            job.meta['submitted_task_count'] = len(processed_task_hashes)
            job.meta['completed_task_count'] = len(completed_task_hashes)
            if len(processed_task_hashes) > 0:
                job.meta['overall_progress'] = round((len(completed_task_hashes) / len(processed_task_hashes)) * 100, 1)
            elif job.meta.get('overall_progress') is None and final_rc == 0 : # If no tasks but success, mark 100%
                job.meta['overall_progress'] = 100.0

        if job:
            job.meta['peak_memory_mb'] = round(peak_memory_mb, 1)
            job.meta['average_cpu_percent'] = round(average_cpu, 1)
            job.meta['duration_seconds'] = round(duration_seconds, 2)
            if final_rc == 0: job.meta['current_task'] = "Completed"
            else: job.meta['current_task'] = f"Failed: {job.meta.get('current_task', 'Unknown Step')}"
            try:
                job.save_meta()
                logger.info(f"[Job {job_id}] Saved final resource/progress stats and task status to job meta.")
            except Exception as e_final_meta:
                 logger.error(f"[Job {job_id}] Error saving final job meta: {e_final_meta}")

        # --- Check success based on final_rc and script output ---
        # The script sarek_pipeline.sh should output "status::success" on its own stdout if Nextflow exits 0
        # We need to check the *captured* stdout for this marker.
        full_stdout_for_check = "".join(job.meta.get("stdout_lines", [])) # Assuming you might store them in meta
        # Or, if not storing full stdout in meta, rely on the last few captured lines or a flag set during capture.
        # For now, let's assume the script's "status::success" is reliable if final_rc is 0.
        
        # A more robust check would be to parse the COMMAND_LOG_FILE from the shell script if needed,
        # but let's first ensure Python captures everything.
        # The `sarek_pipeline.sh` script itself exits with 0 if Nextflow was successful.
        job_succeeded = (final_rc == 0) # Simpler: trust the script's exit code.

        if job_succeeded:
            success_message = f"Sarek pipeline finished successfully (Exit Code {final_rc})."
            logger.info(f"[Job {job_id}] {success_message}")
            publish_and_store_log(job_id, "info", success_message)
            if final_results_dir_str:
                results_path_obj = Path(final_results_dir_str)
                if results_path_obj.is_dir():
                     logger.info(f"[Job {job_id}] Confirmed results directory exists: {final_results_dir_str}")
                     publish_and_store_log(job_id, "info", f"Results directory: {final_results_dir_str}")
                     if job:
                          job.meta['results_path'] = final_results_dir_str
                          job.save_meta() 
                          try: 
                              metadata_to_save = job.meta.copy(); metadata_file_path = results_path_obj / METADATA_FILENAME
                              with open(metadata_file_path, 'w') as f: json.dump(metadata_to_save, f, indent=4)
                              logger.info(f"[Job {job_id}] Saved run metadata to {metadata_file_path}")
                          except Exception as meta_err: logger.error(f"[Job {job_id}] Failed to save run metadata file: {meta_err}")
                     return { "status": "success", "results_path": final_results_dir_str, "resources": job.meta if job else {} }
                else: 
                     error_message = f"Pipeline reported success, but results directory '{final_results_dir_str}' not found!"
                     logger.error(f"[Job {job_id}] {error_message}"); publish_and_store_log(job_id, "error", error_message)
                     if job: job.meta['error_message'] = error_message; job.save_meta()
                     job_succeeded = False; raise RuntimeError(error_message) # This will make the job fail in RQ
            else: 
                warn_message = "Pipeline finished successfully, but could not determine results directory from output."
                logger.warning(f"[Job {job_id}] {warn_message}"); publish_and_store_log(job_id, "warning", warn_message)
                if job: job.meta['warning_message'] = "Pipeline finished, results dir unclear."; job.save_meta()
                return { "status": "success", "message": "Pipeline finished, results directory unclear.", "resources": job.meta if job else {} }
        else: # Job failed
            error_message = f"Sarek pipeline failed. Exit Code: {final_rc}."
            # The stderr_buffer should contain the relevant error snippet if captured correctly
            stderr_to_log = stderr_buffer[-2000:].strip() if stderr_buffer else "No stderr captured or stderr was empty."
            if not stderr_to_log and job and job.meta.get('stderr_snippet'): # Fallback to meta if buffer is empty
                stderr_to_log = job.meta['stderr_snippet']

            logger.error(f"[Job {job_id}] {error_message}"); publish_and_store_log(job_id, "error", error_message)
            logger.error(f"[Job {job_id}] STDERR Tail (from buffer/meta):\n{stderr_to_log}")
            # Publish existing stderr_buffer line by line if it wasn't done already
            # (The loop above should have handled most of it)
            if job: 
                job.meta['error_message'] = error_message
                job.meta['stderr_snippet'] = stderr_to_log # Store the most relevant part
                job.save_meta()
            raise subprocess.CalledProcessError(final_rc or 1, command, output=stdout_buffer, stderr=stderr_buffer)


    except subprocess.TimeoutExpired as e:
        # ... (same as before) ...
        error_msg = "Sarek pipeline timed out."; logger.error(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", error_msg)
        stderr_output = e.stderr if e.stderr else 'N/A'
        if job: job.meta['error_message'] = error_msg; job.meta['stderr_snippet'] = stderr_output[:1000]; job.meta['current_task'] = "Timed Out"; job.save_meta()
        job_succeeded = False; raise
    except FileNotFoundError as e:
         # ... (same as before) ...
         error_msg = f"Error executing pipeline: {e}"; logger.error(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", error_msg)
         if job: job.meta['error_message'] = f"Task execution error: {e}"; job.meta['current_task'] = "Setup Error"; job.save_meta()
         job_succeeded = False; raise
    except Exception as e:
        # ... (same as before) ...
        error_msg = f"An unexpected error occurred during pipeline execution: {type(e).__name__}"; logger.exception(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", f"{error_msg}: {e}")
        if job: job.meta['error_message'] = error_msg; job.meta['error_details'] = str(e); job.meta['current_task'] = "Unexpected Error"; job.save_meta()
        job_succeeded = False; raise
    finally:
        # ... (same finally block as before for EOF, notifications, TTL, CSV cleanup) ...
        list_key = f"{LOG_HISTORY_PREFIX}{job_id}"
        try:
            if job_id and not job_id.startswith("N/A") and redis_log_handler:
                publish_and_store_log(job_id, "control", "EOF") # Ensure EOF is last
                logger.info(f"[Job {job_id}] Published EOF marker to log channel and list.")
                if job: 
                    event_type = "job_completed" if job_succeeded else "job_failed"
                    status_text = "completed successfully" if job_succeeded else "failed"
                    
                    user_message = f"Job '{job.meta.get('run_name', job_id)}' {status_text}."
                    if not job_succeeded:
                        failure_reason = job.meta.get('error_message', 'Unknown error')
                        if len(failure_reason) > 150: failure_reason = failure_reason[:147] + "..."
                        user_message += f" Reason: {failure_reason}"

                    notification_payload = {
                        "event_type": event_type, "job_id": job_id,
                        "run_name": job.meta.get('run_name', job_id),
                        "message": user_message,
                        "status_variant": "success" if job_succeeded else "error"
                    }
                    try:
                        redis_log_handler.publish(APP_NOTIFICATIONS_CHANNEL, json.dumps(notification_payload))
                        logger.info(f"[Job {job_id}] Published '{event_type}' notification.")
                    except Exception as e_pub:
                        logger.error(f"[Job {job_id}] Failed to publish job status notification: {e_pub}")
                
                final_ttl = DEFAULT_RESULT_TTL if job_succeeded else DEFAULT_FAILURE_TTL
                if job:
                    ttl_to_use = job.result_ttl if job_succeeded else job.failure_ttl
                    if ttl_to_use is not None and ttl_to_use >= 0 : final_ttl = ttl_to_use
                    elif ttl_to_use == -1: final_ttl = -1 # Persist
                if final_ttl > 0: redis_log_handler.expire(list_key, final_ttl); logger.info(f"[Job {job_id}] Set TTL={final_ttl}s for log history: {list_key}")
                elif final_ttl == -1: redis_log_handler.persist(list_key); logger.info(f"[Job {job_id}] Persisted log history: {list_key}")
                else: logger.warning(f"[Job {job_id}] TTL is 0 or invalid ({final_ttl}). Deleting log history: {list_key}"); redis_log_handler.delete(list_key)
        except redis.exceptions.RedisError as e: logger.error(f"[Job {job_id}] Redis error during final log cleanup for {list_key}: {e}")
        except Exception as e: logger.error(f"[Job {job_id}] Unexpected error during final log cleanup: {e}")

        if input_csv_path_str and Path(input_csv_path_str).exists():
            try: os.remove(input_csv_path_str); logger.info(f"[Job {job_id}] Cleaned up temporary CSV: {input_csv_path_str}")
            except OSError as remove_e: logger.warning(f"[Job {job_id}] Could not clean up temp CSV {input_csv_path_str}: {remove_e}")
