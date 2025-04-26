# backend/app/routers/websockets.py
import asyncio
import logging
import json
import redis # <--- ADD THIS IMPORT
import redis.asyncio as aioredis # Use async redis client
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, status

# Import WebSocketState for checking connection status
from starlette.websockets import WebSocketState # <--- Ensure this import is present

from rq.job import Job
from rq.exceptions import NoSuchJobError
from rq import Queue

from ..core.redis_rq import get_pipeline_queue, get_redis_connection # Sync connection for initial check
from ..core.config import LOG_CHANNEL_PREFIX, REDIS_HOST, REDIS_PORT, REDIS_DB

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
        """Accepts WebSocket connection, creates Redis listener, and starts listening."""
        await websocket.accept()
        self.active_connections[job_id] = websocket
        logger.info(f"WebSocket connected for job {job_id}")

        # Create dedicated async Redis connection for Pub/Sub
        redis_client = None
        try:
            # Ensure correct types for Redis connection params
            redis_client = aioredis.Redis(
                host=str(REDIS_HOST), port=int(REDIS_PORT), db=int(REDIS_DB), decode_responses=True
            )
            await redis_client.ping() # Verify connection
            self.pubsub_clients[job_id] = redis_client
            logger.info(f"Async Redis client created and connected for job {job_id}")

            # Start listener task
            task = asyncio.create_task(self._redis_listener(websocket, job_id))
            self.listener_tasks[job_id] = task
            logger.info(f"Started Redis listener task for job {job_id}")

        except Exception as e:
            logger.error(f"Failed to setup Redis listener for job {job_id}: {e}", exc_info=True)
            # Clean up potentially created Redis client if listener setup failed
            if redis_client:
                try:
                    await redis_client.close()
                    # Check if connection_pool exists before trying to disconnect it
                    if hasattr(redis_client, 'connection_pool'):
                        await redis_client.connection_pool.disconnect()
                except Exception as close_err:
                     logger.error(f"Error closing redis client during connect failure for {job_id}: {close_err}")

            # Disconnect websocket if setup fails
            await self.disconnect(websocket, job_id, code=status.WS_1011_INTERNAL_ERROR, reason="Redis setup failed")


    async def disconnect(self, websocket: WebSocket, job_id: str, code: int = status.WS_1000_NORMAL_CLOSURE, reason: str | None = None):
        """Cleans up resources associated with a WebSocket connection."""
        logger.info(f"Disconnecting WebSocket for job {job_id}. Code: {code}, Reason: {reason}")

        # Cancel and cleanup listener task
        task = self.listener_tasks.pop(job_id, None)
        if task and not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout=1.0) # Wait briefly for cancellation
                logger.info(f"Listener task for job {job_id} cancelled.")
            except asyncio.CancelledError:
                logger.info(f"Listener task for job {job_id} cancellation confirmed.")
            except asyncio.TimeoutError:
                 logger.warning(f"Timeout waiting for listener task cancellation for job {job_id}.")
            except Exception as e:
                 logger.error(f"Error during listener task cancellation for job {job_id}: {e}", exc_info=True)

        # Close Redis client
        redis_client = self.pubsub_clients.pop(job_id, None)
        if redis_client:
            try:
                # Check if pool exists before disconnecting
                if hasattr(redis_client, 'connection_pool'):
                    await redis_client.close()
                    await redis_client.connection_pool.disconnect()
                else:
                    await redis_client.close() # Fallback for older versions or different setups
                logger.info(f"Closed async Redis client for job {job_id}")
            except Exception as e:
                logger.error(f"Error closing Redis client for job {job_id}: {e}", exc_info=True)

        # Remove active connection reference
        if job_id in self.active_connections:
             del self.active_connections[job_id]

        # Close WebSocket connection if it's still open
        try:
            # Check state before attempting close
            if hasattr(websocket, 'client_state') and websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close(code=code, reason=reason)
                logger.info(f"WebSocket for job {job_id} closed from server.")
            elif hasattr(websocket, 'client_state'): # Check if attribute exists before accessing
                 logger.info(f"WebSocket for job {job_id} was already closed or in state {websocket.client_state}.")
            else:
                 logger.warning(f"WebSocket object for job {job_id} does not have 'client_state'. Cannot determine state before closing.")
                 # Optionally try closing anyway, or just log
                 # await websocket.close(code=code, reason=reason)
        except AttributeError:
             logger.warning(f"WebSocket object for job {job_id} lacks 'client_state'. Assuming closed or unable to check.")
        except RuntimeError as e:
            # Handles cases like trying to close an already closed socket
            logger.warning(f"RuntimeError closing WebSocket for job {job_id} (likely already closed): {e}")
        except Exception as e:
            logger.error(f"Error closing WebSocket for job {job_id}: {e}", exc_info=True)

        logger.info(f"WebSocket disconnected cleanup complete for job {job_id}")


    async def _redis_listener(self, websocket: WebSocket, job_id: str):
        """Listens to Redis Pub/Sub and forwards messages to the WebSocket."""
        channel_name = f"{LOG_CHANNEL_PREFIX}{job_id}"
        redis_client = self.pubsub_clients.get(job_id)

        if not redis_client:
            logger.error(f"No Redis client found for job {job_id} in listener task.")
            # Attempt disconnect even if client is missing from dict
            await self.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Internal error: Redis client missing")
            return

        pubsub = None # Initialize pubsub to None
        try:
            pubsub = redis_client.pubsub() # Assign here
            await pubsub.subscribe(channel_name)
            logger.info(f"Subscribed to Redis channel: {channel_name}")

            # Send initial confirmation message
            try:
                await websocket.send_text(json.dumps({"type": "status", "line": f"Listening for logs..."}))
            except WebSocketDisconnect:
                logger.warning(f"WebSocket for job {job_id} disconnected before initial status message could be sent.")
                return # Exit if disconnected immediately
            except Exception as send_err:
                logger.error(f"Failed to send initial status message for job {job_id}: {send_err}")
                # Consider disconnecting if initial send fails
                await self.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Failed initial send")
                return

            while True:
                # Check websocket state before waiting for message
                 # Use the correct way to check WebSocket state
                if not hasattr(websocket, 'client_state') or websocket.client_state != WebSocketState.CONNECTED:
                    logger.warning(f"WebSocket for job {job_id} disconnected, stopping listener.")
                    break

                # Wait for a message with timeout
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
                    # logger.debug(f"Received message from {channel_name}: {message}")
                    message_data = message['data']
                    if isinstance(message_data, str):
                         try:
                              # Forward the raw JSON string received from Redis
                              await websocket.send_text(message_data)

                              # Check for control messages like EOF *after* sending
                              try:
                                  log_data = json.loads(message_data)
                                  if log_data.get("type") == "control" and log_data.get("line") == "EOF":
                                       logger.info(f"Received EOF marker for job {job_id}. Listener task ending.")
                                       # Don't disconnect here, let the main loop or client handle closure
                                       break # Exit listener loop naturally
                              except json.JSONDecodeError:
                                   # This is normal if the message wasn't the JSON control message
                                   pass
                              except Exception as parse_err:
                                    logger.warning(f"Could not parse message data as JSON for EOF check: {message_data}, Error: {parse_err}")


                         except WebSocketDisconnect:
                              logger.warning(f"WebSocket disconnected while trying to send message for job {job_id}. Listener stopping.")
                              break # Exit loop immediately
                         except Exception as send_err:
                             logger.error(f"Error sending message to WebSocket for job {job_id}: {send_err}", exc_info=True)
                             # Optional: break loop on send error, or add retry logic
                             await asyncio.sleep(0.1)

        except asyncio.CancelledError:
             logger.info(f"Redis listener task for {job_id} cancelled.")
             # Do not re-raise, let disconnect handle cleanup
        except redis.exceptions.ConnectionError as e:
            logger.error(f"Redis connection error in listener setup for job {job_id}: {e}", exc_info=True)
            await self.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Redis connection error")
        except Exception as e:
            logger.exception(f"Unexpected error in Redis listener for job {job_id}: {e}")
            await self.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Listener error")
        finally:
             # Ensure unsubscribe happens only if pubsub was successfully created
            if pubsub:
                try:
                    if pubsub.subscribed:
                        await pubsub.unsubscribe(channel_name)
                        logger.info(f"Unsubscribed from Redis channel: {channel_name}")
                except Exception as e:
                    logger.error(f"Error unsubscribing from {channel_name}: {e}", exc_info=True)


