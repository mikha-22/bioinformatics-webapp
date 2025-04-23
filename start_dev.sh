#!/bin/bash

# Exit immediately if a command exits with a non-zero status during setup.
# set -e # Commented out to allow checks after commands

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
FRONTEND_HTTPS_PORT="3001" # Port for HTTPS frontend proxy
FRONTEND_HTTP_PORT="3000" # Original next dev port

# --- Content for frontend .env.local ---
# Defines the environment variables needed by the Next.js app
# NEXT_PUBLIC_API_BASE_URL points to the backend server (HTTPS)
# NEXT_PUBLIC_FILEBROWSER_URL points to the file browser server (HTTPS)
read -r -d '' FRONTEND_ENV_CONTENT << EOM
NEXT_PUBLIC_API_BASE_URL=https://localhost:8000
NEXT_PUBLIC_FILEBROWSER_URL=https://localhost:8081
EOM

# --- PIDs Storage ---
BACKEND_PID_FILE="$LOGS_DIR/backend.pid"
WORKER_PID_FILE="$LOGS_DIR/worker.pid"
FRONTEND_PID_FILE="$LOGS_DIR/frontend.pid"
PROXY_PID_FILE="$LOGS_DIR/proxy.pid" # PID file for the proxy
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
  # Attempt cleanup before exiting on error
  cleanup_on_error
  exit 1
}

# Function specifically for cleanup on script error
cleanup_on_error() {
  log_warn "--- Error detected, initiating cleanup ---"
  kill_pid_file "$TAIL_PID_FILE" "Log Tail Process"
  kill_pid_file "$PROXY_PID_FILE" "Frontend HTTPS Proxy" # <<< Kill proxy
  kill_pid_file "$FRONTEND_PID_FILE" "Frontend (npm run dev)"
  kill_pid_file "$WORKER_PID_FILE" "RQ Worker"
  kill_pid_file "$BACKEND_PID_FILE" "Backend (python main.py)"
  log_warn "--- Cleanup due to error finished ---"
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
      rm "$pid_file" # Remove empty or stale pid file
    fi
  elif [ -e "$pid_file" ]; then
     # File exists but is empty or unreadable?
     log_warn "PID file '$pid_file' for $process_name exists but could not read PID or process already stopped. Removing file."
     rm "$pid_file"
  # else
  #   log_info "PID file '$pid_file' for $process_name not found." # Optional: Log if file doesn't exist at all
  fi
}

