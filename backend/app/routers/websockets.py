# backend/app/routers/websockets.py
import asyncio
import logging
import json
import redis # Sync redis for initial job check (optional)
import redis.asyncio as aioredis # Use async redis client for pub/sub and list fetching
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, status

# Import WebSocketState for checking connection status
from starlette.websockets import WebSocketState

from rq.job import Job
from rq.exceptions import NoSuchJobError
from rq import Queue

# Import config and sync redis connection getter
from ..core.redis_rq import get_pipeline_queue, get_redis_connection
from ..core.config import LOG_CHANNEL_PREFIX, REDIS_HOST, REDIS_PORT, REDIS_DB, LOG_HISTORY_PREFIX # Add LOG_HISTORY_PREFIX

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/ws", # Add prefix here
    tags=["WebSocket"]
)

# Simple connection manager (can be expanded)
class ConnectionManager:
    def __init__(self):
        # Store WebSocket connection per job_id
        self.active_connections: dict[str, WebSocket] = {}
        # Store the dedicated Redis client used for pubsub per job_id
        self.pubsub_clients: dict[str, aioredis.Redis] = {}
        # Store the asyncio Task listening to Redis per job_id
        self.listener_tasks: dict[str, asyncio.Task] = {}

    async def connect(self, websocket: WebSocket, job_id: str):
        """Accepts WebSocket, fetches history, creates Redis listener, and starts listening."""
        await websocket.accept()
        self.active_connections[job_id] = websocket
        logger.info(f"WebSocket connected for job {job_id}")

        redis_client = None
        try:
            # Create dedicated async Redis connection for Pub/Sub and List operations
            redis_client = aioredis.Redis(
                host=str(REDIS_HOST), port=int(REDIS_PORT), db=int(REDIS_DB), decode_responses=True
            )
            await redis_client.ping() # Verify connection
            self.pubsub_clients[job_id] = redis_client
            logger.info(f"Async Redis client created and connected for job {job_id}")

            # --- Fetch and send log history ---
            await self.send_history(websocket, job_id, redis_client)
            # --- End history sending ---

            # Start listener task AFTER sending history
            task = asyncio.create_task(self._redis_listener(websocket, job_id))
            self.listener_tasks[job_id] = task
            logger.info(f"Started Redis listener task for job {job_id}")

        except WebSocketDisconnect:
             logger.warning(f"WebSocket disconnected during history sending for job {job_id}. Aborting listener setup.")
             # Clean up potentially created Redis client
             if redis_client: await self._close_redis_client(redis_client, job_id)
             # Ensure connection is removed
             if job_id in self.active_connections: del self.active_connections[job_id]
        except Exception as e:
            logger.error(f"Failed to setup Redis connection/send history for job {job_id}: {e}", exc_info=True)
            # Clean up potentially created Redis client if setup failed
            if redis_client: await self._close_redis_client(redis_client, job_id)
            # Disconnect websocket if setup fails
            await self.disconnect(websocket, job_id, code=status.WS_1011_INTERNAL_ERROR, reason="Redis setup or history send failed")

    async def send_history(self, websocket: WebSocket, job_id: str, redis_client: aioredis.Redis):
        """Fetches log history from Redis List and sends it to the WebSocket."""
        list_key = f"{LOG_HISTORY_PREFIX}{job_id}"
        logger.info(f"Fetching log history from list: {list_key}")
        try:
            # Fetch all items from the list
            history = await redis_client.lrange(list_key, 0, -1)
            logger.info(f"Retrieved {len(history)} historical log lines for job {job_id}.")

            if not history:
                 await websocket.send_text(json.dumps({"type": "status", "line": f"No history found. Listening for live logs..."}))
                 return # No history to send

            await websocket.send_text(json.dumps({"type": "status", "line": f"--- Start of history ({len(history)} lines) ---"}))
            for log_message_json in history:
                # Check connection before each send inside the loop
                if websocket.client_state != WebSocketState.CONNECTED:
                    logger.warning(f"WebSocket disconnected while sending history for job {job_id}.")
                    raise WebSocketDisconnect(code=status.WS_1001_GOING_AWAY, reason="Client disconnected during history send")

                try:
                    # Send the raw JSON string from the list
                    await websocket.send_text(log_message_json)
                    # Slight pause to prevent overwhelming the client buffer? Optional.
                    # await asyncio.sleep(0.001)
                except WebSocketDisconnect:
                     raise # Re-raise to be caught by the outer handler
                except Exception as send_err:
                    logger.error(f"Error sending historical log line to WebSocket for job {job_id}: {send_err}")
                    # Decide whether to continue or break on send error
                    # break

            await websocket.send_text(json.dumps({"type": "status", "line": f"--- End of history. Listening for live logs... ---"}))
            logger.info(f"Finished sending history for job {job_id}")

        except redis.exceptions.RedisError as e:
            logger.error(f"Redis error fetching history for job {job_id} from {list_key}: {e}")
            await websocket.send_text(json.dumps({"type": "error", "line": f"Error fetching log history: {e}"}))
            # Continue to live listening even if history fails? Or disconnect? For now, continue.
        except WebSocketDisconnect:
            raise # Propagate disconnect upwards
        except Exception as e:
            logger.error(f"Unexpected error sending history for job {job_id}: {e}", exc_info=True)
            try:
                 await websocket.send_text(json.dumps({"type": "error", "line": f"Unexpected server error sending history."}))
            except WebSocketDisconnect:
                logger.warning(f"WebSocket disconnected before error could be sent for job {job_id}.")


    async def _close_redis_client(self, redis_client: aioredis.Redis, job_id: str):
        """Safely closes an async Redis client and its pool."""
        if not redis_client: return
        try:
            await redis_client.close()
            # Check if connection_pool exists before trying to disconnect it
            if hasattr(redis_client, 'connection_pool'):
                await redis_client.connection_pool.disconnect()
            logger.info(f"Closed async Redis client for job {job_id}")
        except Exception as e:
            logger.error(f"Error closing Redis client for job {job_id}: {e}", exc_info=True)


    async def disconnect(self, websocket: WebSocket, job_id: str, code: int = status.WS_1000_NORMAL_CLOSURE, reason: str | None = None):
        """Cleans up resources associated with a WebSocket connection."""
        logger.info(f"Disconnecting WebSocket for job {job_id}. Code: {code}, Reason: {reason}")

        # Cancel and cleanup listener task
        task = self.listener_tasks.pop(job_id, None)
        if task and not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout=1.0)
                logger.info(f"Listener task for job {job_id} cancelled.")
            except asyncio.CancelledError: logger.info(f"Listener task for job {job_id} cancellation confirmed.")
            except asyncio.TimeoutError: logger.warning(f"Timeout waiting for listener task cancellation for job {job_id}.")
            except Exception as e: logger.error(f"Error during listener task cancellation for job {job_id}: {e}", exc_info=True)

        # Close Redis client
        redis_client = self.pubsub_clients.pop(job_id, None)
        await self._close_redis_client(redis_client, job_id)

        # Remove active connection reference
        if job_id in self.active_connections: del self.active_connections[job_id]

        # Close WebSocket connection if it's still open
        try:
            if hasattr(websocket, 'client_state') and websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close(code=code, reason=reason)
                logger.info(f"WebSocket for job {job_id} closed from server.")
            elif hasattr(websocket, 'client_state'): logger.info(f"WebSocket for job {job_id} was already in state {websocket.client_state}.")
            else: logger.warning(f"WebSocket object for job {job_id} lacks 'client_state'. Cannot check state.")
        except AttributeError: logger.warning(f"WebSocket object for job {job_id} lacks 'client_state'.")
        except RuntimeError as e: logger.warning(f"RuntimeError closing WebSocket for job {job_id} (likely already closed): {e}")
        except Exception as e: logger.error(f"Error closing WebSocket for job {job_id}: {e}", exc_info=True)

        logger.info(f"WebSocket disconnected cleanup complete for job {job_id}")


    async def _redis_listener(self, websocket: WebSocket, job_id: str):
        """Listens to Redis Pub/Sub and forwards messages to the WebSocket."""
        channel_name = f"{LOG_CHANNEL_PREFIX}{job_id}"
        redis_client = self.pubsub_clients.get(job_id)

        if not redis_client:
            logger.error(f"No Redis client found for job {job_id} in listener task.")
            await self.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Internal error: Redis client missing")
            return

        pubsub = None
        try:
            pubsub = redis_client.pubsub()
            await pubsub.subscribe(channel_name)
            logger.info(f"Subscribed to Redis channel: {channel_name} for live updates.")

            # No initial confirmation message needed here, as history sending handles that

            while True:
                if not hasattr(websocket, 'client_state') or websocket.client_state != WebSocketState.CONNECTED:
                    logger.warning(f"WebSocket for job {job_id} disconnected, stopping listener.")
                    break

                try:
                    message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                except redis.exceptions.ConnectionError as redis_conn_err:
                    logger.error(f"Redis connection error while getting message for {job_id}: {redis_conn_err}")
                    await self.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Redis connection error")
                    break
                except Exception as get_msg_err:
                     logger.error(f"Error getting message from Redis pubsub for {job_id}: {get_msg_err}", exc_info=True)
                     await asyncio.sleep(1) # Wait before retrying
                     continue

                if message:
                    message_data = message['data']
                    if isinstance(message_data, str):
                         try:
                              # Forward the raw JSON string received from Redis Pub/Sub
                              await websocket.send_text(message_data)

                              # Check for control messages like EOF *after* sending
                              try:
                                  log_data = json.loads(message_data)
                                  if log_data.get("type") == "control" and log_data.get("line") == "EOF":
                                       logger.info(f"Received EOF marker via Pub/Sub for job {job_id}. Listener task ending.")
                                       # Don't disconnect here, just stop listening
                                       break # Exit listener loop naturally
                              except Exception: pass # Ignore parsing errors for EOF check

                         except WebSocketDisconnect:
                              logger.warning(f"WebSocket disconnected while trying to send live message for job {job_id}. Listener stopping.")
                              break # Exit loop immediately
                         except Exception as send_err:
                             logger.error(f"Error sending live message to WebSocket for job {job_id}: {send_err}", exc_info=True)
                             await asyncio.sleep(0.1)

        except asyncio.CancelledError:
             logger.info(f"Redis listener task for {job_id} cancelled.")
        except redis.exceptions.ConnectionError as e:
            logger.error(f"Redis connection error in listener setup for job {job_id}: {e}", exc_info=True)
            await self.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Redis connection error")
        except Exception as e:
            logger.exception(f"Unexpected error in Redis listener for job {job_id}: {e}")
            await self.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Listener error")
        finally:
            if pubsub and pubsub.subscribed:
                try:
                    await pubsub.unsubscribe(channel_name)
                    logger.info(f"Unsubscribed from Redis channel: {channel_name}")
                except Exception as e:
                    logger.error(f"Error unsubscribing from {channel_name}: {e}", exc_info=True)


