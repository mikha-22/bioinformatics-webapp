#!/bin/bash

# Exit immediately if a command exits with a non-zero status during setup.

# --- Configuration ---
REDIS_CONTAINER_NAME="bio_redis_local"
FILEBROWSER_CONTAINER_NAME="bio_filebrowser_local"
FRONTEND_DIR="frontend_app"
FRONTEND_ENV_FILE="$FRONTEND_DIR/.env.local"
REDIS_URL="redis://localhost:6379/0"
QUEUE_NAME="pipeline_tasks"
TLS_DIR="./tls"
TLS_KEY="$TLS_DIR/server.key"
TLS_CERT="$TLS_DIR/server.crt"
LOGS_DIR="./logs_dev"

# --- Content for .env.local ---
read -r -d '' FRONTEND_ENV_CONTENT << EOM
NEXT_PUBLIC_API_BASE_URL=https://localhost:8000
NEXT_PUBLIC_FILEBROWSER_URL=https://localhost:8081
EOM

# --- PIDs Storage ---
BACKEND_PID_FILE="$LOGS_DIR/backend.pid"
WORKER_PID_FILE="$LOGS_DIR/worker.pid"
FRONTEND_PID_FILE="$LOGS_DIR/frontend.pid"
TAIL_PID_FILE="$LOGS_DIR/tail.pid"

