# backend/app/tasks.py
import subprocess
import logging
from pathlib import Path
import time
import psutil
import math # Keep math if it was used elsewhere, though not directly in this snippet
import json
import os
import select
import redis
from typing import Optional, List, Dict, Any

# --- RQ Imports ---
from rq import get_current_job, Queue # Keep Queue if used for other tasks, not directly here

# --- Import Config ---
from .core.config import (
    RESULTS_DIR, REDIS_HOST, REDIS_PORT, REDIS_DB,
    LOG_CHANNEL_PREFIX, LOG_HISTORY_PREFIX,
    DEFAULT_RESULT_TTL, DEFAULT_FAILURE_TTL # These are for RQ job itself, log history TTL is separate
)

# --- Configure Logging ---
# BasicConfig should ideally be called once at application startup (e.g., in app.py or main.py)
# If called here, it might reconfigure if this module is reloaded.
# For simplicity in this context, we'll assume it's set up.
logger = logging.getLogger(__name__)

# --- Path Definitions ---
MONITORING_INTERVAL_SECONDS = 5
METADATA_FILENAME = "run_metadata.json"

# --- Get Redis Connection for Publishing & List Operations ---
try:
    redis_log_handler = redis.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        db=REDIS_DB,
        decode_responses=True # Important for publishing strings
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
    """Safely gets the current RQ job ID, returns 'N/A...' if not in context."""
    job = get_current_job()
    return job.id if job else "N/A (Not in RQ context)"

def publish_and_store_log(job_id: str, log_type: str, line: str):
    """Publishes log to Redis channel AND stores it in Redis List."""
    if not redis_log_handler:
        # Fallback to standard logger if Redis is unavailable for logs
        if log_type == "error": logger.error(f"[Job {job_id}][NoRedisLog] {line.strip()}")
        elif log_type == "stderr": logger.warning(f"[Job {job_id}][NoRedisLog][STDERR] {line.strip()}")
        else: logger.info(f"[Job {job_id}][NoRedisLog][{log_type.upper()}] {line.strip()}")
        return

    if not job_id or job_id.startswith("N/A"):
        # logger.debug(f"Skipping Redis publish/store, invalid job_id: {job_id} [TYPE: {log_type}] {line.strip()}")
        return

    channel = f"{LOG_CHANNEL_PREFIX}{job_id}"
    list_key = f"{LOG_HISTORY_PREFIX}{job_id}"
    # Ensure line is a string and stripped before JSON dump
    message_content = str(line).strip() if line is not None else ""
    message = json.dumps({"type": log_type, "line": message_content})

    try:
        pipe = redis_log_handler.pipeline()
        pipe.publish(channel, message)
        pipe.rpush(list_key, message)
        # Optional: pipe.ltrim(list_key, -MAX_LOG_HISTORY_LINES, -1)
        pipe.execute()
    except redis.exceptions.RedisError as e:
        logger.error(f"[Job {job_id}] Redis error publishing/storing log to {channel}/{list_key}: {e}")
    except Exception as e:
        logger.error(f"[Job {job_id}] Unexpected error publishing/storing log: {e}")