manager = ConnectionManager()


@router.websocket("/logs/{job_id}")
async def websocket_log_endpoint(
    websocket: WebSocket,
    job_id: str,
    # Dependency to check if job exists (using sync connection is OK for this check)
    redis_conn: redis.Redis = Depends(get_redis_connection), # Sync conn for initial check
    queue: Queue = Depends(get_pipeline_queue) # Required by Job.fetch
):
    """Handles WebSocket connections for live job logs."""
    logger.info(f"WebSocket connection request for job ID: {job_id}")

    # 1. Basic Job ID validation
    if not job_id or job_id.startswith("staged_") or job_id == "N/A":
        logger.warning(f"Rejecting WebSocket connection for invalid job ID: {job_id}")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # 2. Optional: Check if job exists or log history list exists
    job_exists_in_rq = False
    log_history_exists = False
    try:
        # Check RQ
        job = Job.fetch(job_id, connection=redis_conn)
        job_exists_in_rq = True
        logger.info(f"Websocket connecting for existing job {job_id} (Status: {job.get_status()})")
    except NoSuchJobError:
        logger.warning(f"Websocket connecting for job {job_id}, but job not found in RQ main queue (may be finished, failed, or never queued).")
    except Exception as e:
        logger.error(f"Error checking RQ job existence for {job_id}: {e}", exc_info=True)

    try:
        # Check if log history list exists (using sync conn is fine for EXISTS)
        list_key = f"{LOG_HISTORY_PREFIX}{job_id}"
        if redis_conn.exists(list_key):
            log_history_exists = True
            logger.info(f"Log history list found for job {job_id}: {list_key}")
        else:
             logger.warning(f"Log history list NOT found for job {job_id}: {list_key}")
    except Exception as e:
         logger.error(f"Error checking log history existence for {job_id}: {e}", exc_info=True)

    # Decide whether to proceed (e.g., require either RQ job or history to exist)
    # if not job_exists_in_rq and not log_history_exists:
    #     logger.error(f"Rejecting WebSocket connection: Neither RQ job nor log history found for job ID: {job_id}")
    #     await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Job or log history not found")
    #     return
    # For now, let's allow connection even if neither is found, it will just show "No history..."

    # 3. Connect the WebSocket using the manager (fetches history, then starts listener)
    await manager.connect(websocket, job_id)

    # 4. Keep the connection alive and detect client disconnect
    try:
        while True:
            # This loop primarily serves to detect disconnection.
            # Log forwarding is handled by the background listener task.
            try:
                data = await websocket.receive_text()
                logger.debug(f"Received text from client {job_id}: {data}")
                # Handle potential client messages if needed (e.g., ping/pong)
                if data.lower() == 'ping': await websocket.send_text('pong')
            except WebSocketDisconnect as e:
                logger.info(f"WebSocket for job {job_id} disconnected by client. Code: {e.code}, Reason: {e.reason}")
                await manager.disconnect(websocket, job_id, e.code, e.reason)
                break # Exit the loop

    except Exception as e:
        # Catch unexpected errors in the main connection loop
        logger.exception(f"Unexpected error in main WebSocket loop for job {job_id}: {e}")
        await manager.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Server error")
