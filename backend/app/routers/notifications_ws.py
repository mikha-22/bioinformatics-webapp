#File: backend/app/routers/notifications_ws.py
import asyncio
import logging
import json
import redis.asyncio as aioredis # Use async redis client
import redis # Import the base redis library for its exceptions
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, status # 'status' here is fine for HTTP status codes
from typing import Set, Optional

# Import WebSocketState for checking connection status
from starlette.websockets import WebSocketState

from ..core.config import REDIS_HOST, REDIS_PORT, REDIS_DB

APP_NOTIFICATIONS_CHANNEL = "app_notifications"

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/ws", 
    tags=["WebSocket Notifications"]
)

class NotificationConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self.redis_client: Optional[aioredis.Redis] = None
        self.pubsub_task: Optional[asyncio.Task] = None
        self.is_redis_listener_running = False

    async def connect_redis(self):
        if self.redis_client:
            try:
                await self.redis_client.ping()
                logger.info("NotificationManager: Reusing existing Redis connection.")
                return True
            except (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError) as e: # Use redis.exceptions
                logger.warning(f"NotificationManager: Existing Redis connection check (ping) failed: {e}. Reconnecting.")
                await self._close_redis_client()
            except Exception as e:
                logger.error(f"NotificationManager: Unexpected error with existing Redis connection: {e}. Reconnecting.")
                await self._close_redis_client()
        
        logger.info("NotificationManager: Establishing new Redis connection for Pub/Sub.")
        try:
            self.redis_client = aioredis.Redis(
                host=str(REDIS_HOST), port=int(REDIS_PORT), db=int(REDIS_DB),
                decode_responses=True,
                health_check_interval=30 
            )
            await self.redis_client.ping()
            logger.info("NotificationManager: Successfully connected to Redis for Pub/Sub.")
            return True
        except Exception as e:
            logger.error(f"NotificationManager: FATAL - Could not connect to Redis for Pub/Sub: {e}", exc_info=True)
            self.redis_client = None
            return False

    async def _close_redis_client(self):
        if self.redis_client:
            logger.info("NotificationManager: Closing existing Redis client.")
            try:
                await self.redis_client.close()
                # For redis-py, pool disconnect is handled by client.close() if pool was managed by it.
                # If you created the pool separately and passed it, you'd manage it separately.
            except Exception as e:
                logger.error(f"NotificationManager: Error closing Redis client: {e}", exc_info=True)
            finally:
                self.redis_client = None

    async def start_redis_listener(self):
        if self.is_redis_listener_running and self.pubsub_task and not self.pubsub_task.done():
            logger.info("NotificationManager: Redis listener task already running.")
            if self.redis_client:
                try:
                    await self.redis_client.ping()
                except (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError, AttributeError): # Use redis.exceptions
                    logger.warning("NotificationManager: Listener was running but Redis connection is dead or client is None. Restarting listener.")
                    await self.stop_redis_listener() # Clean up old state before restarting
                else:
                    return # Listener is running and connection is good
            else: 
                logger.warning("NotificationManager: Listener was marked running but Redis client is None. Restarting listener.")
                await self.stop_redis_listener() # Clean up old state

        if not await self.connect_redis() or not self.redis_client:
            logger.error("NotificationManager: Cannot start Redis listener, Redis connection failed.")
            return

        self.is_redis_listener_running = True
        self.pubsub_task = asyncio.create_task(self._redis_message_listener())
        logger.info("NotificationManager: Redis listener task started.")

    async def stop_redis_listener(self):
        self.is_redis_listener_running = False # Signal the listener loop to stop
        if self.pubsub_task and not self.pubsub_task.done():
            logger.info("NotificationManager: Cancelling Redis listener task.")
            self.pubsub_task.cancel()
            try:
                await asyncio.wait_for(self.pubsub_task, timeout=2.0) # Wait for task to acknowledge cancellation
            except asyncio.CancelledError:
                logger.info("NotificationManager: Redis listener task successfully cancelled.")
            except asyncio.TimeoutError:
                logger.warning("NotificationManager: Timeout waiting for Redis listener task to cancel.")
            except Exception as e:
                logger.error(f"NotificationManager: Error during listener task cancellation: {e}", exc_info=True)
        self.pubsub_task = None
        await self._close_redis_client() # Close Redis connection after listener stops
        logger.info("NotificationManager: Redis listener stopped and connection closed.")

    async def _redis_message_listener(self):
        if not self.redis_client:
            logger.error("NotificationManager: Redis client not available in listener. Aborting listener.")
            self.is_redis_listener_running = False
            return

        pubsub = self.redis_client.pubsub()
        try:
            await pubsub.subscribe(APP_NOTIFICATIONS_CHANNEL)
            logger.info(f"NotificationManager: Subscribed to Redis channel: {APP_NOTIFICATIONS_CHANNEL}")

            while self.is_redis_listener_running: # Loop controlled by the flag
                try:
                    message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                    if message:
                        message_data_str = message['data']
                        logger.info(f"NotificationManager: Received message from Redis: {message_data_str}")
                        await self.broadcast(message_data_str)
                except asyncio.CancelledError:
                    logger.info("NotificationManager: Listener task cancelled during get_message or broadcast.")
                    break # Exit loop if task is cancelled
                except redis.exceptions.ConnectionError as e:
                    logger.error(f"NotificationManager: Redis connection error in listener: {e}. Attempting to reconnect and restart listener...")
                    await self.stop_redis_listener() # Stop current listener, close faulty connection
                    await asyncio.sleep(5) # Wait before retrying
                    await self.start_redis_listener() # Attempt to start a new listener (which will try to reconnect)
                    # If start_redis_listener is successful, it starts a *new* _redis_message_listener.
                    # This current instance of the coroutine should then exit.
                    if self.is_redis_listener_running:
                        logger.info("NotificationManager: New Redis listener instance should be running after connection error recovery.")
                        return # Exit this instance of the listener
                    else:
                        logger.error("NotificationManager: Failed to re-establish Redis listener after connection error. Permanently stopping.")
                        break # Break the loop if restart failed
                except Exception as e:
                    logger.error(f"NotificationManager: Unexpected error in Redis listener loop: {e}", exc_info=True)
                    # Decide if this error is fatal for the listener. For now, continue after a short pause.
                    await asyncio.sleep(1)
        except Exception as e_outer:
             logger.error(f"NotificationManager: Outer exception in _redis_message_listener (e.g., during subscribe): {e_outer}", exc_info=True)
        finally:
            if pubsub and pubsub.subscribed: # Ensure pubsub object exists and is subscribed
                try:
                    await pubsub.unsubscribe(APP_NOTIFICATIONS_CHANNEL)
                    logger.info(f"NotificationManager: Unsubscribed from Redis channel: {APP_NOTIFICATIONS_CHANNEL}")
                except Exception as e_unsub: 
                    logger.error(f"NotificationManager: Error unsubscribing from {APP_NOTIFICATIONS_CHANNEL}: {e_unsub}")
            logger.info("NotificationManager: Redis message listener loop finally ended.")
            # Set is_redis_listener_running to False only if it wasn't a ConnectionError that is trying to restart
            # This logic can be tricky. The primary control should be `self.is_redis_listener_running`.
            # If an unrecoverable error occurs or stop_redis_listener is called, it will be set to False.
            # For now, let the flag handle it, and it will be set False in stop_redis_listener.


    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info(f"Notification WebSocket connected: {websocket.client}. Total: {len(self.active_connections)}")
        # Start listener only if there are active connections and it's not already running
        if not self.is_redis_listener_running and self.active_connections:
            await self.start_redis_listener()

    async def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
             self.active_connections.remove(websocket)
        logger.info(f"Notification WebSocket disconnected: {websocket.client}. Total: {len(self.active_connections)}")
        # Stop listener if no connections are left
        if not self.active_connections and self.is_redis_listener_running:
            logger.info("NotificationManager: No active WebSocket connections. Stopping Redis listener.")
            await self.stop_redis_listener()

    async def broadcast(self, message_json_str: str):
        send_tasks = []
        # Iterate over a copy of the set in case of modification during iteration (though less likely here)
        current_connections = list(self.active_connections) 

        for connection in current_connections:
            if connection.client_state == WebSocketState.CONNECTED:
                send_tasks.append(connection.send_text(message_json_str))
            else:
                logger.warning(f"NotificationManager: Client {connection.client} found in non-connected state ({connection.client_state}) during broadcast. Will attempt to remove.")
                # Schedule for removal after broadcast attempts
                if connection in self.active_connections: # Check if still in set before removing
                     self.active_connections.remove(connection)
                     logger.info(f"NotificationManager: Removed stale client {connection.client} from active connections due to bad state.")


        if send_tasks:
            results = await asyncio.gather(*send_tasks, return_exceptions=True)
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    # Identify the connection that failed if possible (tricky with gather)
                    # For now, just log the error. The disconnect might be caught by the main loop.
                    logger.error(f"NotificationManager: Error broadcasting message to a client (client may have disconnected): {result}")
                    # Potentially remove the client that caused this error if it can be identified
                    # and is still in active_connections.
        
        # Check again if active connections dropped to zero and listener should be stopped
        if not self.active_connections and self.is_redis_listener_running:
            logger.info("NotificationManager: No active WebSocket connections after broadcast completion. Stopping Redis listener.")
            await self.stop_redis_listener()

