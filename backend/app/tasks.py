# backend/app/tasks.py
import subprocess
import logging
from pathlib import Path
import time
import psutil
import math # Not strictly needed for this change, but was present
import json
import os
import select
import redis
import re
from typing import Optional, List, Dict, Any, Set # Added Set

from rq import get_current_job, Queue
from rq.job import Job, JobStatus # Keep JobStatus

from .core.config import (
    RESULTS_DIR, REDIS_HOST, REDIS_PORT, REDIS_DB,
    LOG_CHANNEL_PREFIX, LOG_HISTORY_PREFIX,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL
)
# Assuming APP_NOTIFICATIONS_CHANNEL is still needed from previous feature
APP_NOTIFICATIONS_CHANNEL = "app_notifications"


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(process)d - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

MONITORING_INTERVAL_SECONDS = 5 # For psutil resource monitoring
METADATA_FILENAME = "run_metadata.json"
TRACE_FILENAME = "execution_trace.txt" # Consistent with sarek_pipeline.sh

# <<< --- ADDED Constants for Trace Parsing --- >>>
TRACE_CHECK_INTERVAL_SECONDS = 10 # How often to check the trace file for updates
META_SAVE_INTERVAL_SECONDS = 15   # How often to save job.meta with progress updates
# <<< --- END ADDED Constants --- >>>

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
        # logger.warning(f"[Job {job_id}] Cannot publish/store log, Redis log handler not available.") # Can be noisy
        return
    if not job_id or job_id.startswith("N/A"):
        # logger.debug(f"Skipping Redis publish/store, invalid job_id: {job_id} [TYPE: {log_type}] {line.strip()}")
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


# <<< --- ADDED Trace File Parsing Helper Function --- >>>
def parse_trace_file_incrementally(
    job_id_for_log: str, # For logging context
    trace_file_path: Path,
    last_read_size: int,
    submitted_hashes_set: Set[str],
    completed_hashes_set: Set[str]
) -> tuple[int, Set[str], Set[str]]:
    """
    Parses new lines from the Nextflow trace file.
    Returns the new file size and updated sets of task hashes.
    """
    try:
        if not trace_file_path.is_file():
            # logger.debug(f"[Job {job_id_for_log}] Trace file not yet found: {trace_file_path}")
            return last_read_size, submitted_hashes_set, completed_hashes_set

        current_size = trace_file_path.stat().st_size
        if current_size <= last_read_size:
            return last_read_size, submitted_hashes_set, completed_hashes_set # No new data or file shrunk

        new_lines_parsed_count = 0
        with open(trace_file_path, 'r', encoding='utf-8', errors='replace') as f:
            f.seek(last_read_size)
            for line in f:
                new_lines_parsed_count +=1
                line = line.strip()
                if not line or line.startswith("task_id\t"): # Skip header or empty lines
                    continue

                parts = line.split('\t')
                # Based on provided trace: hash is index 1, status is index 4
                # Ensure enough columns to prevent IndexError
                if len(parts) > 4: # Minimum columns needed for hash and status
                    task_hash = parts[1]
                    task_status = parts[4].upper() # Normalize status to uppercase

                    if task_hash and task_hash != '-': # Valid hash
                        submitted_hashes_set.add(task_hash)
                        if task_status == 'COMPLETED':
                            completed_hashes_set.add(task_hash)
                        # Could also track FAILED, CACHED etc. if needed for more detailed stats
                else:
                    logger.warning(f"[Job {job_id_for_log}] Malformed trace line (not enough columns): {line}")
        
        if new_lines_parsed_count > 0:
            logger.debug(f"[Job {job_id_for_log}] Parsed {new_lines_parsed_count} new lines from trace file. Submitted: {len(submitted_hashes_set)}, Completed: {len(completed_hashes_set)}")
        return current_size, submitted_hashes_set, completed_hashes_set

    except FileNotFoundError:
        # logger.debug(f"[Job {job_id_for_log}] Trace file not found during parsing attempt: {trace_file_path}")
        return last_read_size, submitted_hashes_set, completed_hashes_set
    except Exception as e:
        logger.error(f"[Job {job_id_for_log}] Error parsing trace file {trace_file_path}: {e}", exc_info=True)
        return last_read_size, submitted_hashes_set, completed_hashes_set # Return last known good state
