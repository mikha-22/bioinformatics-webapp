# backend/app/tasks.py
import subprocess
import logging
from pathlib import Path
import time
import psutil
import math
import json
import os
import select # Keep select module
import redis # <--- IMPORT redis
from typing import Optional, List, Dict, Any

# --- RQ Import ---
from rq import get_current_job

# --- Configure Logging ---
# (Keep logging config as is)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(process)d - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# --- Path Definitions ---
MONITORING_INTERVAL_SECONDS = 5
METADATA_FILENAME = "run_metadata.json"


# --- Import Config ---
from .core.config import RESULTS_DIR, REDIS_HOST, REDIS_PORT, REDIS_DB, LOG_CHANNEL_PREFIX # Import Redis config and prefix

# --- Get Redis Connection for Publishing ---
# Create a separate connection instance for publishing within the task
# Use decode_responses=True here as we are publishing simple strings/JSON
try:
    redis_publisher = redis.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        db=REDIS_DB,
        decode_responses=True # Easier to publish strings
    )
    redis_publisher.ping() # Check connection at module load time
    logger.info("Redis publisher connection successful for tasks.")
except redis.exceptions.ConnectionError as e:
    logger.error(f"FATAL: Could not connect Redis publisher in tasks.py: {e}")
    redis_publisher = None # Set to None if connection fails
except Exception as e:
    logger.error(f"FATAL: Unexpected error connecting Redis publisher in tasks.py: {e}")
    redis_publisher = None

def get_current_job_id():
    job = get_current_job()
    return job.id if job else "N/A (Not in RQ context)"

# --- Publish Log Helper ---
def publish_log(job_id: str, log_type: str, line: str):
    """Publishes a log line to the job's Redis channel."""
    if not redis_publisher:
        logger.warning(f"[Job {job_id}] Cannot publish log, Redis publisher not available.")
        return
    if not job_id or job_id.startswith("N/A"):
        # This might happen if run outside RQ context for testing, log locally only
        logger.debug(f"Skipping Redis publish, invalid job_id: {job_id} [TYPE: {log_type}] {line.strip()}")
        return

    channel = f"{LOG_CHANNEL_PREFIX}{job_id}"
    try:
        # Publish as JSON for structure
        message = json.dumps({"type": log_type, "line": line.strip()})
        redis_publisher.publish(channel, message)
        # logger.debug(f"[Job {job_id}] Published to {channel}: {message}") # Optional: Verbose logging
    except redis.exceptions.RedisError as e:
        logger.error(f"[Job {job_id}] Redis error publishing log to {channel}: {e}")
    except Exception as e:
        logger.error(f"[Job {job_id}] Unexpected error publishing log: {e}")