manager = NotificationConnectionManager()

@router.on_event("startup")
async def startup_event():
    logger.info("Notification WebSocket router startup: Manager initialized.")
    # Consider if listener should start here by default or only on first client connection.
    # Current logic: starts on first client connection.

@router.on_event("shutdown")
async def shutdown_event():
    logger.info("Notification WebSocket router shutdown: Stopping Redis listener and closing connections.")
    await manager.stop_redis_listener() # This will also close the redis_client
    # Close all active WebSocket connections gracefully
    active_websockets_copy = list(manager.active_connections) # Iterate over a copy
    for websocket in active_websockets_copy:
        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close(code=status.WS_1001_GOING_AWAY)
        except Exception as e: 
            logger.warning(f"Error closing websocket {websocket.client} during shutdown: {e}")
    manager.active_connections.clear()
    logger.info("Notification WebSocket router shutdown complete.")

@router.websocket("/app_notifications")
async def websocket_notification_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # This loop keeps the connection alive.
            # It can also handle messages sent from the client to the server if needed.
            data = await websocket.receive_text()
            logger.debug(f"Notification WebSocket (from client {websocket.client}): {data}")
            if data.lower() == "ping":
                await websocket.send_text("pong")
            # Add other client message handling here if necessary.
    except WebSocketDisconnect:
        logger.info(f"Notification WebSocket client disconnected: {websocket.client}")
    except Exception as e:
        # Log other exceptions that might occur in this endpoint.
        logger.error(f"Unexpected error in notification WebSocket endpoint for {websocket.client}: {e}", exc_info=True)
    finally:
        # Ensure the manager properly cleans up the connection.
        await manager.disconnect(websocket)