def run_pipeline_task(
    run_name_from_caller: str,
    input_csv_path_str: str,
    outdir_base_path_str: str,
    genome: str,
    tools: Optional[str], # Comma-separated string
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
    job_id = job.id if job else get_current_job_id() # Use helper for safety

    final_results_dir_str: Optional[str] = None
    job_succeeded = False # Track success for final TTL setting and metadata
    current_run_name = run_name_from_caller
    if not current_run_name:
        current_run_name = f"sarek_run_{time.strftime('%Y%m%d%H%M%S')}"
        logger.warning(f"[Job {job_id}] run_name_from_caller was empty, using generated: {current_run_name}")

    initial_log_message = f"Starting Sarek task (Job ID: {job_id}, Run Name: '{current_run_name}', Input: {Path(input_csv_path_str).name}, Genome: {genome}, Step: {step})"
    logger.info(f"[Job {job_id}] {initial_log_message}")
    publish_and_store_log(job_id, "info", initial_log_message)
    logger.info(f"[Job {job_id}] Input CSV: {input_csv_path_str}")
    logger.info(f"[Job {job_id}] Output Base: {outdir_base_path_str}")

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
    ]
    script_working_dir = script_path.parent
    command_str = ' '.join(f'"{arg}"' if ' ' in arg and arg else arg for arg in command)
    logger.info(f"[Job {job_id}] Executing in {script_working_dir}: {command_str}")
    publish_and_store_log(job_id, "info", f"Executing: {command_str}")

    subprocess_env = os.environ.copy()
    user_home = os.path.expanduser("~") # More robust way to get home
    subprocess_env["HOME"] = user_home
    subprocess_env["NXF_HOME"] = os.path.join(user_home, ".nextflow") # Sarek/Nextflow might need this
    subprocess_env["NXF_ANSI_LOG"] = "false"
    logger.info(f"[Job {job_id}] Subprocess HOME={subprocess_env['HOME']}, NXF_HOME={subprocess_env['NXF_HOME']}")

    peak_memory_mb = 0.0
    cpu_percentages: List[float] = []
    process_psutil = None
    start_time = time.time()
    process = None
    full_stdout_lines: List[str] = []
    full_stderr_lines: List[str] = []
    return_code = -1 # Default to an error code

    try:
        publish_and_store_log(job_id, "info", "Pipeline process starting...")
        process = subprocess.Popen(
            command, cwd=str(script_working_dir), stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1, env=subprocess_env,
            universal_newlines=True # Ensures text mode and handles line endings
        )
        logger.info(f"[Job {job_id}] Popen successful. PID: {process.pid}")
        publish_and_store_log(job_id, "info", f"Pipeline process started (PID: {process.pid}).")

        if not process.stdout or not process.stderr:
            raise IOError("Subprocess stdout or stderr is not available.")

        try:
            process_psutil = psutil.Process(process.pid)
            process_psutil.cpu_percent(interval=None) # Initialize
            time.sleep(0.1)
        except psutil.Error as init_monitor_err: # Catch psutil specific errors
            logger.warning(f"[Job {job_id}] Error initializing resource monitor for PID {process.pid} (may have finished quickly): {init_monitor_err}")
            process_psutil = None

        stdout_buffer = ""
        stderr_buffer = ""
        streams_to_select = [s for s in [process.stdout, process.stderr] if s]

        while streams_to_select:
            current_process_return_code = process.poll()
            # Break if process ended AND no more data to read (select timed out)
            if current_process_return_code is not None:
                # Try one last read from any open streams before breaking
                for stream in streams_to_select[:]: # Iterate over a copy
                    if stream and not stream.closed:
                        try:
                            remaining_data = stream.read() # Non-blocking read for remaining
                            if remaining_data:
                                if stream is process.stdout: stdout_buffer += remaining_data
                                elif stream is process.stderr: stderr_buffer += remaining_data
                        except Exception as final_read_err:
                            logger.warning(f"[Job {job_id}] Error on final read from stream {stream.fileno()}: {final_read_err}")
                    if stream in streams_to_select: streams_to_select.remove(stream) # Remove after attempt
                break # Exit main loop as process has ended

            try:
                readable, _, _ = select.select(streams_to_select, [], [], MONITORING_INTERVAL_SECONDS)
            except ValueError as select_err: # Stream closed unexpectedly
                logger.error(f"[Job {job_id}] Select error (stream closed?): {select_err}")
                for stream in streams_to_select[:]:
                    if stream and (stream.closed or (hasattr(stream, 'fileno') and stream.fileno() < 0)):
                        streams_to_select.remove(stream)
                if not streams_to_select: break
                continue

            for stream in readable:
                if not stream or stream.closed:
                    if stream in streams_to_select: streams_to_select.remove(stream)
                    continue
                try:
                    data = stream.read(4096) # Read in chunks
                    if not data: # EOF
                        stream.close()
                        streams_to_select.remove(stream)
                        continue

                    if stream is process.stdout:
                        stdout_buffer += data
                        while '\n' in stdout_buffer:
                            line, stdout_buffer = stdout_buffer.split('\n', 1)
                            full_stdout_lines.append(line) # Store raw line for parsing
                            log_line = line.strip()
                            if log_line: # Avoid logging empty lines
                                logger.info(f"[Job {job_id}][STDOUT] {log_line}")
                                publish_and_store_log(job_id, "stdout", log_line)
                    elif stream is process.stderr:
                        stderr_buffer += data
                        while '\n' in stderr_buffer:
                            line, stderr_buffer = stderr_buffer.split('\n', 1)
                            full_stderr_lines.append(line)
                            log_line = line.strip()
                            if log_line:
                                logger.warning(f"[Job {job_id}][STDERR] {log_line}")
                                publish_and_store_log(job_id, "stderr", log_line)
                except (OSError, ValueError) as e:
                     logger.error(f"[Job {job_id}] Error reading stream {stream.fileno()}: {e}")
                     if stream in streams_to_select:
                         try: stream.close()
                         except Exception: pass
                         streams_to_select.remove(stream)

            if process_psutil and process.poll() is None:
                 try:
                     cpu = process_psutil.cpu_percent(interval=0.1)
                     if cpu is not None: cpu_percentages.append(cpu)
                     mem_info = process_psutil.memory_info()
                     peak_memory_mb = max(peak_memory_mb, mem_info.rss / (1024 * 1024))
                 except psutil.Error: process_psutil = None # Stop monitoring if process gone

        # Process remaining buffer
        if stdout_buffer:
            for line in stdout_buffer.splitlines(): # Process each line
                full_stdout_lines.append(line)
                log_line = line.strip()
                if log_line: logger.info(f"[Job {job_id}][STDOUT] {log_line}"); publish_and_store_log(job_id, "stdout", log_line)
        if stderr_buffer:
            for line in stderr_buffer.splitlines():
                full_stderr_lines.append(line)
                log_line = line.strip()
                if log_line: logger.warning(f"[Job {job_id}][STDERR] {log_line}"); publish_and_store_log(job_id, "stderr", log_line)

        return_code = process.wait() # Ensure process is waited for and get final code
        logger.info(f"[Job {job_id}] Process wait() returned: {return_code}")

        # Parse results_dir from all collected stdout
        full_stdout_content = "\n".join(full_stdout_lines)
        for line in full_stdout_content.splitlines():
            if "Results directory:" in line:
                try:
                    final_results_dir_str = line.split("Results directory:", 1)[1].strip()
                    logger.info(f"[Job {job_id}] Final parsed results directory: {final_results_dir_str}")
                    break
                except IndexError:
                    logger.warning(f"[Job {job_id}] Could not parse results dir from final stdout: {line}")

        end_time = time.time()
        duration_seconds = end_time - start_time
        average_cpu = sum(cpu_percentages) / len(cpu_percentages) if cpu_percentages else 0.0

        if job: # Update meta with resource usage
            job.meta['peak_memory_mb'] = round(peak_memory_mb, 1)
            job.meta['average_cpu_percent'] = round(average_cpu, 1)
            job.meta['duration_seconds'] = round(duration_seconds, 2)
            if final_results_dir_str: job.meta['results_path'] = final_results_dir_str
            # job.meta is saved in the finally block now
            # job.save_meta() # Avoid saving meta multiple times before finally

        script_reported_success = "status::success" in full_stdout_content
        script_reported_failure = "status::failed" in full_stdout_content
        # Consider any "ERROR" in stderr from the script as a failure indicator too
        script_stderr_has_error = any("ERROR" in line for line in full_stderr_lines)

        if return_code == 0 and script_reported_success and not script_stderr_has_error:
            job_succeeded = True
            success_message = f"Sarek pipeline finished successfully (Exit Code {return_code})."
            logger.info(f"[Job {job_id}] {success_message}")
            publish_and_store_log(job_id, "info", success_message)
            if final_results_dir_str:
                publish_and_store_log(job_id, "info", f"Results directory: {final_results_dir_str}")
                return { "status": "success", "results_path": final_results_dir_str, "resources": job.meta if job else {} }
            else: # Should ideally not happen if script outputs the dir path
                warn_msg = "Pipeline finished successfully, but results directory path was not found in output."
                logger.warning(f"[Job {job_id}] {warn_msg}")
                publish_and_store_log(job_id, "warning", warn_msg)
                return { "status": "success", "message": warn_msg, "resources": job.meta if job else {} }
        else:
            error_message = f"Sarek pipeline failed. Exit Code: {return_code}."
            if script_reported_failure: error_message += " Script explicitly reported failure."
            elif script_stderr_has_error: error_message += " Errors detected in script's stderr."
            logger.error(f"[Job {job_id}] {error_message}")
            publish_and_store_log(job_id, "error", error_message)
            stderr_to_log = "\n".join(full_stderr_lines[-50:]) # Last 50 lines of stderr
            if job: job.meta['error_message'] = error_message; job.meta['stderr_snippet'] = stderr_to_log
            raise subprocess.CalledProcessError(return_code, command_str, output=full_stdout_content, stderr="\n".join(full_stderr_lines))

    except subprocess.CalledProcessError as e:
        logger.error(f"[Job {job_id}] CalledProcessError: {e.returncode}, {e.cmd}")
        publish_and_store_log(job_id, "error", f"Pipeline execution error (code {e.returncode}). Check logs.")
        if job: job.meta['error_message'] = job.meta.get('error_message', f"Pipeline failed with code {e.returncode}")
        raise
    except FileNotFoundError as e:
         error_msg = f"Error executing pipeline (FileNotFound): {e}"
         logger.error(f"[Job {job_id}] {error_msg}")
         publish_and_store_log(job_id, "error", error_msg)
         if job: job.meta['error_message'] = error_msg
         raise
    except PermissionError as e:
         error_msg = f"Error executing pipeline (PermissionError): {e}"
         logger.error(f"[Job {job_id}] {error_msg}")
         publish_and_store_log(job_id, "error", error_msg)
         if job: job.meta['error_message'] = error_msg
         raise
    except Exception as e:
        error_msg = f"An unexpected error occurred: {type(e).__name__}"
        logger.exception(f"[Job {job_id}] {error_msg}: {e}")
        publish_and_store_log(job_id, "error", f"{error_msg}: {str(e)[:500]}") # Log truncated error
        if job: job.meta['error_message'] = error_msg; job.meta['error_details'] = str(e)[:1000]
        raise
    finally:
        if job: # Ensure job object exists
            # Update job.meta with final status and save it once
            job.meta['final_status_in_task'] = 'success' if job_succeeded else 'failed_or_stopped'
            job.meta['task_ended_at_iso'] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            if final_results_dir_str: # If results dir was determined by script
                 job.meta['results_path'] = final_results_dir_str
                 results_path_obj = Path(final_results_dir_str)
                 if results_path_obj.is_dir(): # Ensure directory was actually created
                    try:
                        metadata_to_save = job.meta.copy()
                        metadata_to_save['job_id'] = job.id # Ensure job_id is in the file
                        # Remove potentially large or unserializable items if needed
                        # metadata_to_save.pop('exc_info', None) # RQ might add this

                        metadata_file_path = results_path_obj / METADATA_FILENAME
                        with open(metadata_file_path, 'w') as f:
                            json.dump(metadata_to_save, f, indent=4, default=str) # Use default=str for non-serializable
                        logger.info(f"[Job {job_id}] Saved run metadata to {metadata_file_path} in finally block.")
                    except Exception as meta_err:
                        logger.error(f"[Job {job_id}] Failed to save run metadata file in finally block: {meta_err}")
                 else:
                    logger.warning(f"[Job {job_id}] Results directory '{final_results_dir_str}' not found in finally block, cannot save metadata file there.")
            else:
                logger.warning(f"[Job {job_id}] final_results_dir_str not determined, cannot save {METADATA_FILENAME} to results folder.")
            job.save_meta() # Save the final meta to RQ job object

        # Final log handling (EOF marker and TTL for log history)
        list_key = f"{LOG_HISTORY_PREFIX}{job_id}"
        try:
            if job_id and not job_id.startswith("N/A") and redis_log_handler:
                publish_and_store_log(job_id, "control", "EOF") # Publish EOF
                logger.info(f"[Job {job_id}] Published EOF marker to channel and list.")

                final_ttl_seconds = DEFAULT_RESULT_TTL if job_succeeded else DEFAULT_FAILURE_TTL
                if job: # If job object exists, use its specific TTLs if set
                    ttl_from_job = job.result_ttl if job_succeeded else job.failure_ttl
                    if ttl_from_job is not None:
                        if ttl_from_job == -1: # RQ's convention for persist
                            final_ttl_seconds = -1 # Persist
                        elif ttl_from_job >= 0:
                            final_ttl_seconds = ttl_from_job
                
                if final_ttl_seconds == -1: # Persist
                    redis_log_handler.persist(list_key)
                    logger.info(f"[Job {job_id}] Persisted log history list (infinite TTL): {list_key}")
                elif final_ttl_seconds > 0:
                    redis_log_handler.expire(list_key, final_ttl_seconds)
                    logger.info(f"[Job {job_id}] Set TTL={final_ttl_seconds}s for log history list: {list_key}")
                else: # TTL is 0 or invalid negative (excluding -1), delete immediately
                    logger.warning(f"[Job {job_id}] Invalid or zero TTL ({final_ttl_seconds}). Deleting log history list: {list_key}")
                    redis_log_handler.delete(list_key)
        except redis.exceptions.RedisError as e:
            logger.error(f"[Job {job_id}] Redis error during final log cleanup/TTL setting for {list_key}: {e}")
        except Exception as e:
            logger.error(f"[Job {job_id}] Unexpected error during final log cleanup/TTL setting: {e}")

        if input_csv_path_str and Path(input_csv_path_str).exists():
            try:
                if str(Path(input_csv_path_str).parent).startswith(tempfile.gettempdir()): # Extra safety
                    os.remove(input_csv_path_str)
                    logger.info(f"[Job {job_id}] Cleaned up temporary CSV file: {input_csv_path_str}")
            except OSError as remove_e:
                logger.warning(f"[Job {job_id}] Could not clean up temporary CSV file {input_csv_path_str}: {remove_e}")
