
# backend/app/core/config.py
import logging
from pathlib import Path
import os

logger = logging.getLogger(__name__)

# --- Path Definitions ---
try:
    # Keep project structure paths if needed elsewhere (e.g., finding scripts)
    APP_FILE_PATH = Path(__file__).resolve() # Path to this config.py file
    CORE_DIR = APP_FILE_PATH.parent
    BACKEND_APP_DIR = CORE_DIR.parent
    PROJECT_ROOT = BACKEND_APP_DIR.parents[1]
    DOCKER_DIR = PROJECT_ROOT / "docker"
    SAREK_PIPELINE_SCRIPT_PATH = BACKEND_APP_DIR / "sarek_pipeline.sh"

    # --- *** OVERRIDE DATA and RESULTS paths for local execution *** ---
    # Use the specified absolute host paths directly
    DATA_DIR = Path("/home/admin01/work/mnt/nas/mikha_temp/data").resolve()
    RESULTS_DIR = Path("/home/admin01/work/mnt/nas/mikha_temp/results").resolve()
    # --- *** END OVERRIDE *** ---

    # Log the paths being used
    logger.info(f"PROJECT_ROOT determined as: {PROJECT_ROOT}")
    logger.info(f"BACKEND_APP_DIR determined as: {BACKEND_APP_DIR}")
    logger.info(f"DATA_DIR OVERRIDDEN TO: {DATA_DIR}")
    logger.info(f"RESULTS_DIR OVERRIDDEN TO: {RESULTS_DIR}")
    logger.info(f"SAREK_PIPELINE_SCRIPT_PATH set to: {SAREK_PIPELINE_SCRIPT_PATH}")

    # Optional: Check if these overridden directories exist at startup
    if not DATA_DIR.is_dir():
        logger.warning(f"Configured DATA_DIR does not exist or is not a directory: {DATA_DIR}")
    if not RESULTS_DIR.is_dir():
        logger.warning(f"Configured RESULTS_DIR does not exist or is not a directory: {RESULTS_DIR}")
        # Optionally create it?
        # try:
        #     RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        #     logger.info(f"Created RESULTS_DIR: {RESULTS_DIR}")
        # except OSError as e:
        #     logger.error(f"Failed to create RESULTS_DIR {RESULTS_DIR}: {e}")


except Exception as e:
    logger.exception("CRITICAL: Failed to calculate essential paths.", exc_info=True)
    raise RuntimeError(f"Failed to calculate essential paths: {e}")


# --- Redis/RQ Configuration ---
# Point to the Redis container name or IP accessible from the host
REDIS_HOST = os.getenv("REDIS_HOST", "localhost") # Use localhost if Redis is exposed on host port 6379
REDIS_PORT = int(os.getenv("REDIS_PORT", 6379)) # Ensure port is integer
REDIS_DB = int(os.getenv("REDIS_DB", 0))         # Ensure db is integer
PIPELINE_QUEUE_NAME = "pipeline_tasks"
STAGED_JOBS_KEY = "staged_pipeline_jobs" # Key for Redis Hash storing staged jobs
PIPELINE_PROFILES_KEY = "pipeline_profiles" # Key for storing profiles
LOG_CHANNEL_PREFIX = "logs:"
# --- ADD THIS LINE ---
LOG_HISTORY_PREFIX = "log_history:" # Prefix for Redis List storing log history
# --- END ADD ---

logger.info(f"Using REDIS_HOST: {REDIS_HOST}:{REDIS_PORT} DB:{REDIS_DB}")

# --- Job Settings ---
# Convert TTL strings from environment or use defaults (make sure they are integers)
try:
    DEFAULT_RESULT_TTL = int(os.getenv("DEFAULT_RESULT_TTL", 86400)) # Keep successful job result 1 day
except ValueError:
    logger.warning("Invalid DEFAULT_RESULT_TTL environment variable. Using default: 86400")
    DEFAULT_RESULT_TTL = 86400

try:
    DEFAULT_FAILURE_TTL = int(os.getenv("DEFAULT_FAILURE_TTL", 604800)) # Keep failed job result 1 week
except ValueError:
    logger.warning("Invalid DEFAULT_FAILURE_TTL environment variable. Using default: 604800")
    DEFAULT_FAILURE_TTL = 604800

try:
    # Ensure timeout is a string for RQ or an integer in seconds (RQ handles '1h' etc.)
    # Let's keep it as a string compatible with RQ, defaulting to '2h'
    DEFAULT_JOB_TIMEOUT = os.getenv("DEFAULT_JOB_TIMEOUT", '2h')
except ValueError:
     logger.warning("Invalid DEFAULT_JOB_TIMEOUT environment variable. Using default: '2h'")
     DEFAULT_JOB_TIMEOUT = '2h'

MAX_REGISTRY_JOBS = 50 # Max finished/failed jobs to fetch for the list view

# --- Sarek Pipeline Configuration ---
SAREK_DEFAULT_PROFILE = "docker"  # Default container system to use
SAREK_DEFAULT_TOOLS = "strelka,mutect2"  # Default variant calling tools
SAREK_DEFAULT_STEP = "mapping"  # Default pipeline step to start from
SAREK_DEFAULT_ALIGNER = "bwa-mem" # Default aligner