cleanup() {
  log_info "--- Initiating Cleanup (SIGINT/SIGTERM received) ---"
  kill_pid_file "$TAIL_PID_FILE" "Log Tail Process"
  kill_pid_file "$PROXY_PID_FILE" "Frontend HTTPS Proxy" # <<< Kill proxy
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
# (Keep Docker start logic as is)
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
# (Keep TLS generation logic as is)
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
    sudo chown "$(id -u):$(id -g)" "$TLS_KEY" "$TLS_CERT" || log_warn "Failed to chown TLS files. Check sudo permissions."
fi


# Allow commands to fail without exiting the whole script from here on
set +e

# 3. Start Backend (in background, redirect logs)
# (Keep backend start logic as is)
log_info "Starting FastAPI backend -> $LOGS_DIR/backend.log"
python -u main.py > "$LOGS_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo $BACKEND_PID > "$BACKEND_PID_FILE"
sleep 3 # Give backend a moment to start

# Check if the backend process started successfully
if ! ps -p $BACKEND_PID > /dev/null; then
    log_error "Backend process (PID: $BACKEND_PID stored in $BACKEND_PID_FILE) failed to start or crashed immediately. Check '$LOGS_DIR/backend.log'."
else
    # Removed health check - just confirm process started
    log_info "Backend process started (PID: $BACKEND_PID). Verify functionality by checking '$LOGS_DIR/backend.log' or accessing API endpoints (e.g., /docs)."
fi


# 4. Start RQ Worker (in background, redirect logs)
# (Keep worker start logic as is)
log_info "Starting RQ worker -> $LOGS_DIR/worker.log"
export PYTHONPATH="$PROJECT_ROOT" # Ensure tasks.py can be found
rq worker "$QUEUE_NAME" --url "$REDIS_URL" > "$LOGS_DIR/worker.log" 2>&1 &
WORKER_PID=$!
echo $WORKER_PID > "$WORKER_PID_FILE"
sleep 2
if ! ps -p $WORKER_PID > /dev/null; then
    log_error "RQ Worker process (PID: $WORKER_PID stored in $WORKER_PID_FILE) failed to start or crashed immediately. Check '$LOGS_DIR/worker.log'."
else
    # Check if the worker log contains startup messages indicating it's listening
    if grep -q -E "Listening on|Registering birth|RQ Worker started" "$LOGS_DIR/worker.log" 2>/dev/null; then
        log_info "RQ Worker started (PID: $WORKER_PID) and appears to be listening."
    else
        log_warn "RQ Worker process started (PID: $WORKER_PID) but expected startup message not found in log yet. Check '$LOGS_DIR/worker.log'."
    fi
fi


# 5. Ensure Frontend .env.local exists with correct content
# (Keep .env.local logic as is - URLs should remain HTTPS for backend/filebrowser)
log_info "Checking Frontend .env.local file at '$FRONTEND_ENV_FILE'..."
if [ -d "$FRONTEND_DIR" ]; then # Check if frontend directory exists first
    if [ -f "$FRONTEND_ENV_FILE" ]; then
        log_info "'$FRONTEND_ENV_FILE' already exists. Skipping creation."
    else
        log_warn "'$FRONTEND_ENV_FILE' not found. Creating it..."
        printf "%s\n" "$FRONTEND_ENV_CONTENT" > "$FRONTEND_ENV_FILE" || log_error "Failed to create '$FRONTEND_ENV_FILE'."
        log_info "'$FRONTEND_ENV_FILE' created successfully with development URLs."
    fi
else
    log_warn "Frontend directory '$FRONTEND_DIR' not found. Cannot create '$FRONTEND_ENV_FILE'."
fi

# 6. Start Frontend (Next.js dev server on HTTP)
FRONTEND_NPM_PID=""
if [ -d "$FRONTEND_DIR" ]; then
  log_info "Starting Frontend dev server (Next.js on HTTP:${FRONTEND_HTTP_PORT}) -> $LOGS_DIR/frontend.log"
  cd "$FRONTEND_DIR"
  # Run npm install if node_modules doesn't exist
  if [ ! -d "node_modules" ]; then
      log_info "Node modules not found in $FRONTEND_DIR. Running 'npm install'..."
      if npm install >> "../$LOGS_DIR/frontend_npm_install.log" 2>&1; then
          log_info "'npm install' completed successfully. See '$LOGS_DIR/frontend_npm_install.log'."
      else
          log_error "'npm install' failed. Check '$LOGS_DIR/frontend_npm_install.log'."
          # No point continuing if install failed
          cd "$PROJECT_ROOT"
          cleanup_on_error # Trigger cleanup
          exit 1
      fi
  fi
  # Start the dev server in the background
  npm run dev > "../$LOGS_DIR/frontend.log" 2>&1 &
  FRONTEND_NPM_PID=$!
  echo $FRONTEND_NPM_PID > "../$FRONTEND_PID_FILE"
  cd "$PROJECT_ROOT" # Go back to project root
  sleep 5 # Give Next.js some time to start

  # Check if the process is running
  if ! ps -p $FRONTEND_NPM_PID > /dev/null; then
      log_error "Frontend process (PID: $FRONTEND_NPM_PID stored in $FRONTEND_PID_FILE) failed to start or crashed immediately. Check '$LOGS_DIR/frontend.log'."
  elif ! curl --output /dev/null --silent --head --fail http://localhost:${FRONTEND_HTTP_PORT}; then
      log_warn "Frontend process started (PID: $FRONTEND_NPM_PID) but failed to respond at http://localhost:${FRONTEND_HTTP_PORT}. Check '$LOGS_DIR/frontend.log'. It might still be compiling."
      # Don't start proxy if the underlying server isn't responding
  else
      log_info "Frontend started (PID: $FRONTEND_NPM_PID) and responding on HTTP:${FRONTEND_HTTP_PORT}."

      # <<< Start local-ssl-proxy using npx with CORRECTED flags >>>
      log_info "Starting Frontend HTTPS proxy (local-ssl-proxy) on port ${FRONTEND_HTTPS_PORT} -> $LOGS_DIR/proxy.log"
      # Check if npx is available
      if ! command -v npx &> /dev/null; then
          log_error "npx command not found. Cannot execute local-ssl-proxy reliably. Please ensure Node.js/npm is correctly installed and in your PATH."
      else
          # Run the proxy using npx in the background, relative to the frontend directory
          cd "$FRONTEND_DIR"
          # Use npx to find and execute the locally installed proxy
          # *** SWAPPED source and target ***
          npx local-ssl-proxy \
              --source "${FRONTEND_HTTPS_PORT}" \
              --target "${FRONTEND_HTTP_PORT}" \
              --key "../$TLS_KEY" \
              --cert "../$TLS_CERT" \
              > "../$LOGS_DIR/proxy.log" 2>&1 &
          PROXY_PID=$!
          echo $PROXY_PID > "../$PROXY_PID_FILE"
          cd "$PROJECT_ROOT"
          sleep 2 # Give proxy a moment

          if ! ps -p $PROXY_PID > /dev/null; then
              log_error "Frontend HTTPS Proxy (PID: $PROXY_PID stored in $PROXY_PID_FILE) failed to start. Check '$LOGS_DIR/proxy.log'."
          elif ! curl --output /dev/null --silent --head --fail --insecure https://localhost:${FRONTEND_HTTPS_PORT}; then
               log_warn "Frontend HTTPS Proxy started (PID: $PROXY_PID) but failed to respond at https://localhost:${FRONTEND_HTTPS_PORT}. Check '$LOGS_DIR/proxy.log'."
          else
              log_info "Frontend HTTPS Proxy started (PID: $PROXY_PID) and responding on HTTPS port ${FRONTEND_HTTPS_PORT}."
          fi
      fi
      # <<< END CORRECTION >>>

  fi
else
  log_warn "Frontend directory '$FRONTEND_DIR' not found. Skipping frontend start."
fi

log_info "--------------------------------------"
log_info "Development environment startup sequence complete."
log_info "Tailing logs from '$LOGS_DIR/'. Press Ctrl+C to stop all components."
log_info "Access Services:"
log_info "  - Backend API: https://localhost:8000/docs (for API docs)"
log_info "  - Frontend UI: https://localhost:${FRONTEND_HTTPS_PORT}" # <<< URL is correct
log_info "  - FileBrowser: https://localhost:8081"
log_info "--------------------------------------"

# Ensure log files exist before tailing
touch "$LOGS_DIR/backend.log" "$LOGS_DIR/worker.log" "$LOGS_DIR/frontend.log" "$LOGS_DIR/proxy.log" 2>/dev/null || true # <<< Added proxy.log

# Tail logs in the background
tail -f "$LOGS_DIR"/*.log &
TAIL_PID=$!
echo $TAIL_PID > "$TAIL_PID_FILE"

# Wait for the tail process specifically. Cleanup is handled by the trap.
wait $TAIL_PID

# This part might not be reached if Ctrl+C is handled by the trap correctly,
# but it's a fallback in case tail ends unexpectedly.
log_warn "Log tailing process ended unexpectedly. Cleaning up..."
cleanup