# <<< --- END ADDED Trace File Parsing Helper Function --- >>>


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
    final_results_dir_str: Optional[str] = None # Store as string, convert to Path when needed
    job_succeeded = False

    # <<< --- ADDED Initialization for Progress Tracking --- >>>
    trace_file_path_obj: Optional[Path] = None
    last_trace_file_size: int = 0
    processed_task_hashes: Set[str] = set()
    completed_task_hashes: Set[str] = set()
    last_meta_save_time: float = time.time()
    last_trace_check_time: float = time.time()
    # <<< --- END Initialization --- >>>


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
    # ... (rest of initial logging and script path checks) ...
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
    subprocess_env["NXF_ANSI_LOG"] = "false"

    peak_memory_mb = 0
    cpu_percentages = []
    process_psutil = None
    start_time_task = time.time() # Renamed to avoid conflict with Nextflow's 'start'
    process = None
    nf_process_regex = re.compile(r"(?:Submitted process|Starting process) >\s*([^\s\(]+)")
    # Regex for Nextflow's own progress reporting (e.g., [ 23% ] 13 of 56 processes > ... )
    nf_overall_progress_regex = re.compile(r"\[\s*(\d+)%\s*\]\s*(\d+)\s*of\s*(\d+)\s*processes")


    try:
        logger.info(f"[Job {job_id}] Preparing to execute Popen...")
        publish_and_store_log(job_id, "info", "Pipeline process starting...")
        try:
            process = subprocess.Popen(
                command, cwd=str(script_working_dir), stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, bufsize=1, env=subprocess_env,
                # universal_newlines=True # Alternative to text=True, bufsize=1 for line buffering
            )
            logger.info(f"[Job {job_id}] Popen successful. PID: {process.pid}")
            publish_and_store_log(job_id, "info", f"Pipeline process started (PID: {process.pid}).")
        except Exception as popen_err: # ... (popen error handling)
            error_msg = f"CRITICAL ERROR starting pipeline process: {popen_err}"
            logger.exception(f"[Job {job_id}] {error_msg}")
            publish_and_store_log(job_id, "error", error_msg)
            raise popen_err


        try:
            process_psutil = psutil.Process(process.pid)
            process_psutil.cpu_percent(interval=None)
            time.sleep(0.1)
        except psutil.NoSuchProcess: # ... (psutil error handling)
            logger.warning(f"[Job {job_id}] Process {process.pid} finished before monitoring could start.")
            process_psutil = None
        except Exception as init_monitor_err:
            logger.error(f"[Job {job_id}] Error initializing resource monitor for PID {process.pid}: {init_monitor_err}")
            process_psutil = None


        stdout_lines = []
        stderr_lines = []
        stdout_buffer = ""
        stderr_buffer = ""
        streams_to_select = []
        if process.stdout: streams_to_select.append(process.stdout)
        if process.stderr: streams_to_select.append(process.stderr)

        if not streams_to_select: # ... (stream error handling)
             error_msg = "Both stdout and stderr are None/invalid after Popen."
             logger.error(f"[Job {job_id}] {error_msg}")
             publish_and_store_log(job_id, "error", "Pipeline streams unavailable after start.")
             raise IOError("Subprocess streams are not available.")


        while streams_to_select:
            return_code = process.poll()
            if return_code is not None and not streams_to_select:
                 logger.debug(f"[Job {job_id}] Process finished and streams closed, exiting read loop.")
                 break
            try:
                 readable, _, _ = select.select(streams_to_select, [], [], 0.2) # Shorter timeout for more frequent checks
            except ValueError as select_err: # ... (select error handling)
                 error_msg = f"Error during select (stream likely closed unexpectedly): {select_err}"
                 logger.error(f"[Job {job_id}] {error_msg}")
                 publish_and_store_log(job_id, "warning", f"Stream error during log capture: {select_err}")
                 for stream_item in streams_to_select[:]:
                     if stream_item and not stream_item.closed:
                         try:
                             if stream_item.fileno() < 0: streams_to_select.remove(stream_item)
                         except Exception: streams_to_select.remove(stream_item)
                     elif stream_item in streams_to_select: streams_to_select.remove(stream_item)
                 if not streams_to_select: break
                 continue

            if not readable and return_code is not None: # ... (final read logic)
                 logger.debug(f"[Job {job_id}] Process finished, select timed out, checking streams for remaining data.")
                 all_closed = True
                 for stream_item in streams_to_select[:]:
                     if stream_item and not stream_item.closed:
                         all_closed = False
                         try:
                             data = stream_item.read()
                             if data:
                                 logger.warning(f"[Job {job_id}] Read remaining data after process end: {len(data)} bytes from stream {stream_item.fileno()}")
                                 if stream_item is process.stdout: stdout_buffer += data
                                 elif stream_item is process.stderr: stderr_buffer += data
                             stream_item.close(); streams_to_select.remove(stream_item)
                         except Exception as final_read_err:
                             logger.error(f"[Job {job_id}] Error during final read from stream {stream_item.fileno()}: {final_read_err}")
                             if stream_item in streams_to_select: streams_to_select.remove(stream_item)
                     elif stream_item in streams_to_select: streams_to_select.remove(stream_item)
                 if all_closed or not streams_to_select: break


            for stream_item in readable: # ... (stream reading logic)
                if not stream_item or stream_item.closed:
                    if stream_item in streams_to_select: streams_to_select.remove(stream_item)
                    continue
                try:
                    data = stream_item.read(4096) 
                    if not data: 
                        logger.debug(f"[Job {job_id}] EOF reached for stream {stream_item.fileno()}. Closing.")
                        stream_item.close()
                        streams_to_select.remove(stream_item)
                        continue

                    if stream_item is process.stdout:
                        stdout_buffer += data
                        while '\n' in stdout_buffer:
                            line, stdout_buffer = stdout_buffer.split('\n', 1)
                            stdout_lines.append(line + '\n') 
                            log_line = line.strip()
                            logger.info(f"[Job {job_id}][STDOUT] {log_line}")
                            publish_and_store_log(job_id, "stdout", log_line)
                            
                            # Parse current task name
                            match_process_name = nf_process_regex.search(log_line)
                            if match_process_name:
                                extracted_full_process_name = match_process_name.group(1)
                                simple_process_name = extracted_full_process_name.split(':')[-1]
                                if job and job.meta.get('current_task') != simple_process_name:
                                    job.meta['current_task'] = simple_process_name
                                    # No need to save meta here, will be saved with progress update
                            
                            # Parse Nextflow's own overall progress line
                            match_nf_progress = nf_overall_progress_regex.search(log_line)
                            if match_nf_progress and job:
                                nf_percent = int(match_nf_progress.group(1))
                                nf_completed = int(match_nf_progress.group(2))
                                nf_total = int(match_nf_progress.group(3))
                                job.meta['overall_progress'] = nf_percent
                                job.meta['completed_task_count'] = nf_completed
                                job.meta['submitted_task_count'] = nf_total # Use Nextflow's total as submitted
                                # This is an alternative to trace file parsing for overall numbers
                                # We might prefer trace file for more robust completed count if NF line is missed
                                logger.info(f"[Job {job_id}] NF Progress Line: {nf_percent}% ({nf_completed}/{nf_total})")
                                # publish_and_store_log(job_id, "info", f"Progress (NF): {nf_percent}% ({nf_completed}/{nf_total})")
                                # No need to save meta here, will be saved with progress update or trace check

                            if not final_results_dir_str and "Results directory:" in line:
                                try:
                                    final_results_dir_str = line.split("Results directory:", 1)[1].strip()
                                    logger.info(f"[Job {job_id}] Parsed results directory from stdout: {final_results_dir_str}")
                                    # Now that we have results_dir, set up trace_file_path_obj
                                    if final_results_dir_str:
                                        trace_file_path_obj = Path(final_results_dir_str) / TRACE_FILENAME
                                        logger.info(f"[Job {job_id}] Trace file path set to: {trace_file_path_obj}")
                                except IndexError:
                                    logger.warning(f"[Job {job_id}] Could not parse results directory from line: {log_line}")
                    elif stream_item is process.stderr: # ... (stderr handling)
                        stderr_buffer += data
                        while '\n' in stderr_buffer:
                            line, stderr_buffer = stderr_buffer.split('\n', 1)
                            stderr_lines.append(line + '\n') 
                            log_line = line.strip()
                            logger.warning(f"[Job {job_id}][STDERR] {log_line}")
                            publish_and_store_log(job_id, "stderr", log_line)
                except (OSError, ValueError) as e: # ... (stream read error handling)
                     error_msg = f"Error reading from stream {stream_item.fileno()}: {e}"
                     logger.error(f"[Job {job_id}] {error_msg}")
                     publish_and_store_log(job_id, "warning", f"Error reading log stream: {e}")
                     if stream_item in streams_to_select:
                         try: stream_item.close()
                         except Exception: pass
                         streams_to_select.remove(stream_item)

            # Resource Monitoring (psutil)
            if process_psutil and process.poll() is None: # ... (psutil logic)
                 try:
                     cpu = process_psutil.cpu_percent(interval=0.1) 
                     if cpu is not None: cpu_percentages.append(cpu)
                     mem_info = process_psutil.memory_info()
                     current_memory_mb = mem_info.rss / (1024 * 1024)
                     peak_memory_mb = max(peak_memory_mb, current_memory_mb)
                 except psutil.NoSuchProcess: process_psutil = None
                 except Exception as monitor_err: logger.error(f"[Job {job_id}] Error during resource monitoring: {monitor_err}")


            # <<< --- ADDED Trace File Parsing and Meta Update Logic --- >>>
            current_time = time.time()
            if job and trace_file_path_obj and (current_time - last_trace_check_time > TRACE_CHECK_INTERVAL_SECONDS):
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
                
                # Only update overall_progress if trace parsing yields results,
                # otherwise rely on Nextflow's own progress line if available.
                if submitted_count > 0:
                    overall_progress_trace = round((completed_count / submitted_count) * 100, 1)
                    # Prefer trace file progress if available and more tasks than NF line (or if NF line not seen)
                    if overall_progress_trace > job.meta.get('overall_progress', -1) or submitted_count > job.meta.get('submitted_task_count', 0):
                         job.meta['overall_progress'] = overall_progress_trace
                         job.meta['submitted_task_count'] = submitted_count
                         job.meta['completed_task_count'] = completed_count
                         logger.info(f"[Job {job_id}] Progress (Trace): {completed_count}/{submitted_count} ({overall_progress_trace:.1f}%)")
                         # publish_and_store_log(job_id, "info", f"Progress (Trace): {completed_count}/{submitted_count} tasks ({overall_progress_trace:.1f}%)")


                # Throttle meta saves
                if current_time - last_meta_save_time > META_SAVE_INTERVAL_SECONDS:
                    try:
                        job.save_meta()
                        last_meta_save_time = current_time
                        logger.info(f"[Job {job_id}] Job meta saved with progress. Current Task: {job.meta.get('current_task')}, Overall: {job.meta.get('overall_progress')}%")
                    except Exception as e_meta_save:
                        logger.error(f"[Job {job_id}] Failed to save meta during progress update: {e_meta_save}")
            # <<< --- END Trace File Parsing Logic --- >>>

            if return_code is None: return_code = process.poll()
            if return_code is not None and not streams_to_select: break
        # End of while streams_to_select loop

        logger.info(f"[Job {job_id}] Exited read loop.")
        # ... (final buffer processing) ...
        if stdout_buffer:
            log_line = stdout_buffer.strip(); logger.info(f"[Job {job_id}][STDOUT] {log_line}"); stdout_lines.append(stdout_buffer); publish_and_store_log(job_id, "stdout", log_line)
            if not final_results_dir_str and "Results directory:" in stdout_buffer:
                 for rem_line in stdout_buffer.splitlines():
                     if "Results directory:" in rem_line:
                          try: final_results_dir_str = rem_line.split("Results directory:", 1)[1].strip(); logger.info(f"[Job {job_id}] Parsed results directory from final stdout buffer: {final_results_dir_str}"); break
                          except IndexError: pass
        if stderr_buffer:
             log_line = stderr_buffer.strip(); logger.warning(f"[Job {job_id}][STDERR] {log_line}"); stderr_lines.append(stderr_buffer); publish_and_store_log(job_id, "stderr", log_line)


        if return_code is None: return_code = process.wait()
        end_time_task = time.time() # Renamed
        duration_seconds = end_time_task - start_time_task
        log_message = f"Pipeline process {process.pid} finished with code {return_code} after {duration_seconds:.2f}s."
        logger.info(f"[Job {job_id}] {log_message}")
        publish_and_store_log(job_id, "info", log_message)
        average_cpu = sum(cpu_percentages) / len(cpu_percentages) if cpu_percentages else 0

        # <<< --- Final Trace Parse and Meta Update --- >>>
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
            elif job.meta.get('overall_progress') is None and return_code == 0 : # If no tasks but success, mark 100%
                job.meta['overall_progress'] = 100.0


        if job:
            job.meta['peak_memory_mb'] = round(peak_memory_mb, 1)
            job.meta['average_cpu_percent'] = round(average_cpu, 1)
            job.meta['duration_seconds'] = round(duration_seconds, 2)
            if return_code == 0: job.meta['current_task'] = "Completed"
            else: job.meta['current_task'] = f"Failed: {job.meta.get('current_task', 'Unknown Step')}"
            try:
                job.save_meta()
                logger.info(f"[Job {job_id}] Saved final resource/progress stats and task status to job meta.")
            except Exception as e_final_meta:
                 logger.error(f"[Job {job_id}] Error saving final job meta: {e_final_meta}")
        # <<< --- END Final Trace Parse --- >>>


        full_stdout = "".join(stdout_lines)
        full_stderr = "".join(stderr_lines)
        script_reported_success = "status::success" in full_stdout
        job_succeeded = (return_code == 0 and script_reported_success)

        if job_succeeded: # ... (success handling) ...
            success_message = f"Sarek pipeline finished successfully (Exit Code {return_code})."
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
                     job_succeeded = False; raise RuntimeError(error_message)
            else: 
                warn_message = "Pipeline finished successfully, but could not determine results directory from output."
                logger.warning(f"[Job {job_id}] {warn_message}"); publish_and_store_log(job_id, "warning", warn_message)
                if job: job.meta['warning_message'] = "Pipeline finished, results dir unclear."; job.save_meta()
                return { "status": "success", "message": "Pipeline finished, results directory unclear.", "resources": job.meta if job else {} }
        else: # ... (failure handling) ...
            error_message = f"Sarek pipeline failed. Exit Code: {return_code}."
            if "status::failed" in full_stdout: error_message += " Script explicitly reported failure."
            elif "ERROR" in full_stderr.upper(): error_message += " Error detected in STDERR." 
            logger.error(f"[Job {job_id}] {error_message}"); publish_and_store_log(job_id, "error", error_message)
            stderr_to_log = full_stderr[-2000:] 
            logger.error(f"[Job {job_id}] STDERR Tail:\n{stderr_to_log}")
            for err_line in stderr_to_log.strip().split('\n'): publish_and_store_log(job_id, "stderr", err_line)
            if job: job.meta['error_message'] = error_message; job.meta['stderr_snippet'] = stderr_to_log; job.save_meta()
            raise subprocess.CalledProcessError(return_code or 1, command, output=full_stdout, stderr=full_stderr)

    except subprocess.TimeoutExpired as e: # ... (timeout handling) ...
        error_msg = "Sarek pipeline timed out."; logger.error(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", error_msg)
        stderr_output = e.stderr if e.stderr else 'N/A'
        if job: job.meta['error_message'] = error_msg; job.meta['stderr_snippet'] = stderr_output[:1000]; job.meta['current_task'] = "Timed Out"; job.save_meta()
        job_succeeded = False; raise
    except FileNotFoundError as e: # ... (file not found handling) ...
         error_msg = f"Error executing pipeline: {e}"; logger.error(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", error_msg)
         if job: job.meta['error_message'] = f"Task execution error: {e}"; job.meta['current_task'] = "Setup Error"; job.save_meta()
         job_succeeded = False; raise
    except Exception as e: # ... (general error handling) ...
        error_msg = f"An unexpected error occurred during pipeline execution: {type(e).__name__}"; logger.exception(f"[Job {job_id}] {error_msg}"); publish_and_store_log(job_id, "error", f"{error_msg}: {e}")
        if job: job.meta['error_message'] = error_msg; job.meta['error_details'] = str(e); job.meta['current_task'] = "Unexpected Error"; job.save_meta()
        job_succeeded = False; raise
    finally: # ... (existing finally block for EOF, TTL, notifications, CSV cleanup) ...
        list_key = f"{LOG_HISTORY_PREFIX}{job_id}"
        try:
            if job_id and not job_id.startswith("N/A") and redis_log_handler:
                publish_and_store_log(job_id, "control", "EOF")
                logger.info(f"[Job {job_id}] Published EOF marker to log channel and list.")
                if job: # Publish notification
                    event_type = "job_completed" if job_succeeded else "job_failed"
                    status_text = "completed successfully" if job_succeeded else "failed"
                    user_message = f"Job '{job.meta.get('run_name', job_id)}' {status_text}."
                    if not job_succeeded:
                        failure_reason = job.meta.get('error_message', 'Unknown error')
                        if len(failure_reason) > 150: failure_reason = failure_reason[:147] + "..."
                        user_message += f" Reason: {failure_reason}"
                    notification_payload = { "event_type": event_type, "job_id": job_id, "run_name": job.meta.get('run_name', job_id), "message": user_message, "status_variant": "success" if job_succeeded else "error" }
                    try: redis_log_handler.publish(APP_NOTIFICATIONS_CHANNEL, json.dumps(notification_payload)); logger.info(f"[Job {job_id}] Published '{event_type}' notification to '{APP_NOTIFICATIONS_CHANNEL}'.")
                    except Exception as e_pub: logger.error(f"[Job {job_id}] Failed to publish job status notification: {e_pub}")
                
                final_ttl = DEFAULT_RESULT_TTL if job_succeeded else DEFAULT_FAILURE_TTL
                if job:
                    ttl_to_use = job.result_ttl if job_succeeded else job.failure_ttl
                    if ttl_to_use is not None and ttl_to_use >= 0 : final_ttl = ttl_to_use
                    elif ttl_to_use == -1: final_ttl = -1
                if final_ttl > 0: redis_log_handler.expire(list_key, final_ttl); logger.info(f"[Job {job_id}] Set TTL={final_ttl}s for log history list: {list_key}")
                elif final_ttl == -1: redis_log_handler.persist(list_key); logger.info(f"[Job {job_id}] Persisted log history list (infinite TTL): {list_key}")
                else: logger.warning(f"[Job {job_id}] TTL is 0 or invalid ({final_ttl}). Deleting log history list: {list_key}"); redis_log_handler.delete(list_key)
        except redis.exceptions.RedisError as e: logger.error(f"[Job {job_id}] Redis error during final log cleanup/TTL setting for {list_key}: {e}")
        except Exception as e: logger.error(f"[Job {job_id}] Unexpected error during final log cleanup/TTL setting: {e}")

        if input_csv_path_str and Path(input_csv_path_str).exists():
            try: os.remove(input_csv_path_str); logger.info(f"[Job {job_id}] Cleaned up temporary CSV file: {input_csv_path_str}")
            except OSError as remove_e: logger.warning(f"[Job {job_id}] Could not clean up temporary CSV file {input_csv_path_str}: {remove_e}")