# --- Functions ---
log_info() {
  echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_warn() {
  echo "[WARN] $(date '+%Y-%m-%d %H:%M:%S') - $1" >&2
}

log_error() {
  echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') - $1" >&2
  exit 1
}

kill_pid_file() {
  local pid_file="$1"
  local process_name="$2"
  if [ -f "$pid_file" ]; then
    local pid=$(cat "$pid_file")
    if [ -n "$pid" ] && ps -p "$pid" > /dev/null; then
      log_info "Stopping $process_name (PID: $pid)..."
      kill -TERM "$pid" 2>/dev/null
      sleep 1
      if ps -p "$pid" > /dev/null; then
        log_warn "$process_name (PID: $pid) did not stop gracefully, sending KILL signal..."
        kill -KILL "$pid" 2>/dev/null
      fi
      rm "$pid_file"
    else
      if [ -n "$pid" ]; then
          log_info "$process_name PID ($pid from file) not found or already stopped."
      else
          log_info "$process_name PID file was empty."
      fi
      rm "$pid_file"
    fi
  fi
}

cleanup() {
  log_info "--- Initiating Cleanup ---"
  kill_pid_file "$TAIL_PID_FILE" "Log Tail Process"
  kill_pid_file "$FRONTEND_PID_FILE" "Frontend (npm run dev)"
  kill_pid_file "$WORKER_PID_FILE" "RQ Worker"
  kill_pid_file "$BACKEND_PID_FILE" "Backend (python main.py)"
  log_info "--- Cleanup Finished ---"
  exit 0
}

trap cleanup INT TERM

# --- Main Script ---
log_info "Starting Development Environment..."
PROJECT_ROOT=$(pwd)

mkdir -p "$LOGS_DIR"
log_info "Log files will be stored in '$LOGS_DIR/'"

# 1. Start Docker Containers
log_info "Attempting to start Redis container ($REDIS_CONTAINER_NAME)..."
if ! docker start "$REDIS_CONTAINER_NAME" > /dev/null 2>&1; then
    log_warn "Failed to start $REDIS_CONTAINER_NAME. Check if container exists ('docker ps -a') and Docker is running."
else
    sleep 2
    if ! docker ps -q --filter "name=^/${REDIS_CONTAINER_NAME}$" --filter "status=running" | grep -q .; then
        log_warn "$REDIS_CONTAINER_NAME is not running after start attempt. Check 'docker logs $REDIS_CONTAINER_NAME'."
    else
        log_info "$REDIS_CONTAINER_NAME started successfully."
    fi
fi

log_info "Attempting to start FileBrowser container ($FILEBROWSER_CONTAINER_NAME)..."
if ! docker start "$FILEBROWSER_CONTAINER_NAME" > /dev/null 2>&1; then
    log_warn "Failed to start $FILEBROWSER_CONTAINER_NAME. Check if container exists ('docker ps -a') and Docker is running."
else
    sleep 2
    if ! docker ps -q --filter "name=^/${FILEBROWSER_CONTAINER_NAME}$" --filter "status=running" | grep -q .; then
        log_warn "$FILEBROWSER_CONTAINER_NAME is not running after start attempt. Check 'docker logs $FILEBROWSER_CONTAINER_NAME'."
    else
        log_info "$FILEBROWSER_CONTAINER_NAME started successfully."
    fi
fi

# 2. Ensure TLS Certificate and Key exist
log_info "Checking TLS certificate and key in '$TLS_DIR'..."
if [ -f "$TLS_KEY" ] && [ -f "$TLS_CERT" ]; then
    log_info "TLS key and certificate found."
else
    if [ -e "$TLS_KEY" ] || [ -e "$TLS_CERT" ]; then
        log_warn "'$TLS_KEY' or '$TLS_CERT' exists but is not a regular file (or one is missing). Regenerating..."
    else
         log_warn "TLS key or certificate not found. Generating..."
    fi
    log_info "Attempting to remove existing '$TLS_DIR' (if any) using sudo..."
    sudo rm -rf "$TLS_DIR" || log_warn "Could not remove existing '$TLS_DIR' with sudo."
    log_info "Creating new '$TLS_DIR' directory..."
    mkdir -p "$TLS_DIR" || log_error "Failed to create '$TLS_DIR'."
    log_info "Generating self-signed TLS certificate and key..."
    openssl req -x509 -newkey rsa:4096 \
            -keyout "$TLS_KEY" \
            -out "$TLS_CERT" \
            -sha256 -days 365 -nodes \
            -subj "/CN=localhost" || log_error "Failed to generate TLS certificate/key."
    log_info "TLS certificate and key generated successfully in '$TLS_DIR'."
    sudo chown "$(id -u):$(id -g)" "$TLS_KEY" "$TLS_CERT"
fi

set +e

# 3. Start Backend (in background, redirect logs)
log_info "Starting FastAPI backend -> $LOGS_DIR/backend.log"
python -u main.py > "$LOGS_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo $BACKEND_PID > "$BACKEND_PID_FILE"
sleep 3
if ! ps -p $BACKEND_PID > /dev/null; then
    log_error "Backend process (PID: $BACKEND_PID stored in $BACKEND_PID_FILE) failed to start or crashed immediately. Check '$LOGS_DIR/backend.log'."
elif ! curl --output /dev/null --silent --head --fail -k https://localhost:8000/health; then
    log_warn "Backend process started (PID: $BACKEND_PID) but health check failed. It might still be initializing or encountered an error. Check '$LOGS_DIR/backend.log'."
else
    log_info "Backend started (PID: $BACKEND_PID) and responding to health check."
fi

# 4. Start RQ Worker (in background, redirect logs)
log_info "Starting RQ worker -> $LOGS_DIR/worker.log"
export PYTHONPATH="$PROJECT_ROOT"
rq worker "$QUEUE_NAME" --url "$REDIS_URL" > "$LOGS_DIR/worker.log" 2>&1 &
WORKER_PID=$!
echo $WORKER_PID > "$WORKER_PID_FILE"
sleep 2
if ! ps -p $WORKER_PID > /dev/null; then
    log_error "RQ Worker process (PID: $WORKER_PID stored in $WORKER_PID_FILE) failed to start or crashed immediately. Check '$LOGS_DIR/worker.log'."
else
    if grep -q -E "Listening on|Registering birth" "$LOGS_DIR/worker.log"; then
        log_info "RQ Worker started (PID: $WORKER_PID) and appears to be listening."
    else
        log_warn "RQ Worker process started (PID: $WORKER_PID) but expected startup message not found in log yet. Check '$LOGS_DIR/worker.log'."
    fi
fi

# 5. Ensure Frontend .env.local exists
log_info "Checking Frontend .env.local file at '$FRONTEND_ENV_FILE'..."
if [ -f "$FRONTEND_ENV_FILE" ]; then
    log_info "'$FRONTEND_ENV_FILE' already exists."
else
    if [ -d "$FRONTEND_DIR" ]; then
        log_warn "'$FRONTEND_ENV_FILE' not found. Creating it..."
        printf "%s\n" "$FRONTEND_ENV_CONTENT" > "$FRONTEND_ENV_FILE" || log_error "Failed to create '$FRONTEND_ENV_FILE'."
        log_info "'$FRONTEND_ENV_FILE' created successfully."
    else
        log_warn "Frontend directory '$FRONTEND_DIR' not found. Cannot create '$FRONTEND_ENV_FILE'."
    fi
fi

# 6. Start Frontend (in background, redirect logs)
FRONTEND_NPM_PID=""
if [ -d "$FRONTEND_DIR" ]; then
  log_info "Starting Frontend dev server -> $LOGS_DIR/frontend.log"
  cd "$FRONTEND_DIR"
  npm run dev > "../$LOGS_DIR/frontend.log" 2>&1 &
  FRONTEND_NPM_PID=$!
  echo $FRONTEND_NPM_PID > "../$FRONTEND_PID_FILE"
  cd "$PROJECT_ROOT"
  sleep 5
  if ! ps -p $FRONTEND_NPM_PID > /dev/null; then
      log_error "Frontend process (PID: $FRONTEND_NPM_PID stored in $FRONTEND_PID_FILE) failed to start or crashed immediately. Check '$LOGS_DIR/frontend.log'."
  elif ! curl --output /dev/null --silent --head --fail http://localhost:3000; then
      log_warn "Frontend process started (PID: $FRONTEND_NPM_PID) but failed to respond at http://localhost:3000. Check '$LOGS_DIR/frontend.log'."
  else
      log_info "Frontend started (PID: $FRONTEND_NPM_PID) and responding."
  fi
else
  log_warn "Frontend directory '$FRONTEND_DIR' not found. Skipping frontend start."
fi

log_info "--------------------------------------"
log_info "Development environment startup sequence complete."
log_info "Tailing logs from '$LOGS_DIR/'. Press Ctrl+C to stop all components."
log_info "Access Services:"
log_info "  - Backend API: https://localhost:8000/health"
log_info "  - Frontend UI: http://localhost:3000"
log_info "  - FileBrowser: https://localhost:8081"
log_info "--------------------------------------"

touch "$LOGS_DIR/backend.log" "$LOGS_DIR/worker.log" "$LOGS_DIR/frontend.log" 2>/dev/null || true
tail -f "$LOGS_DIR"/*.log &
TAIL_PID=$!
echo $TAIL_PID > "$TAIL_PID_FILE"

wait $TAIL_PID

log_warn "Log tailing process ended unexpectedly. Cleaning up..."
cleanup
