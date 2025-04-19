#!/bin/bash

# === gather_context_v2.sh ===
# Gathers project context into a single file for LLMs, with improved filtering.

# --- Default Configuration ---
DEFAULT_PROJECT_DIR="." # Default to current directory
DEFAULT_OUTPUT_FILE="project_context_v2.txt"
DEFAULT_MAX_SIZE_MB=1 # Default Max Size in MiB
DEFAULT_CONTEXTIGNORE=".contextignore" # File listing patterns to ignore

# --- Internal Exclusions (Always applied unless overridden by .contextignore logic if we added that) ---
# Essential directories usually not needed for context
DEFAULT_EXCLUDE_PATHS=(
    "./.git/"
    "./__pycache__/"
    "./node_modules/"       # Excludes top-level node_modules
    "./venv/"
    "./.venv/"
    "./build/"
    "./dist/"
    "./target/"
    "./.mypy_cache/"
    "./.pytest_cache/"
    "./.ruff_cache/"
    # Add project-specific data/log/result paths here or in .contextignore
    "./bioinformatics/data/"
    "./bioinformatics/logs/"
    "./bioinformatics/results/"
    "./tls/"
    # --- ADDED FOR NEXT.JS FRONTEND ---
    "./frontend_app/.next/"         # Exclude Next.js build/cache directory
    "./frontend_app/node_modules/"  # Exclude nested node_modules
    # ---------------------------------
)

# Common binary file extensions (heuristic)
DEFAULT_BINARY_EXTENSIONS=(
    "*.png" "*.jpg" "*.jpeg" "*.gif" "*.bmp" "*.ico" "*.tif" "*.tiff"
    "*.pdf" "*.doc" "*.docx" "*.xls" "*.xlsx" "*.ppt" "*.pptx"
    "*.zip" "*.tar" "*.gz" "*.bz2" "*.rar" "*.7z" "*.xz" "*.tgz"
    "*.so" "*.dll" "*.o" "*.a" "*.lib" "*.dylib" "*.bundle"
    "*.pyc" "*.pyo" "*.pyd" # Python bytecode/extensions
    "*.class" "*.jar" # Java
    "*.exe" "*.msi" "*.deb" "*.rpm" # Executables/Installers
    "*.woff" "*.woff2" "*.ttf" "*.otf" "*.eot" # Fonts
    "*.mp3" "*.wav" "*.ogg" "*.mp4" "*.avi" "*.mov" "*.webm" # Media
    "*.db" "*.sqlite" "*.sqlite3" "*.db3" # Databases
    "*.swp" "*.swo" # Swap files
)

# Specific file names/patterns to exclude
DEFAULT_EXCLUDE_FILES=(
    # Placeholder for the actual output file name
    # "*.log" # General logs (consider adding if not covered by paths)
    "*.lock" # e.g., package-lock.json, poetry.lock, yarn.lock
    "docker/filebrowser.db" # Example specific file
)

# --- Option Flags ---
ENABLE_GREP_I_CHECK=true # Set to false to rely only on extension filtering

# --- Argument Parsing ---
PROJECT_DIR="${1:-$DEFAULT_PROJECT_DIR}"
OUTPUT_FILE_NAME="${2:-$DEFAULT_OUTPUT_FILE}"
MAX_SIZE_MB="${3:-$DEFAULT_MAX_SIZE_MB}"

# Convert MB to Bytes
MAX_SIZE_BYTES=$(( MAX_SIZE_MB * 1024 * 1024 ))

# --- Helper Functions ---
log_info() {
    echo "[INFO] $1"
}

log_warn() {
    echo "[WARN] $1" >&2
}

log_error() {
    echo "[ERROR] $1" >&2
    exit 1
}

# --- Main Execution ---

# 1. Validate and Navigate to Project Directory
if [ ! -d "$PROJECT_DIR" ]; then
    log_error "Project directory not found: $PROJECT_DIR"
fi
cd "$PROJECT_DIR" || log_error "Could not change directory to $PROJECT_DIR"
PROJECT_DIR_ABS="$(pwd)" # Get absolute path
OUTPUT_FILE="$PROJECT_DIR_ABS/$OUTPUT_FILE_NAME" # Use absolute path for output file
log_info "Scanning project: $PROJECT_DIR_ABS"

# Ensure the output file itself is excluded
DEFAULT_EXCLUDE_FILES+=("$OUTPUT_FILE_NAME") # Add relative name