# --- Updated Function Signature ---
# (Keep function signature as is)
def run_pipeline_task(
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
    is_rerun: bool = False, # Keep is_rerun
) -> Dict[str, Any]:
    job = get_current_job()
    # Ensure we always have a job_id string, even if 'N/A...'
    job_id = job.id if job else get_current_job_id()
    final_results_dir = None

    # --- Logging Parameters (Keep as is, but maybe log job_id earlier) ---
    logger.info(f"[Job {job_id}] Starting Sarek pipeline task...")
    # (Keep other parameter logging)


    # --- Command Construction (Keep as is) ---
    script_path = Path(__file__).resolve().parent / "sarek_pipeline.sh"
    if not script_path.exists():
         error_msg = f"CRITICAL: Sarek wrapper script not found at {script_path}"
         logger.error(f"[Job {job_id}] {error_msg}")
         publish_log(job_id, "error", error_msg)
         raise FileNotFoundError(f"Sarek wrapper script not found: {script_path}")
    if not os.access(script_path, os.X_OK):
        error_msg = f"CRITICAL: Sarek wrapper script is not executable: {script_path}"
        logger.error(f"[Job {job_id}] {error_msg}")
        publish_log(job_id, "error", error_msg)
        raise PermissionError(f"Sarek wrapper script not executable: {script_path}")


    command = [
        "bash", str(script_path),
        input_csv_path_str,       # $1
        outdir_base_path_str,     # $2
        genome,                   # $3
        tools if tools else "",   # $4
        step if step else "",     # $5
        profile if profile else "", # $6
        aligner if aligner else "", # $7
        intervals_path_str if intervals_path_str else "", # $8
        dbsnp_path_str if dbsnp_path_str else "",         # $9
        known_indels_path_str if known_indels_path_str else "", # $10
        pon_path_str if pon_path_str else "",             # $11
        "true" if joint_germline else "false",  # $12
        "true" if wes else "false",            # $13
        "true" if trim_fastq else "false",     # $14
        "true" if skip_qc else "false",        # $15
        "true" if skip_annotation else "false", # $16
        "true" if skip_baserecalibrator else "false",  # $17
        "true" if is_rerun else "false",       # $18
    ]
    script_working_dir = script_path.parent
    logger.info(f"[Job {job_id}] Running command in directory: {script_working_dir}")
    command_str = ' '.join(command)
    logger.info(f"[Job {job_id}] Command: {command_str}")
    publish_log(job_id, "info", f"Executing: {command_str}") # Publish command


    # Set HOME and NXF_HOME environment variables for the subprocess
    subprocess_env = os.environ.copy()
    user_home = os.path.expanduser("~")
    subprocess_env["HOME"] = user_home
    subprocess_env["NXF_HOME"] = os.path.join(user_home, ".nextflow")
    logger.info(f"[Job {job_id}] Setting HOME={subprocess_env['HOME']} and NXF_HOME={subprocess_env['NXF_HOME']} for subprocess.")
    subprocess_env["NXF_ANSI_LOG"] = "false"


    # --- Resource Monitoring Variables (Keep as is) ---
    peak_memory_mb = 0
    cpu_percentages = []
    process_psutil = None
    start_time = time.time()
    process = None # Initialize process variable

    try:
        # --- Process Execution (Use subprocess_env) ---
        logger.info(f"[Job {job_id}] Preparing to execute Popen...")
        publish_log(job_id, "info", "Pipeline process starting...")
        try:
            process = subprocess.Popen(
                command,
                cwd=str(script_working_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True, # Keep text mode for easier handling
                bufsize=1, # Line buffering
                env=subprocess_env # Pass the modified environment
            )
            logger.info(f"[Job {job_id}] Popen successful. PID: {process.pid}")
            publish_log(job_id, "info", f"Pipeline process started (PID: {process.pid}).")
            # Check streams
            if process.stdout: logger.info(f"[Job {job_id}] stdout available (fd: {process.stdout.fileno()})")
            else: logger.error(f"[Job {job_id}] process.stdout is None!")
            if process.stderr: logger.info(f"[Job {job_id}] stderr available (fd: {process.stderr.fileno()})")
            else: logger.error(f"[Job {job_id}] process.stderr is None!")

        except Exception as popen_err:
            error_msg = f"CRITICAL ERROR starting pipeline process: {popen_err}"
            logger.exception(f"[Job {job_id}] {error_msg}")
            publish_log(job_id, "error", error_msg)
            raise popen_err # Re-raise to fail the job

        # --- Initialize psutil (Keep as is) ---
        try:
            process_psutil = psutil.Process(process.pid)
            process_psutil.cpu_percent(interval=None) # Initialize
            time.sleep(0.1) # Allow slight delay
        except psutil.NoSuchProcess: logger.warning(f"[Job {job_id}] Process {process.pid} finished before monitoring could start."); process_psutil = None
        except Exception as init_monitor_err: logger.error(f"[Job {job_id}] Error initializing resource monitor for PID {process.pid}: {init_monitor_err}"); process_psutil = None


        # --- Non-Blocking Read Loop using select ---
        stdout_lines = []
        stderr_lines = []
        stdout_buffer = ""
        stderr_buffer = ""

        streams_to_select = []
        if process.stdout: streams_to_select.append(process.stdout)
        if process.stderr: streams_to_select.append(process.stderr)

        if not streams_to_select:
             error_msg = "Both stdout and stderr are None/invalid after Popen. Cannot read output."
             logger.error(f"[Job {job_id}] {error_msg}")
             publish_log(job_id, "error", "Pipeline streams unavailable after start.")
             raise IOError("Subprocess streams are not available.")


        while streams_to_select:
            # Check if process has finished
            return_code = process.poll()
            if return_code is not None and not streams_to_select:
                 logger.debug(f"[Job {job_id}] Process finished and streams closed, exiting read loop.")
                 break

            try:
                 readable, _, _ = select.select(streams_to_select, [], [], MONITORING_INTERVAL_SECONDS)
            except ValueError as select_err:
                 error_msg = f"Error during select (stream likely closed unexpectedly): {select_err}"
                 logger.error(f"[Job {job_id}] {error_msg}")
                 publish_log(job_id, "warning", f"Stream error during log capture: {select_err}")
                 # Attempt to clean up streams and break
                 for stream in streams_to_select[:]:
                     if stream and not stream.closed:
                         try:
                             if stream.fileno() < 0: # Check for invalid fd
                                 logger.warning(f"[Job {job_id}] Removing stream with invalid fileno from select list.")
                                 streams_to_select.remove(stream)
                             else:
                                 logger.warning(f"[Job {job_id}] Stream {stream.fileno()} caused select error, closing it.")
                                 stream.close()
                                 streams_to_select.remove(stream)
                         except Exception as close_err:
                             logger.error(f"[Job {job_id}] Error closing stream during select error handling: {close_err}")
                             if stream in streams_to_select: streams_to_select.remove(stream) # Ensure removal
                     elif stream in streams_to_select:
                         streams_to_select.remove(stream) # Remove if already closed or None
                 if not streams_to_select: break # Exit loop if no valid streams left
                 continue # Try select again if some streams remain


            if not readable and return_code is not None:
                 # Process finished, and no more data to read from open streams in this timeout cycle
                 logger.debug(f"[Job {job_id}] Process finished, select timed out, checking stream closure.")
                 # Check if streams are actually closed now
                 all_closed = True
                 for stream in streams_to_select[:]:
                     if stream and not stream.closed:
                         all_closed = False
                         # Try one last read attempt
                         try:
                             data = stream.read()
                             if data:
                                 logger.warning(f"[Job {job_id}] Read remaining data after process end: {len(data)} bytes from stream {stream.fileno()}")
                                 if stream is process.stdout: stdout_buffer += data
                                 elif stream is process.stderr: stderr_buffer += data
                             stream.close()
                             streams_to_select.remove(stream)
                         except Exception as final_read_err:
                             logger.error(f"[Job {job_id}] Error during final read: {final_read_err}")
                             if stream in streams_to_select:
                                 try: stream.close()
                                 except: pass
                                 streams_to_select.remove(stream)

                     elif stream in streams_to_select: # Remove if None or already closed
                         streams_to_select.remove(stream)

                 if all_closed or not streams_to_select:
                     break # Exit loop

            for stream in readable:
                if not stream or stream.closed: # Double check stream validity
                    if stream in streams_to_select: streams_to_select.remove(stream)
                    continue

                try:
                    # Read available data (might be partial line)
                    data = stream.read(4096) # Read in chunks
                    if not data:
                        # End of stream reached, remove it from select list
                        logger.debug(f"[Job {job_id}] EOF reached for stream {stream.fileno()}. Closing.")
                        stream.close()
                        streams_to_select.remove(stream)
                        continue

                    if stream is process.stdout:
                        stdout_buffer += data
                        while '\n' in stdout_buffer:
                            line, stdout_buffer = stdout_buffer.split('\n', 1)
                            # No need to add newline back for publish_log
                            stdout_lines.append(line + '\n') # Add back for internal logging/storage
                            log_line = line.strip()
                            logger.info(f"[Job {job_id}][STDOUT] {log_line}")
                            publish_log(job_id, "stdout", log_line) # <--- PUBLISH STDOUT
                            if "Results directory:" in line:
                                try: final_results_dir = line.split("Results directory:", 1)[1].strip()
                                except IndexError: logger.warning(f"[Job {job_id}] Could not parse results directory from line: {log_line}")
                    elif stream is process.stderr:
                        stderr_buffer += data
                        while '\n' in stderr_buffer:
                            line, stderr_buffer = stderr_buffer.split('\n', 1)
                            stderr_lines.append(line + '\n') # Add back for internal logging/storage
                            log_line = line.strip()
                            logger.warning(f"[Job {job_id}][STDERR] {log_line}")
                            publish_log(job_id, "stderr", log_line) # <--- PUBLISH STDERR

                except (OSError, ValueError) as e: # Handle potential errors during read/close
                     error_msg = f"Error reading from stream {stream.fileno()}: {e}"
                     logger.error(f"[Job {job_id}] {error_msg}")
                     publish_log(job_id, "warning", f"Error reading log stream: {e}")
                     if stream in streams_to_select:
                         try: stream.close()
                         except: pass
                         streams_to_select.remove(stream)


            # --- Resource Monitoring (executed periodically due to select timeout) ---
            if process_psutil and process.poll() is None: # Check if process still running
                 try:
                     cpu = process_psutil.cpu_percent(interval=0.1) # Non-blocking after first call
                     if cpu is not None: cpu_percentages.append(cpu)
                     mem_info = process_psutil.memory_info()
                     current_memory_mb = mem_info.rss / (1024 * 1024)
                     peak_memory_mb = max(peak_memory_mb, current_memory_mb)
                 except psutil.NoSuchProcess:
                     logger.warning(f"[Job {job_id}] Process {process.pid} ended during monitoring check.")
                     process_psutil = None # Stop monitoring
                 except Exception as monitor_err:
                     logger.error(f"[Job {job_id}] Error during resource monitoring: {monitor_err}")
                     # Optionally stop monitoring if errors persist

            # Final check if process finished after reading round
            if return_code is None:
                 return_code = process.poll()
            if return_code is not None and not streams_to_select:
                 logger.debug(f"[Job {job_id}] Process finished and streams list empty, exiting read loop.")
                 break # Ensure exit if process finished and streams closed


        # --- Process Finished ---
        logger.info(f"[Job {job_id}] Exited read loop.")
        # Capture any remaining buffered data after loop exits
        if stdout_buffer:
            log_line = stdout_buffer.strip()
            logger.info(f"[Job {job_id}][STDOUT] {log_line}")
            stdout_lines.append(stdout_buffer)
            publish_log(job_id, "stdout", log_line) # Publish remaining stdout
            if not final_results_dir and "Results directory:" in stdout_buffer:
                 for rem_line in stdout_buffer.splitlines():
                     if "Results directory:" in rem_line:
                          try: final_results_dir = rem_line.split("Results directory:", 1)[1].strip(); break
                          except IndexError: logger.warning(f"[Job {job_id}] Could not parse results directory from final stdout buffer line: {rem_line.strip()}")
        if stderr_buffer:
             log_line = stderr_buffer.strip()
             logger.warning(f"[Job {job_id}][STDERR] {log_line}")
             stderr_lines.append(stderr_buffer)
             publish_log(job_id, "stderr", log_line) # Publish remaining stderr

        # Get final return code if not already set
        if return_code is None:
            logger.warning(f"[Job {job_id}] Process return code was None after loop, calling process.wait().")
            return_code = process.wait() # Final blocking wait if needed

        end_time = time.time()
        duration_seconds = end_time - start_time
        log_message = f"Pipeline process {process.pid} finished with code {return_code} after {duration_seconds:.2f}s."
        logger.info(f"[Job {job_id}] {log_message}")
        publish_log(job_id, "info", log_message) # Publish final status

        average_cpu = sum(cpu_percentages) / len(cpu_percentages) if cpu_percentages else 0

        # --- Update Job Meta with Final Stats ---
        if job:
            job.meta['peak_memory_mb'] = round(peak_memory_mb, 1)
            job.meta['average_cpu_percent'] = round(average_cpu, 1)
            job.meta['duration_seconds'] = round(duration_seconds, 2)
            job.save_meta()
            logger.info(f"[Job {job_id}] Saved final resource stats to job meta.")

        # --- Success/Failure Check ---
        full_stdout = "".join(stdout_lines)
        full_stderr = "".join(stderr_lines)

        # Check for known critical error patterns in stdout or stderr
        script_reported_error = "ERROR ~" in full_stderr or \
                                "Validation of pipeline parameters failed" in full_stderr or \
                                "[SCRIPT DETECTED ERROR]" in full_stderr or \
                                "ERROR ~" in full_stdout or \
                                "Validation of pipeline parameters failed" in full_stdout or \
                                "ERROR:" in full_stderr # Added generic ERROR check for script errors

        # Check for specific status markers from the simplified script
        script_reported_success = "status::success" in full_stdout
        script_reported_failure = "status::failed" in full_stdout

        # Determine final status
        final_status_success = False # Default to failure
        if script_reported_success and return_code == 0:
            final_status_success = True
        elif script_reported_failure or return_code != 0:
            final_status_success = False
        elif not script_reported_success and not script_reported_failure:
            # Fallback to exit code if no status:: marker found
             final_status_success = (return_code == 0 and not script_reported_error)
        else: # Should not happen unless status markers are inconsistent with exit code
             logger.warning(f"[Job {job_id}] Inconsistent status markers and exit code ({return_code}). Assuming failure.")
             final_status_success = False


        if final_status_success:
            success_message = f"Sarek pipeline finished successfully (Exit Code {return_code})."
            logger.info(f"[Job {job_id}] {success_message}")
            publish_log(job_id, "info", success_message)
            if final_results_dir:
                results_path_obj = Path(final_results_dir)
                if results_path_obj.is_dir():
                     logger.info(f"[Job {job_id}] Confirmed results directory exists: {final_results_dir}")
                     publish_log(job_id, "info", f"Results directory: {final_results_dir}")
                     if job:
                          job.meta['results_path'] = final_results_dir
                          job.save_meta()
                          # Save Metadata File
                          try:
                              metadata_to_save = job.meta
                              metadata_file_path = results_path_obj / METADATA_FILENAME
                              with open(metadata_file_path, 'w') as f:
                                  json.dump(metadata_to_save, f, indent=4)
                              logger.info(f"[Job {job_id}] Saved run metadata to {metadata_file_path}")
                          except Exception as meta_err:
                               logger.error(f"[Job {job_id}] Failed to save run metadata file: {meta_err}")
                     return { "status": "success", "results_path": final_results_dir, "resources": job.meta if job else {} }
                else:
                     error_message = f"Pipeline reported success, but results directory '{final_results_dir}' not found!"
                     logger.error(f"[Job {job_id}] {error_message}")
                     publish_log(job_id, "error", error_message)
                     if job: job.meta['error_message'] = error_message; job.save_meta()
                     raise RuntimeError(error_message)
            else:
                warn_message = "Pipeline finished successfully, but could not determine results directory from output."
                logger.warning(f"[Job {job_id}] {warn_message}")
                publish_log(job_id, "warning", warn_message)
                if job: job.meta['warning_message'] = "Pipeline finished, results dir unclear."; job.save_meta()
                return { "status": "success", "message": "Pipeline finished, results directory unclear.", "resources": job.meta if job else {} }
        else:
            # Failure Path
            error_message = f"Sarek pipeline failed. Exit Code: {return_code}."
            if script_reported_error: error_message += " Critical error detected in logs."
            elif script_reported_failure: error_message += " Script reported status::failed."

            logger.error(f"[Job {job_id}] {error_message}")
            publish_log(job_id, "error", error_message) # Publish failure message
            # Log more stderr on failure
            stderr_to_log = full_stderr[-2000:] # Log last 2000 chars of stderr
            logger.error(f"[Job {job_id}] STDERR Tail:\n{stderr_to_log}")
            # Publish multiple lines if stderr_to_log contains newlines
            for err_line in stderr_to_log.strip().split('\n'):
                publish_log(job_id, "stderr", err_line)

            if job:
                job.meta['error_message'] = error_message
                job.meta['stderr_snippet'] = stderr_to_log # Store more stderr
                job.save_meta()
            raise subprocess.CalledProcessError(return_code or 1, command, output=full_stdout, stderr=full_stderr)

    # --- Exception Handling ---
    except subprocess.TimeoutExpired as e:
        error_msg = "Sarek pipeline timed out."
        logger.error(f"[Job {job_id}] {error_msg}")
        publish_log(job_id, "error", error_msg)
        stderr_output = e.stderr if e.stderr else 'N/A'
        if job: job.meta['error_message'] = error_msg; job.meta['stderr_snippet'] = stderr_output[:1000]; job.save_meta()
        raise # Re-raise to fail the RQ job
    except FileNotFoundError as e:
         error_msg = f"Error executing pipeline: {e}"
         logger.error(f"[Job {job_id}] {error_msg}")
         publish_log(job_id, "error", error_msg)
         if job: job.meta['error_message'] = f"Task execution error: {e}"; job.save_meta()
         raise # Re-raise to fail the RQ job
    except Exception as e:
        # Catch any other unexpected error during execution or result processing
        error_msg = f"An unexpected error occurred during pipeline execution: {type(e).__name__}"
        logger.exception(f"[Job {job_id}] {error_msg}")
        publish_log(job_id, "error", f"{error_msg}: {e}")
        if job:
            job.meta['error_message'] = error_msg
            job.meta['error_details'] = str(e)
            job.save_meta()
        # Re-raise the original exception to ensure RQ marks the job as failed
        raise e
    finally:
        # Publish end marker ONLY IF we have a valid job ID
        if job_id and not job_id.startswith("N/A"):
            publish_log(job_id, "control", "EOF")
            logger.info(f"[Job {job_id}] Published EOF marker.")

        # --- Cleanup temporary CSV file (Keep as is) ---
        if input_csv_path_str and Path(input_csv_path_str).exists():
            try:
                os.remove(input_csv_path_str)
                logger.info(f"[Job {job_id}] Cleaned up temporary CSV file: {input_csv_path_str}")
            except OSError as remove_e:
                logger.warning(f"[Job {job_id}] Could not clean up temporary CSV file {input_csv_path_str}: {remove_e}")
