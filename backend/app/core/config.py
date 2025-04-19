# backend/app/core/config.py
import logging
from pathlib import Path
import os

logger = logging.getLogger(__name__)

# --- Path Definitions ---
try:
    APP_FILE_PATH = Path(__file__).resolve() # Path to this config.py file
    CORE_DIR = APP_FILE_PATH.parent
    BACKEND_APP_DIR = CORE_DIR.parent
    PROJECT_ROOT = BACKEND_APP_DIR.parents[1]
    # REMOVED: FRONTEND_DIR = PROJECT_ROOT / "frontend"
    # REMOVED: TEMPLATES_DIR = FRONTEND_DIR / "templates"
    # REMOVED: STATIC_DIR = FRONTEND_DIR / "static"
    BIOINFORMATICS_DIR = PROJECT_ROOT / "bioinformatics"
    DATA_DIR = BIOINFORMATICS_DIR / "data"
    RESULTS_DIR = BIOINFORMATICS_DIR / "results"
    DOCKER_DIR = PROJECT_ROOT / "docker"
    # RENAMED: The actual script called by the task
    SAREK_PIPELINE_SCRIPT_PATH = BACKEND_APP_DIR / "sarek_pipeline.sh"

    # Ensure essential dirs are logged
    logger.info(f"PROJECT_ROOT determined as: {PROJECT_ROOT}")
    logger.info(f"BACKEND_APP_DIR determined as: {BACKEND_APP_DIR}")
    logger.info(f"DATA_DIR set to: {DATA_DIR}")
    logger.info(f"RESULTS_DIR set to: {RESULTS_DIR}")
    logger.info(f"SAREK_PIPELINE_SCRIPT_PATH set to: {SAREK_PIPELINE_SCRIPT_PATH}")

except Exception as e:
    logger.exception("CRITICAL: Failed to calculate essential paths.", exc_info=True)
    raise RuntimeError(f"Failed to calculate essential paths: {e}")


# --- Redis/RQ Configuration ---
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = 6379
REDIS_DB = 0
PIPELINE_QUEUE_NAME = "pipeline_tasks"
STAGED_JOBS_KEY = "staged_pipeline_jobs" # Key for Redis Hash storing staged jobs

logger.info(f"Using REDIS_HOST: {REDIS_HOST}")

# --- Job Settings ---
DEFAULT_JOB_TIMEOUT = '2h' # Default timeout for RQ job itself
DEFAULT_RESULT_TTL = 86400  # Keep successful job result 1 day
DEFAULT_FAILURE_TTL = 604800 # Keep failed job result 1 week
MAX_REGISTRY_JOBS = 50 # Max finished/failed jobs to fetch for the list view

# --- Sarek Pipeline Configuration ---
SAREK_DEFAULT_PROFILE = "docker"  # Default container system to use
SAREK_DEFAULT_TOOLS = "strelka,mutect2"  # Default variant calling tools
SAREK_DEFAULT_STEP = "mapping"  # Default pipeline step to start from
SAREK_DEFAULT_ALIGNER = "bwa-mem" # Default aligner