# 2. Prepare Exclusion Lists (Combine Defaults and .contextignore)
EXCLUDE_PATHS=("${DEFAULT_EXCLUDE_PATHS[@]}")
EXCLUDE_FILES=("${DEFAULT_EXCLUDE_FILES[@]}")
BINARY_EXTENSIONS=("${DEFAULT_BINARY_EXTENSIONS[@]}")

CONTEXTIGNORE_PATH="$PROJECT_DIR_ABS/$DEFAULT_CONTEXTIGNORE"
if [ -f "$CONTEXTIGNORE_PATH" ]; then
    log_info "Reading exclusions from $CONTEXTIGNORE_PATH"
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Trim whitespace
        pattern=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        # Skip empty lines and comments
        [[ -z "$pattern" || "$pattern" == \#* ]] && continue

        if [[ "$pattern" == */ ]]; then
            # Directory pattern (ends with /) -> add to path excludes
            # Ensure it starts with ./ for find -path matching
            pattern="./${pattern%/}/" # Ensure ./ prefix and trailing /
            # Avoid duplicate additions if already in defaults
            if ! printf '%s\n' "${EXCLUDE_PATHS[@]}" | grep -Fxq -- "$pattern"; then
                 EXCLUDE_PATHS+=("$pattern")
                 log_info "  Ignoring path from .contextignore: ${pattern}*"
            fi
        elif [[ "$pattern" == *"/"* ]]; then
             # Specific file path pattern -> add to file excludes
             pattern="./$pattern"
             if ! printf '%s\n' "${EXCLUDE_FILES[@]}" | grep -Fxq -- "$pattern"; then
                 EXCLUDE_FILES+=("$pattern")
                 log_info "  Ignoring file path from .contextignore: $pattern"
             fi
        else
            # General file pattern (glob) -> add to file excludes
             if ! printf '%s\n' "${EXCLUDE_FILES[@]}" | grep -Fxq -- "$pattern"; then
                EXCLUDE_FILES+=("$pattern")
                log_info "  Ignoring file pattern from .contextignore: $pattern"
            fi
        fi
    done < "$CONTEXTIGNORE_PATH"
else
    log_info "No $DEFAULT_CONTEXTIGNORE file found, using defaults."
fi

# --- Construct find command arguments ---

# Start building the command
final_find_cmd=(find . )

# A: Path exclusions (directories) - Build the prune part
path_prune_conditions=()
log_info "Applying path exclusions for pruning:"
for path in "${EXCLUDE_PATHS[@]}"; do
    # Ensure path starts with ./ and ends without / for matching
    path_pattern=$(echo "$path" | sed 's:/*$::' | sed 's:^\./::')
    if [[ -n "$path_pattern" ]]; then
        # Add conditions to match the directory itself OR its contents
        # Use -wholename which is often more robust than -path for this
        path_prune_conditions+=( -wholename "./$path_pattern" -o -wholename "./$path_pattern/*" -o )
        log_info "  - Pruning ./$path_pattern and ./$path_pattern/*"
    fi
done

# Add the pruning logic to the command IF there are conditions
if [ ${#path_prune_conditions[@]} -gt 0 ]; then
    unset 'path_prune_conditions[${#path_prune_conditions[@]}-1]' # Remove trailing -o
    # Add the parentheses, the conditions, -prune, and the crucial -o separator
    final_find_cmd+=( \( "${path_prune_conditions[@]}" \) -prune -o )
fi

# B: File name/pattern exclusions (build the -not (...) part)
file_exclude_conditions=()
log_info "Applying file exclusions:"
for pattern in "${EXCLUDE_FILES[@]}"; do
    if [[ "$pattern" == *"/"* ]]; then
        # Specific path relative to root: ./path/to/file.ext
        pattern="${pattern#./}" # Remove leading ./ if present
        if [[ -n "$pattern" ]]; then
            # Use -wholename for consistency
            file_exclude_conditions+=( -wholename "./$pattern" -o )
            log_info "  - Excluding file path: ./$pattern"
        fi
    else
        # Simple name pattern: *.log, specific_file.txt
         if [[ -n "$pattern" ]]; then
             file_exclude_conditions+=( -name "$pattern" -o )
             log_info "  - Excluding file name pattern: $pattern"
         fi
    fi
done

# Add the file exclusion logic IF there are conditions
if [ ${#file_exclude_conditions[@]} -gt 0 ]; then
    unset 'file_exclude_conditions[${#file_exclude_conditions[@]}-1]' # Remove trailing -o
    final_find_cmd+=( -not \( "${file_exclude_conditions[@]}" \) )
fi

# C: Binary extension exclusions (heuristic - build the -not (...) part)
binary_exclude_conditions=()
log_info "Applying binary extension exclusions:"
for ext_pattern in "${BINARY_EXTENSIONS[@]}"; do
    binary_exclude_conditions+=( -name "$ext_pattern" -o )
     log_info "  - Excluding binary extension: $ext_pattern"
done

# Add the binary exclusion logic IF there are conditions
if [ ${#binary_exclude_conditions[@]} -gt 0 ]; then
    unset 'binary_exclude_conditions[${#binary_exclude_conditions[@]}-1]' # Remove trailing -o
    final_find_cmd+=( -not \( "${binary_exclude_conditions[@]}" \) )
fi


# Add the main selection criteria and final action
final_find_cmd+=(
    -type f                 # Select only files
    -not -empty             # Exclude empty files
    -size "-${MAX_SIZE_BYTES}c" # Exclude files larger than MAX_SIZE_BYTES
    -print0                 # Print null-terminated names for safety
)


# --- DEBUG: Print the constructed find command ---
echo "---"
log_info "Constructed find command:"
# Use printf for safer printing of arguments, especially ones with spaces or special chars
printf "%q " "${final_find_cmd[@]}"
echo # Add a newline
echo "---"
# --- End Debug ---


log_info "Starting file scan..."
log_info "Max file size: $MAX_SIZE_MB MiB ($MAX_SIZE_BYTES bytes)"
if $ENABLE_GREP_I_CHECK; then
    log_info "Binary check: Enabled (grep -I)"
else
    log_info "Binary check: Disabled (relying on extensions)"
fi
echo "---" # Separator

# Clear the output file
> "$OUTPUT_FILE" || log_error "Could not clear/create output file: $OUTPUT_FILE"

# --- Process Files ---
file_count=0
total_bytes=0
errors=0

# Execute the constructed find command
# Use process substitution to avoid subshell issues with counters
while IFS= read -r -d $'\0' file; do
    # file path is relative like ./path/to/file.txt

    # Secondary Binary Check (if enabled)
    if $ENABLE_GREP_I_CHECK; then
        # Use LC_ALL=C for performance and to avoid locale issues
        # grep -I is generally robust. Redirect stderr to avoid clutter.
        if ! LC_ALL=C grep -Iq . "$file" 2>/dev/null; then
            # log_info "[Skipping Binary (grep -I)]: $file" # Optional debug
            continue
        fi
    fi

    # Get file size for reporting (already filtered by find)
    current_size=$(stat -c%s "$file" 2>/dev/null)
    if [ -z "$current_size" ]; then
        log_warn "Could not get size for $file. Skipping."
        ((errors++)) # Count as error? Maybe just warning.
        continue # Skip if size cannot be determined
    fi

    # Append to output file
    echo "--- START FILE: ${file} (Size: ${current_size} bytes) ---" >> "$OUTPUT_FILE"
    if LC_ALL=C cat -- "$file" >> "$OUTPUT_FILE"; then
        # Ensure a newline exists after the file content if cat was successful
        echo >> "$OUTPUT_FILE"
        ((file_count++))
        total_bytes=$(( total_bytes + current_size ))
    else
        # Add a newline even if cat fails, before the error message
        echo >> "$OUTPUT_FILE"
        echo "--- ERROR READING FILE: ${file} (Code: $?) ---" >> "$OUTPUT_FILE"
        ((errors++))
        log_warn "Error reading file: $file"
    fi
    echo "--- END FILE: ${file} ---" >> "$OUTPUT_FILE"
    # Add an extra blank line for readability between file blocks
    echo "" >> "$OUTPUT_FILE"

done < <("${final_find_cmd[@]}" 2>/dev/null) # Pass find options as separate arguments, redirect stderr

# --- Final Report ---
echo "---"
log_info "Scan complete."
log_info "Included $file_count files."
if [ $errors -gt 0 ]; then
    log_warn "$errors errors encountered while reading/stat'ing files."
fi
log_info "Output written to: $OUTPUT_FILE"
ls -lh "$OUTPUT_FILE"
final_size_bytes=$(stat -c%s "$OUTPUT_FILE" 2>/dev/null || echo 0)
log_info "Total context size: $final_size_bytes bytes"

# Optional: Go back to original directory if needed
# cd - > /dev/null

exit 0
