#!/bin/bash

# kill_dev_scanner.sh v2
# Stops the development environment components by scanning for running processes.
# Improved frontend killing. Does NOT rely on PID files.

# --- Configuration ---
REDIS_CONTAINER_NAME="bio_redis_local"
FILEBROWSER_CONTAINER_NAME="bio_filebrowser_local"
FRONTEND_DIR_NAME="frontend_app" # Name of the frontend directory
FRONTEND_PORT="3000" # Default Next.js dev port
BACKEND_SCRIPT="main.py"
WORKER_PATTERN="rq worker pipeline_tasks"
TAIL_PATTERN="tail -f .*logs_dev/.*\.log"

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

# Function to kill a process gracefully, then forcefully if needed
_kill_process() {
    local pid="$1"
    local process_name="$2"

    if ! ps -p "$pid" > /dev/null; then
        log_info "$process_name (PID: $pid) not found or already stopped."
        return 0 # Return success if already stopped
    fi

    log_info "Attempting to stop $process_name (PID: $pid)..."
    # Attempt graceful shutdown first
    kill -TERM "$pid" 2>/dev/null
    sleep 1 # Give it a second to terminate

    # Check if it's still running
    if ps -p "$pid" > /dev/null; then
        log_warn "$process_name (PID: $pid) did not stop gracefully, sending KILL signal..."
        kill -KILL "$pid" 2>/dev/null
        sleep 0.5 # Short pause after KILL
         if ps -p "$pid" > /dev/null; then
             log_error "Failed to kill $process_name (PID: $pid) even with KILL signal."
             return 1 # Return failure
         else
            log_info "$process_name (PID: $pid) force-killed."
            return 0 # Return success
         fi
    else
       log_info "$process_name (PID: $pid) stopped gracefully."
       return 0 # Return success
    fi
}

# Function to find and kill processes matching a command pattern
kill_process_by_pattern() {
    local pattern="$1"
    local process_name="$2"
    local pids
    local pid_count=0
    local kill_failed=0

    log_info "Searching for '$process_name' processes matching pattern: '$pattern'..."

    # Use pgrep -f to find PIDs matching the full command line
    # Exclude the current script's PID ($$) and grep itself
    # Ensure pattern is quoted if it contains spaces or special characters
    pids=$(pgrep -f -- "$pattern" | grep -v "^$$\$" || true) # Use -- to indicate end of options

    if [ -z "$pids" ]; then
        log_info "No running '$process_name' processes found matching the pattern."
        return
    fi

    # Iterate over found PIDs
    for pid in $pids; do
        if ! _kill_process "$pid" "$process_name"; then
            kill_failed=1
        fi
        ((pid_count++))
    done

    log_info "Attempted to stop $pid_count '$process_name' process(es)."
    # Optionally report if any kill failed
    # [ "$kill_failed" -eq 1 ] && log_warn "Failed to stop at least one $process_name process."
}

# Function to find and kill processes listening on a specific TCP port
# Returns 0 if a process was found and successfully stopped, 1 otherwise
kill_process_by_port() {
    local port="$1"
    local process_name="$2"
    local pids
    local pid_count=0
    local overall_success=1 # Assume failure until a process is found and killed

    log_info "Searching for '$process_name' process listening on TCP port $port..."

    # Use lsof to find the PID listening on the port.
    # -P: Inhibits conversion of port numbers to port names.
    # -n: Inhibits conversion of network numbers to host names for network files.
    # -sTCP:LISTEN : Only show processes listening on TCP
    # -t: Output PIDs only
    # Removed 2>/dev/null to see potential lsof errors
    pids=$(lsof -i tcp:"$port" -sTCP:LISTEN -P -n -t)

    if [ -z "$pids" ]; then
        log_info "No process found listening on TCP port $port using lsof."
        return 1 # Indicate no process found
    fi

    log_info "Found PID(s) listening on port $port: $pids"

     # Iterate over found PIDs (lsof might return multiple if unlucky)
    for pid in $pids; do
        # Get command name for logging confirmation
        local cmd_name=$(ps -o comm= -p "$pid" || echo "UnknownCmd")
        log_info "Targeting PID $pid (Command: $cmd_name) listening on port $port..."
        if _kill_process "$pid" "$process_name (Port $port Listener - $cmd_name)"; then
            overall_success=0 # Mark success if at least one process was killed
        fi
        ((pid_count++))
    done

    log_info "Attempted to stop $pid_count '$process_name' process(es) listening on port $port."
    return $overall_success
}


# Function to stop a Docker container
stop_docker_container() {
    local container_name="$1"
    local container_display_name="$2"
    log_info "Checking status of $container_display_name ($container_name)..."
    if docker ps -q --filter "name=^/${container_name}$" --filter "status=running" | grep -q .; then
        log_info "Stopping $container_display_name ($container_name)..."
        if docker stop -t 5 "$container_name" > /dev/null 2>&1; then
             log_info "$container_display_name ($container_name) stopped successfully."
        else
             log_warn "Failed to stop $container_display_name ($container_name) gracefully. Check 'docker logs $container_name'."
        fi
    else
        log_info "$container_display_name ($container_name) is not running."
    fi
}

# --- Main Script ---
log_info "--- Initiating Development Environment Shutdown (Scanner Mode v2) ---"

# Stop background processes by finding them
log_info "Stopping background processes..."

# 1. Stop Backend (Python)
kill_process_by_pattern "python .*$BACKEND_SCRIPT" "Backend ($BACKEND_SCRIPT)"

# 2. Stop RQ Worker
kill_process_by_pattern "$WORKER_PATTERN" "RQ Worker"

# 3. Stop Frontend (Prioritize Port, Fallback to Patterns)
log_info "Attempting to stop Frontend (Next.js)..."
if ! kill_process_by_port "$FRONTEND_PORT" "Frontend"; then
    log_warn "Could not find/stop Frontend process using port $FRONTEND_PORT. Trying pattern matching..."
    # Fallback patterns - Try killing Node processes associated with Next.js dev
    # Be careful, these might be too broad if other Node apps are running.
    kill_process_by_pattern "node .*node_modules/.bin/next dev" "Frontend (next dev)"
    # Add more specific patterns if the above doesn't work, e.g., related to the frontend_app directory
    # kill_process_by_pattern "node .*$FRONTEND_DIR_NAME/.*/server.js" "Frontend (Node Server)"
fi

# 4. Stop Log Tailing
kill_process_by_pattern "$TAIL_PATTERN" "Log Tailing Process"


# Stop Docker containers
log_info "Stopping Docker containers..."
stop_docker_container "$FILEBROWSER_CONTAINER_NAME" "FileBrowser Container"
stop_docker_container "$REDIS_CONTAINER_NAME" "Redis Container"

log_info "--- Development Environment Shutdown Complete ---"

# Optional: Final check for the frontend port
log_info "Performing final check for process on port $FRONTEND_PORT..."
if lsof -i tcp:"$FRONTEND_PORT" -sTCP:LISTEN -P -n -t > /dev/null; then
    log_warn "A process is still listening on port $FRONTEND_PORT after shutdown attempt."
else
    log_info "Confirmed no process listening on port $FRONTEND_PORT."
fi


exit 0
