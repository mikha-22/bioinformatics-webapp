# backend/app/core/redis_rq.py
import logging
import redis
from rq import Queue
from .config import REDIS_HOST, REDIS_PORT, REDIS_DB, PIPELINE_QUEUE_NAME

logger = logging.getLogger(__name__)

redis_conn = None
pipeline_queue = None

try:
    # decode_responses=False is important for RQ compatibility (RQ handles serialization)
    redis_conn = redis.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        db=REDIS_DB,
        decode_responses=False
    )
    redis_conn.ping()
    logger.info(f"Successfully connected to Redis at {REDIS_HOST}:{REDIS_PORT} DB:{REDIS_DB}")
    pipeline_queue = Queue(PIPELINE_QUEUE_NAME, connection=redis_conn)
    logger.info(f"RQ Queue '{PIPELINE_QUEUE_NAME}' initialized.")
except redis.exceptions.ConnectionError as e:
    logger.error(f"FATAL: Could not connect to Redis at {REDIS_HOST}:{REDIS_PORT}. RQ and Job Management will NOT work. Error: {e}")
    # Keep redis_conn and pipeline_queue as None
except Exception as e:
    logger.error(f"FATAL: An unexpected error occurred during Redis/RQ initialization: {e}", exc_info=True)
    # Keep redis_conn and pipeline_queue as None

def get_redis_connection():
    """ Dependency function to get the Redis connection. """
    if not redis_conn:
        raise ConnectionError("Redis connection is not available.")
    return redis_conn

def get_pipeline_queue():
    """ Dependency function to get the RQ Pipeline Queue. """
    if not pipeline_queue:
        raise ConnectionError("RQ pipeline queue is not available.")
    return pipeline_queue
