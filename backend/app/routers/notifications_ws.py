# backend/app/routers/notifications_ws.py
import asyncio
import logging
import json
import redis.asyncio as aioredis # Use async redis client
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, status
from typing import Set, Optional # Added Optional

from ..core.config import REDIS_HOST, REDIS_PORT, REDIS_DB

# The channel name should match the one used in tasks.py
APP_NOTIFICATIONS_CHANNEL = "app_notifications"

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/ws", # Consistent prefix with other WebSockets
    tags=["WebSocket Notifications"]
)

class NotificationConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self.redis_client: Optional[aioredis.Redis] = None
        self.pubsub_task: Optional[asyncio.Task] = None
        self.is_redis_listener_running = False

    async def connect_redis(self):
        if self.redis_client and self.redis_client.closed == False:
            try:
                await self.redis_client.ping()
                logger.info("NotificationManager: Reusing existing Redis connection.")
                return True
            except (aioredis.exceptions.ConnectionError, aioredis.exceptions.TimeoutError) as e:
                logger.warning(f"NotificationManager: Existing Redis connection check failed: {e}. Reconnecting.")
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
            except Exception as e:
                logger.error(f"NotificationManager: Error closing Redis client: {e}", exc_info=True)
            finally:
                self.redis_client = None

    async def start_redis_listener(self):
        if self.is_redis_listener_running and self.pubsub_task and not self.pubsub_task.done():
            logger.info("NotificationManager: Redis listener task already running.")
            return

        if not await self.connect_redis() or not self.redis_client:
            logger.error("NotificationManager: Cannot start Redis listener, Redis connection failed.")
            return

        self.is_redis_listener_running = True
        self.pubsub_task = asyncio.create_task(self._redis_message_listener())
        logger.info("NotificationManager: Redis listener task started.")

    async def stop_redis_listener(self):
        self.is_redis_listener_running = False
        if self.pubsub_task and not self.pubsub_task.done():
            logger.info("NotificationManager: Cancelling Redis listener task.")
            self.pubsub_task.cancel()
            try:
                await asyncio.wait_for(self.pubsub_task, timeout=2.0)
            except asyncio.CancelledError:
                logger.info("NotificationManager: Redis listener task successfully cancelled.")
            except asyncio.TimeoutError:
                logger.warning("NotificationManager: Timeout waiting for Redis listener task to cancel.")
            except Exception as e:
                logger.error(f"NotificationManager: Error during listener task cancellation: {e}", exc_info=True)
        self.pubsub_task = None
        await self._close_redis_client()
        logger.info("NotificationManager: Redis listener stopped and connection closed.")

    async def _redis_message_listener(self):
        if not self.redis_client:
            logger.error("NotificationManager: Redis client not available in listener.")
            self.is_redis_listener_running = False
            return

        pubsub = self.redis_client.pubsub()
        try:
            await pubsub.subscribe(APP_NOTIFICATIONS_CHANNEL)
            logger.info(f"NotificationManager: Subscribed to Redis channel: {APP_NOTIFICATIONS_CHANNEL}")

            while self.is_redis_listener_running:
                try:
                    message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                    if message:
                        message_data_str = message['data']
                        logger.info(f"NotificationManager: Received message from Redis: {message_data_str}")
                        await self.broadcast(message_data_str)
                except asyncio.CancelledError:
                    logger.info("NotificationManager: Listener task cancelled.")
                    break
                except aioredis.exceptions.ConnectionError as e:
                    logger.error(f"NotificationManager: Redis connection error in listener: {e}. Attempting to reconnect...")
                    await self.stop_redis_listener()
                    await asyncio.sleep(5)
                    await self.start_redis_listener()
                    if self.is_redis_listener_running:
                        logger.info("NotificationManager: Re-established Redis listener after connection error.")
                        return # Exit this instance, new one is running
                    else:
                        logger.error("NotificationManager: Failed to re-establish Redis listener. Stopping.")
                        break
                except Exception as e:
                    logger.error(f"NotificationManager: Unexpected error in Redis listener: {e}", exc_info=True)
                    await asyncio.sleep(1)
        finally:
            if pubsub and pubsub.subscribed: # Check if pubsub was initialized and subscribed
                try:
                    await pubsub.unsubscribe(APP_NOTIFICATIONS_CHANNEL)
                    logger.info(f"NotificationManager: Unsubscribed from Redis channel: {APP_NOTIFICATIONS_CHANNEL}")
                except Exception as e: # <<< --- CORRECTED SYNTAX ---
                    logger.error(f"NotificationManager: Error unsubscribing: {e}")
            logger.info("NotificationManager: Redis message listener loop ended.")
            self.is_redis_listener_running = False

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info(f"Notification WebSocket connected: {websocket.client}. Total: {len(self.active_connections)}")
        if not self.is_redis_listener_running and self.active_connections:
            await self.start_redis_listener()

    async def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
             self.active_connections.remove(websocket)
        logger.info(f"Notification WebSocket disconnected: {websocket.client}. Total: {len(self.active_connections)}")
        if not self.active_connections and self.is_redis_listener_running:
            logger.info("NotificationManager: No active WebSocket connections. Stopping Redis listener.")
            await self.stop_redis_listener()

    async def broadcast(self, message_json_str: str):
        send_tasks = []
        disconnected_clients: Set[WebSocket] = set()

        for connection in self.active_connections:
            if connection.client_state == status.WS_STATE_CONNECTED: # Use WS_STATE_CONNECTED from starlette
                send_tasks.append(connection.send_text(message_json_str))
            else:
                logger.warning(f"NotificationManager: Client {connection.client} found disconnected during broadcast prep.")
                disconnected_clients.add(connection)

        if send_tasks:
            results = await asyncio.gather(*send_tasks, return_exceptions=True)
            # Basic error logging for failed sends
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    # This is a simplified error handling. For specific client, more complex tracking is needed.
                    logger.error(f"NotificationManager: Error broadcasting message to a client: {result}")
        
        for client in disconnected_clients:
            if client in self.active_connections:
                 self.active_connections.remove(client)
                 logger.info(f"NotificationManager: Removed stale client {client.client} from active connections.")
        
        if not self.active_connections and self.is_redis_listener_running:
            logger.info("NotificationManager: No active WebSocket connections after broadcast. Stopping Redis listener.")
            await self.stop_redis_listener()

manager = NotificationConnectionManager()

@router.on_event("startup")
async def startup_event():
    logger.info("Notification WebSocket router startup: Manager initialized.")

@router.on_event("shutdown")
async def shutdown_event():
    logger.info("Notification WebSocket router shutdown: Stopping Redis listener and closing connections.")
    await manager.stop_redis_listener()
    for websocket in list(manager.active_connections):
        try:
            await websocket.close(code=status.WS_1001_GOING_AWAY)
        except Exception as e: # <<< --- CORRECTED SYNTAX & ADDED LOGGING ---
            logger.warning(f"Error closing websocket {websocket.client} during shutdown: {e}")
            pass
    manager.active_connections.clear()
    logger.info("Notification WebSocket router shutdown complete.")

@router.websocket("/app_notifications")
async def websocket_notification_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            logger.debug(f"Notification WebSocket received from {websocket.client}: {data}")
            if data.lower() == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        logger.info(f"Notification WebSocket client disconnected: {websocket.client}")
    except Exception as e:
        logger.error(f"Unexpected error in notification WebSocket endpoint for {websocket.client}: {e}", exc_info=True)
    finally:
        await manager.disconnect(websocket)
