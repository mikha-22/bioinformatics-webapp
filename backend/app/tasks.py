# ./backend/app/tasks.py
import subprocess
import logging
from pathlib import Path
import time
import psutil
import math
import json
import os # Import os for path checks and cleanup
from typing import Optional, List

# --- RQ Import for getting job context ---
from rq import get_current_job

# --- Configure Logging for RQ Worker ---
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# --- Path Definitions ---
MONITORING_INTERVAL_SECONDS = 5
METADATA_FILENAME = "run_metadata.json" # Define constant for filename

def get_current_job_id():
    """Safely gets the current RQ job ID."""
    job = get_current_job()
    return job.id if job else "N/A (Not in RQ context)"

# --- Updated Function Signature (Signature itself is already updated from previous step) ---
def run_pipeline_task(
    input_csv_path_str: str,
    outdir_base_path_str: str, # Base directory for output
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
):
    """
    The background task function executed by the RQ worker.
    Runs the Sarek pipeline wrapper script (sarek_pipeline.sh)
    with the provided parameters and saves run metadata on success.
    """
    job = get_current_job()
    job_id = job.id if job else "N/A (Not in RQ context)"
    final_results_dir = None # Variable to store the final output dir path

    # --- Logging (Keep as is) ---
    logger.info(f"[Job {job_id}] Starting Sarek pipeline task...")
    # (Log all parameters as before)
    logger.info(f"[Job {job_id}] Input CSV: {input_csv_path_str}")
    logger.info(f"[Job {job_id}] Output Base Dir: {outdir_base_path_str}")
    logger.info(f"[Job {job_id}] Genome: {genome}")
    logger.info(f"[Job {job_id}] Tools: {tools}")
    logger.info(f"[Job {job_id}] Step: {step}")
    logger.info(f"[Job {job_id}] Profile: {profile}")
    logger.info(f"[Job {job_id}] Aligner: {aligner}")
    if intervals_path_str: logger.info(f"[Job {job_id}] Intervals: {intervals_path_str}")
    if dbsnp_path_str: logger.info(f"[Job {job_id}] dbSNP: {dbsnp_path_str}")
    if known_indels_path_str: logger.info(f"[Job {job_id}] Known Indels: {known_indels_path_str}")
    if pon_path_str: logger.info(f"[Job {job_id}] PoN: {pon_path_str}")
    logger.info(f"[Job {job_id}] Joint Germline: {joint_germline}")
    logger.info(f"[Job {job_id}] WES: {wes}")
    logger.info(f"[Job {job_id}] Trim FASTQ: {trim_fastq}")
    logger.info(f"[Job {job_id}] Skip QC: {skip_qc}")
    logger.info(f"[Job {job_id}] Skip Annotation: {skip_annotation}")

    # --- Command Construction (Keep as is) ---
    script_path = Path(__file__).resolve().parent / "sarek_pipeline.sh"
    if not script_path.exists():
         logger.error(f"[Job {job_id}] CRITICAL: Sarek wrapper script not found at {script_path}")
         raise FileNotFoundError(f"Sarek wrapper script not found: {script_path}")

    command = [
        "bash", str(script_path),
        input_csv_path_str, outdir_base_path_str, genome,
        tools if tools else "", step if step else "", profile if profile else "", aligner if aligner else "",
        intervals_path_str if intervals_path_str else "",
        dbsnp_path_str if dbsnp_path_str else "",
        known_indels_path_str if known_indels_path_str else "",
        pon_path_str if pon_path_str else "",
        "true" if joint_germline else "false", "true" if wes else "false",
        "true" if trim_fastq else "false", "true" if skip_qc else "false",
        "true" if skip_annotation else "false"
    ]
    script_working_dir = script_path.parent
    logger.info(f"[Job {job_id}] Running command in directory: {script_working_dir}")
    logger.info(f"[Job {job_id}] Command: {' '.join(command)}")

    # --- Resource Monitoring Variables (Keep as is) ---
    peak_memory_mb = 0
    cpu_percentages = []
    process_psutil = None
    start_time = time.time()

    try:
        # --- Process Execution and Monitoring (Keep as is) ---
        process = subprocess.Popen(
            command, cwd=str(script_working_dir), stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1
        )
        logger.info(f"[Job {job_id}] Pipeline process started with PID: {process.pid}")
        try:
            process_psutil = psutil.Process(process.pid)
            process_psutil.cpu_percent(interval=None)
            time.sleep(0.1)
        except psutil.NoSuchProcess: logger.warning(f"[Job {job_id}] Process {process.pid} finished before monitoring could start."); process_psutil = None
        except Exception as init_monitor_err: logger.error(f"[Job {job_id}] Error initializing resource monitor for PID {process.pid}: {init_monitor_err}"); process_psutil = None

        stdout_lines = []
        stderr_lines = []
        while process.poll() is None:
             if process_psutil:
                 try:
                     cpu = process_psutil.cpu_percent(interval=MONITORING_INTERVAL_SECONDS)
                     if cpu is not None: cpu_percentages.append(cpu)
                     mem_info = process_psutil.memory_info()
                     current_memory_mb = mem_info.rss / (1024 * 1024)
                     peak_memory_mb = max(peak_memory_mb, current_memory_mb)
                 except psutil.NoSuchProcess: logger.warning(f"[Job {job_id}] Process {process.pid} ended during monitoring loop."); break
                 except Exception as monitor_err: logger.error(f"[Job {job_id}] Error during resource monitoring: {monitor_err}"); time.sleep(MONITORING_INTERVAL_SECONDS)
             else: time.sleep(MONITORING_INTERVAL_SECONDS)

             if process.stdout:
                 line = process.stdout.readline()
                 if line:
                     stdout_lines.append(line)
                     logger.info(f"[Job {job_id}][STDOUT] {line.strip()}")
                     if "Results directory:" in line:
                         try: final_results_dir = line.split("Results directory:", 1)[1].strip()
                         except IndexError: logger.warning(f"[Job {job_id}] Could not parse results directory from line: {line.strip()}")
             if process.stderr:
                 line = process.stderr.readline()
                 if line: stderr_lines.append(line); logger.warning(f"[Job {job_id}][STDERR] {line.strip()}")

        # --- Process Finished - Capture final output & stats (Keep as is) ---
        stdout_rem, stderr_rem = process.communicate()
        if stdout_rem:
             stdout_lines.append(stdout_rem)
             logger.info(f"[Job {job_id}][STDOUT] {stdout_rem.strip()}")
             if not final_results_dir and "Results directory:" in stdout_rem:
                 for line in stdout_rem.splitlines():
                     if "Results directory:" in line:
                          try: final_results_dir = line.split("Results directory:", 1)[1].strip(); break
                          except IndexError: logger.warning(f"[Job {job_id}] Could not parse results directory from line: {line.strip()}")
        if stderr_rem: stderr_lines.append(stderr_rem); logger.warning(f"[Job {job_id}][STDERR] {stderr_rem.strip()}")

        return_code = process.returncode
        end_time = time.time()
        duration_seconds = end_time - start_time
        logger.info(f"[Job {job_id}] Pipeline process {process.pid} finished with code {return_code} after {duration_seconds:.2f}s.")
        average_cpu = sum(cpu_percentages) / len(cpu_percentages) if cpu_percentages else 0

        # --- Update Job Meta with Final Stats (Keep as is) ---
        if job:
            job.meta['peak_memory_mb'] = round(peak_memory_mb, 1)
            job.meta['average_cpu_percent'] = round(average_cpu, 1)
            job.meta['duration_seconds'] = round(duration_seconds, 2)
            job.save_meta()
            logger.info(f"[Job {job_id}] Saved final resource stats to job meta.")

        # --- Handle Success/Failure ---
        full_stderr = "".join(stderr_lines)
        if return_code == 0:
            logger.info(f"[Job {job_id}] Sarek pipeline finished successfully.")
            if final_results_dir:
                results_path_obj = Path(final_results_dir)
                if results_path_obj.is_dir():
                     logger.info(f"[Job {job_id}] Confirmed results directory exists: {final_results_dir}")
                     if job:
                          job.meta['results_path'] = final_results_dir
                          job.save_meta()
                          # --- Save Metadata File ---
                          try:
                              metadata_to_save = job.meta # Save the entire current job meta
                              metadata_file_path = results_path_obj / METADATA_FILENAME
                              with open(metadata_file_path, 'w') as f:
                                  json.dump(metadata_to_save, f, indent=4)
                              logger.info(f"[Job {job_id}] Saved run metadata to {metadata_file_path}")
                          except Exception as meta_err:
                               # Log error but don't fail the job just because metadata couldn't be saved
                               logger.error(f"[Job {job_id}] Failed to save run metadata file: {meta_err}")
                          # --- End Save Metadata File ---

                     return { "status": "success", "results_path": final_results_dir, "resources": job.meta if job else {} }
                else:
                     logger.error(f"[Job {job_id}] Pipeline reported success, but results directory '{final_results_dir}' not found!")
                     error_message = f"Pipeline finished successfully, but results directory '{final_results_dir}' was not found."
                     if job: job.meta['error_message'] = error_message; job.save_meta()
                     raise RuntimeError(error_message)
            else:
                logger.warning(f"[Job {job_id}] Pipeline finished successfully, but could not determine results directory from output.")
                if job: job.meta['warning_message'] = "Pipeline finished, results dir unclear."; job.save_meta()
                return { "status": "success", "message": "Pipeline finished, results directory unclear.", "resources": job.meta if job else {} }
        else:
            # Failure case (Keep as is)
            error_message = f"Sarek pipeline failed with return code {return_code}."
            logger.error(f"[Job {job_id}] {error_message}")
            logger.error(f"[Job {job_id}] STDERR Snippet:\n{full_stderr[:1000]}")
            if job: job.meta['error_message'] = error_message; job.meta['stderr_snippet'] = full_stderr[:1000]; job.save_meta()
            raise subprocess.CalledProcessError(return_code, command, output="".join(stdout_lines), stderr=full_stderr)

    # --- Exception Handling (Keep as is) ---
    except subprocess.TimeoutExpired as e:
        logger.error(f"[Job {job_id}] Sarek pipeline timed out.")
        stderr_output = e.stderr if e.stderr else 'N/A'
        if job: job.meta['error_message'] = "Pipeline timed out."; job.meta['stderr_snippet'] = stderr_output[:1000]; job.save_meta()
        raise e
    except FileNotFoundError as e:
         logger.error(f"[Job {job_id}] Error executing pipeline: {e}")
         if job: job.meta['error_message'] = f"Task execution error: {e}"; job.save_meta()
         raise
    except Exception as e:
        logger.exception(f"[Job {job_id}] An unexpected error occurred during pipeline execution.")
        if job: job.meta['error_message'] = f"Unexpected task error: {type(e).__name__}"; job.meta['error_details'] = str(e); job.save_meta()
        raise e
    finally:
        # --- Cleanup temporary CSV file (Keep as is) ---
        if input_csv_path_str and Path(input_csv_path_str).exists():
             try: os.remove(input_csv_path_str); logger.info(f"[Job {job_id}] Cleaned up temporary CSV file: {input_csv_path_str}")
             except OSError as remove_e: logger.warning(f"[Job {job_id}] Could not clean up temporary CSV file {input_csv_path_str}: {remove_e}")
