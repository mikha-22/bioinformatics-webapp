# ./backend/app/tasks.py
import subprocess
import logging
from pathlib import Path
import time
import psutil # <-- Import psutil
import math   # <-- For rounding

# --- RQ Import for getting job context ---
from rq import get_current_job

# --- Configure Logging for RQ Worker ---
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__) # Use the specific module logger

# --- Path Definitions ---
PROJECT_ROOT = Path(__file__).resolve().parents[2]
RESULTS_BASE_DIR = PROJECT_ROOT / "bioinformatics" / "results"
MONITORING_INTERVAL_SECONDS = 5 # Check resource usage every 5 seconds

# --- Helper to get Job ID within the task ---
def get_current_job_id():
    """Safely gets the current RQ job ID."""
    job = get_current_job()
    return job.id if job else "N/A (Not in RQ context)"

# --- RQ Task Function ---
def run_pipeline_task(
    pipeline_script_path_str: str,
    forward_reads_path_str: str,
    reverse_reads_path_str: str,
    reference_genome_path_str: str,
    target_regions_path_str: str,
    known_variants_path_str: str,
):
    """
    The background task function executed by the RQ worker.
    Runs the pipeline.sh script, logs output, monitors resources, and handles errors.
    Returns a dictionary with status and results path/message on completion.
    """
    job = get_current_job()
    job_id = job.id if job else "N/A (Not in RQ context)"

    logger.info(f"[Job {job_id}] Starting pipeline task...")
    logger.info(f"[Job {job_id}] Pipeline Script: {pipeline_script_path_str}")
    # Log other inputs as before...
    logger.info(f"[Job {job_id}] Known Variants: {known_variants_path_str or 'N/A'}")

    command = [
        "bash",
        pipeline_script_path_str,
        forward_reads_path_str,
        reverse_reads_path_str,
        reference_genome_path_str,
        target_regions_path_str,
        known_variants_path_str or "", # Pass empty string if None/empty
    ]

    script_working_dir = Path(pipeline_script_path_str).parent
    logger.info(f"[Job {job_id}] Running command in directory: {script_working_dir}")
    logger.info(f"[Job {job_id}] Command: {' '.join(command)}")

    # --- Resource Monitoring Variables ---
    peak_memory_mb = 0
    cpu_percentages = []
    process_psutil = None
    start_time = time.time()

    try:
        # --- Use Popen for non-blocking execution ---
        process = subprocess.Popen(
            command,
            cwd=str(script_working_dir),
            stdout=subprocess.PIPE,      # Capture stdout
            stderr=subprocess.PIPE,      # Capture stderr
            text=True                    # Decode output as text
        )

        logger.info(f"[Job {job_id}] Pipeline process started with PID: {process.pid}")

        try:
            process_psutil = psutil.Process(process.pid)
            # Read initial CPU and Memory (optional, but good practice)
            process_psutil.cpu_percent(interval=None) # First call returns 0.0 or None, prime it
            time.sleep(0.1) # Short sleep before first real measurement

        except psutil.NoSuchProcess:
            logger.warning(f"[Job {job_id}] Process {process.pid} finished before monitoring could start.")
            process_psutil = None # Ensure it's None if process is gone

        # --- Monitoring Loop ---
        while process.poll() is None: # While process is running
            if process_psutil:
                try:
                    # Get CPU Usage (interval helps average over the period)
                    cpu = process_psutil.cpu_percent(interval=MONITORING_INTERVAL_SECONDS)
                    if cpu is not None: # Can be None on first call if interval=0/None
                         cpu_percentages.append(cpu)

                    # Get Memory Usage (RSS)
                    mem_info = process_psutil.memory_info()
                    current_memory_mb = mem_info.rss / (1024 * 1024) # Convert bytes to MB
                    peak_memory_mb = max(peak_memory_mb, current_memory_mb)

                    # Optional: Update job meta periodically (more overhead)
                    # if job:
                    #     job.meta['current_cpu'] = cpu
                    #     job.meta['peak_memory_mb_so_far'] = round(peak_memory_mb, 1)
                    #     job.save_meta()

                except psutil.NoSuchProcess:
                    logger.warning(f"[Job {job_id}] Process {process.pid} ended during monitoring loop.")
                    break # Exit loop if process is gone
                except Exception as monitor_err:
                    logger.error(f"[Job {job_id}] Error during resource monitoring: {monitor_err}")
                    # Decide whether to break or continue monitoring if possible
                    time.sleep(MONITORING_INTERVAL_SECONDS) # Avoid tight loop on error
            else:
                 # Process finished too quickly, just wait normally
                 time.sleep(MONITORING_INTERVAL_SECONDS)


        # --- Process Finished - Get Output and Final Status ---
        stdout, stderr = process.communicate() # Get remaining output
        return_code = process.returncode
        end_time = time.time()
        duration_seconds = end_time - start_time

        logger.info(f"[Job {job_id}] Pipeline process {process.pid} finished with code {return_code} after {duration_seconds:.2f}s.")

        # Calculate average CPU
        average_cpu = sum(cpu_percentages) / len(cpu_percentages) if cpu_percentages else 0

        # --- Update Job Meta with Final Stats ---
        if job:
            job.meta['peak_memory_mb'] = round(peak_memory_mb, 1)
            job.meta['average_cpu_percent'] = round(average_cpu, 1)
            job.meta['duration_seconds'] = round(duration_seconds, 2)
            # Remove temporary keys if used
            # job.meta.pop('current_cpu', None)
            # job.meta.pop('peak_memory_mb_so_far', None)
            job.save_meta()
            logger.info(f"[Job {job_id}] Saved final resource stats to job meta.")

        # --- Handle Success/Failure ---
        if return_code == 0:
            logger.info(f"[Job {job_id}] Pipeline script finished successfully.")
            # logger.debug(f"[Job {job_id}] STDOUT:\n{stdout}")

            # Attempt to find results directory (same logic as before)
            results_dir_name = None
            for line in stdout.splitlines():
                prefix = "Created results directory: " # Make sure this matches pipeline.sh output
                if line.startswith(prefix):
                    results_dir_name = line[len(prefix):].strip()
                    break

            if results_dir_name:
                 results_path = str(RESULTS_BASE_DIR / results_dir_name)
                 logger.info(f"[Job {job_id}] Identified results directory: {results_path}")
                 # Include stats in return value as well (optional, already in meta)
                 return {"status": "success", "results_path": results_path, "resources": job.meta}
            else:
                 logger.warning(f"[Job {job_id}] Could not determine results directory from pipeline output.")
                 return {"status": "success", "message": "Pipeline finished, results dir unclear.", "resources": job.meta}

        else: # Non-zero return code
             error_message = f"Pipeline script failed with return code {return_code}."
             logger.error(f"[Job {job_id}] {error_message}")
             logger.error(f"[Job {job_id}] STDERR:\n{stderr}")
             # Store specific error in meta
             if job:
                 job.meta['error_message'] = error_message
                 job.meta['stderr_snippet'] = stderr[:1000] # Store first 1000 chars
                 job.save_meta()
             # Re-raise an exception so RQ marks the job as failed
             raise subprocess.CalledProcessError(return_code, command, output=stdout, stderr=stderr)

    except subprocess.TimeoutExpired as e:
        # This is less likely with Popen unless communicate() times out
        logger.error(f"[Job {job_id}] Pipeline script command timed out.")
        stderr_output = e.stderr if e.stderr else 'N/A'
        if job:
            job.meta['error_message'] = "Pipeline timed out."
            job.meta['stderr_snippet'] = stderr_output[:1000]
            job.save_meta()
        raise e
    except Exception as e:
        logger.exception(f"[Job {job_id}] An unexpected error occurred during pipeline execution.")
        if job:
            job.meta['error_message'] = f"Unexpected task error: {type(e).__name__}"
            job.meta['error_details'] = str(e)
            job.save_meta()
        raise e # Re-raise for RQ failure handling