manager = ConnectionManager()


@router.websocket("/logs/{job_id}") # Removed /api/ws prefix as it's added in app.py
async def websocket_log_endpoint(
    websocket: WebSocket,
    job_id: str,
    # Dependency to check if job exists (using sync connection is OK for this check)
    redis_conn: redis.Redis = Depends(get_redis_connection), # Sync conn for initial check
    queue: Queue = Depends(get_pipeline_queue) # Required by Job.fetch
):
    """Handles WebSocket connections for live job logs."""
    logger.info(f"WebSocket connection request for job ID: {job_id}")
    # 1. Basic Job ID validation (optional, can connect anyway)
    if not job_id or job_id.startswith("staged_") or job_id == "N/A":
        logger.warning(f"Rejecting WebSocket connection for invalid job ID: {job_id}")
        # Use await websocket.close() for FastAPI websockets
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION) # Removed reason for simplicity
        return

    # Optional: Check if job exists (using sync connection is okay here)
    try:
        job = Job.fetch(job_id, connection=redis_conn)
        logger.info(f"Websocket connecting for existing job {job_id} (Status: {job.get_status()})")
    except NoSuchJobError:
        logger.warning(f"Websocket connecting for job {job_id}, but job not found in RQ main queue (may be finished, failed, or not yet queued).")
    except Exception as e:
        logger.error(f"Error checking job existence for {job_id} before WS connect: {e}", exc_info=True)
        # Allow connection despite check error

    # 2. Connect the WebSocket using the manager
    await manager.connect(websocket, job_id)

    # 3. Keep the connection alive and detect client disconnect
    try:
        while True:
            # Wait for client messages (e.g., ping, close request)
            # This loop primarily serves to detect disconnection.
            # Log forwarding is handled by the background listener task.
            # Use receive_text() for FastAPI websockets
            try:
                data = await websocket.receive_text()
                logger.debug(f"Received text from client {job_id}: {data}")
                # Example: Handle a custom 'closeme' message from client
                if data.lower() == 'closeme':
                     logger.info(f"Client {job_id} requested WebSocket close.")
                     await manager.disconnect(websocket, job_id, status.WS_1000_NORMAL_CLOSURE, "Client requested close")
                     break # Exit the loop
            except WebSocketDisconnect as e:
                # This is the expected way to detect client-side disconnect
                logger.info(f"WebSocket for job {job_id} disconnected by client. Code: {e.code}, Reason: {e.reason}")
                # Ensure manager cleanup is called
                await manager.disconnect(websocket, job_id, e.code, e.reason)
                break # Exit the loop

    except Exception as e:
        # Catch unexpected errors in the main connection loop
        logger.exception(f"Unexpected error in main WebSocket loop for job {job_id}: {e}")
        await manager.disconnect(websocket, job_id, status.WS_1011_INTERNAL_ERROR, "Server error")
