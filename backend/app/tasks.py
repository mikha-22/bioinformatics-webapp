# backend/app/tasks.py
import subprocess
import logging
from pathlib import Path
import time # Can be used for debugging/simulating work
# --- RQ Import for getting job context ---
from rq import get_current_job

# --- Configure Logging for RQ Worker ---
# Use a standard format WITHOUT job_id here.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s' # <-- REMOVED [Job %(job_id)s]
)
logger = logging.getLogger(__name__) # Use the specific module logger

# --- Path Definitions ---
PROJECT_ROOT = Path(__file__).resolve().parents[2]
RESULTS_BASE_DIR = PROJECT_ROOT / "bioinformatics" / "results"

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
    Runs the pipeline.sh script, logs output, and handles errors.
    Returns a dictionary with status and results path/message on completion.
    """
    job_id = get_current_job_id() # Get the job ID

    # Add the job ID manually to log messages within the task
    logger.info(f"[Job {job_id}] Starting pipeline task...")
    logger.info(f"[Job {job_id}] Pipeline Script: {pipeline_script_path_str}")
    logger.info(f"[Job {job_id}] Forward Reads: {forward_reads_path_str}")
    logger.info(f"[Job {job_id}] Reverse Reads: {reverse_reads_path_str}")
    logger.info(f"[Job {job_id}] Reference Genome: {reference_genome_path_str}")
    logger.info(f"[Job {job_id}] Target Regions: {target_regions_path_str}")
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

    # Determine the correct working directory for pipeline.sh
    script_working_dir = Path(pipeline_script_path_str).parent
    logger.info(f"[Job {job_id}] Running command in directory: {script_working_dir}")
    logger.info(f"[Job {job_id}] Command: {' '.join(command)}")


    try:
        # Execute the pipeline script
        process = subprocess.run(
            command,
            cwd=str(script_working_dir), # Run from the script's directory
            capture_output=True,         # Capture stdout/stderr
            text=True,                   # Decode output as text
            check=True,                  # Raise CalledProcessError on non-zero exit
            timeout=7200                 # Example: 2-hour timeout
        )

        logger.info(f"[Job {job_id}] Pipeline script finished successfully.")
        # logger.debug(f"[Job {job_id}] STDOUT:\n{process.stdout}") # Uncomment for debugging

        # --- Attempt to find the results directory name ---
        results_dir_name = None
        for line in process.stdout.splitlines():
            # *** IMPORTANT: Adjust this prefix based on your pipeline.sh ACTUAL output ***
            prefix = "Created results directory: "
            if line.startswith(prefix):
                results_dir_name = line[len(prefix):].strip()
                break

        if results_dir_name:
             results_path = str(RESULTS_BASE_DIR / results_dir_name)
             logger.info(f"[Job {job_id}] Identified results directory: {results_path}")
             return {"status": "success", "results_path": results_path}
        else:
             logger.warning(f"[Job {job_id}] Could not determine results directory from pipeline output.")
             return {"status": "success", "message": "Pipeline finished, but results directory unclear from output."}

    except subprocess.CalledProcessError as e:
        logger.error(f"[Job {job_id}] Pipeline script failed with return code {e.returncode}.")
        logger.error(f"[Job {job_id}] STDERR:\n{e.stderr}")
        raise e
    except subprocess.TimeoutExpired as e:
        logger.error(f"[Job {job_id}] Pipeline script timed out after {e.timeout} seconds.")
        stderr_output = e.stderr.decode('utf-8', errors='ignore') if e.stderr else 'N/A'
        logger.error(f"[Job {job_id}] STDERR captured before timeout:\n{stderr_output}")
        raise e
    except Exception as e:
        logger.exception(f"[Job {job_id}] An unexpected error occurred during pipeline execution.")
        raise e
