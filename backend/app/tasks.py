# ./backend/app/tasks.py
import subprocess
import logging
from pathlib import Path
import time
import psutil
import math
import json
from typing import Optional

# --- RQ Import for getting job context ---
from rq import get_current_job

# --- Configure Logging for RQ Worker ---
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# --- Path Definitions ---
PROJECT_ROOT = Path(__file__).resolve().parents[2]
RESULTS_BASE_DIR = PROJECT_ROOT / "bioinformatics" / "results"
MONITORING_INTERVAL_SECONDS = 5

def get_current_job_id():
    """Safely gets the current RQ job ID."""
    job = get_current_job()
    return job.id if job else "N/A (Not in RQ context)"

def run_pipeline_task(
    input_csv_path_str: str,
    outdir_path_str: str,
    genome: str,
    tools: str,
    step: str,
    profile: str,
    intervals_path_str: Optional[str] = None,
    known_variants_path_str: Optional[str] = None,
    joint_germline: bool = False,
    wes: bool = False,
):
    """
    The background task function executed by the RQ worker.
    Runs the Sarek pipeline script with the provided parameters.
    """
    job = get_current_job()
    job_id = job.id if job else "N/A (Not in RQ context)"

    logger.info(f"[Job {job_id}] Starting Sarek pipeline task...")
    logger.info(f"[Job {job_id}] Input CSV: {input_csv_path_str}")
    logger.info(f"[Job {job_id}] Genome: {genome}")
    logger.info(f"[Job {job_id}] Tools: {tools}")
    logger.info(f"[Job {job_id}] Step: {step}")
    logger.info(f"[Job {job_id}] Profile: {profile}")
    if intervals_path_str:
        logger.info(f"[Job {job_id}] Intervals: {intervals_path_str}")
    if known_variants_path_str:
        logger.info(f"[Job {job_id}] Known Variants: {known_variants_path_str}")
    logger.info(f"[Job {job_id}] Joint Germline: {joint_germline}")
    logger.info(f"[Job {job_id}] WES: {wes}")

    # Construct the command
    command = [
        "bash",
        "/app/backend/app/sarek_pipeline.sh",
        "--input_csv", input_csv_path_str,
        "--outdir", outdir_path_str,
        "--genome", genome,
        "--tools", tools,
        "--step", step,
        "--profile", profile
    ]

    # Add optional parameters if provided
    if intervals_path_str:
        command.extend(["--intervals", intervals_path_str])
    if known_variants_path_str:
        command.extend(["--known_variants", known_variants_path_str])
    if joint_germline:
        command.append("--joint_germline")
    if wes:
        command.append("--wes")

    script_working_dir = Path("/app/backend/app")
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
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        logger.info(f"[Job {job_id}] Pipeline process started with PID: {process.pid}")

        try:
            process_psutil = psutil.Process(process.pid)
            process_psutil.cpu_percent(interval=None)
            time.sleep(0.1)
        except psutil.NoSuchProcess:
            logger.warning(f"[Job {job_id}] Process {process.pid} finished before monitoring could start.")
            process_psutil = None

        # --- Monitoring Loop ---
        while process.poll() is None:
            if process_psutil:
                try:
                    cpu = process_psutil.cpu_percent(interval=MONITORING_INTERVAL_SECONDS)
                    if cpu is not None:
                        cpu_percentages.append(cpu)

                    mem_info = process_psutil.memory_info()
                    current_memory_mb = mem_info.rss / (1024 * 1024)
                    peak_memory_mb = max(peak_memory_mb, current_memory_mb)

                except psutil.NoSuchProcess:
                    logger.warning(f"[Job {job_id}] Process {process.pid} ended during monitoring loop.")
                    break
                except Exception as monitor_err:
                    logger.error(f"[Job {job_id}] Error during resource monitoring: {monitor_err}")
                    time.sleep(MONITORING_INTERVAL_SECONDS)
            else:
                time.sleep(MONITORING_INTERVAL_SECONDS)

        # --- Process Finished - Get Output and Final Status ---
        stdout, stderr = process.communicate()
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
            job.save_meta()
            logger.info(f"[Job {job_id}] Saved final resource stats to job meta.")

        # --- Handle Success/Failure ---
        if return_code == 0:
            logger.info(f"[Job {job_id}] Sarek pipeline finished successfully.")
            
            # Parse the results directory from stdout
            results_dir = None
            for line in stdout.splitlines():
                if "Created results directory:" in line:
                    results_dir = line.split(":")[1].strip()
                    break

            if results_dir:
                results_path = str(RESULTS_BASE_DIR / results_dir)
                logger.info(f"[Job {job_id}] Results directory: {results_path}")
                return {
                    "status": "success",
                    "results_path": results_path,
                    "resources": job.meta
                }
            else:
                logger.warning(f"[Job {job_id}] Could not determine results directory from pipeline output.")
                return {
                    "status": "success",
                    "message": "Pipeline finished, results dir unclear.",
                    "resources": job.meta
                }
        else:
            error_message = f"Sarek pipeline failed with return code {return_code}."
            logger.error(f"[Job {job_id}] {error_message}")
            logger.error(f"[Job {job_id}] STDERR:\n{stderr}")
            if job:
                job.meta['error_message'] = error_message
                job.meta['stderr_snippet'] = stderr[:1000]
                job.save_meta()
            raise subprocess.CalledProcessError(return_code, command, output=stdout, stderr=stderr)

    except subprocess.TimeoutExpired as e:
        logger.error(f"[Job {job_id}] Sarek pipeline timed out.")
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
        raise e
