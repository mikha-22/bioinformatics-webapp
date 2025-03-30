#!/bin/bash

# --- Configuration ---
PROJECT_DIR="/home/mikha/labs/bioinformatics-webapp"
OUTPUT_FILE="project_context.txt" # Output file will be created inside PROJECT_DIR
MAX_SIZE_BYTES=1048576 # 1MB limit (1 * 1024 * 1024) - Adjust as needed

# Directories to exclude (paths relative to PROJECT_DIR, anchored)
# IMPORTANT: Use anchors like './'
EXCLUDE_PATHS=(
    "./.git/" # Trailing slash helps match directory specifically
    "./bioinformatics/data/"
    "./bioinformatics/logs/"
    "./bioinformatics/results/"
    "./tls/"
    "./__pycache__/"
    "./node_modules/"
    "./venv/"
    "./build/"
    "./dist/"
    "./target/"
)

# Specific file patterns to exclude (can use wildcards)
EXCLUDE_FILES=(
    "$OUTPUT_FILE"
    "*.pyc"
    "*.pyo"
    "docker/filebrowser.db" # Be specific
    # Add others if needed, e.g., "*.log", "*.swp"
)
# --- End Configuration ---

# 1. Navigate to your project directory
cd "$PROJECT_DIR" || { echo "Error: Could not change directory to $PROJECT_DIR"; exit 1; }

echo "Scanning directory: $(pwd)"
# Construct grep -v patterns for exclusion
exclude_grep_pattern=$(printf -- '-e ^%s.* ' "${EXCLUDE_PATHS[@]}")
for file_pattern in "${EXCLUDE_FILES[@]}"; do
    # Need to handle wildcards differently for file patterns if needed,
    # but for simple names/extensions, direct match is ok.
    # For simple matching of full names or extensions at end:
     exclude_grep_pattern+="-e /${file_pattern//\./\\.}$ " # Match end of line
     exclude_grep_pattern+="-e ^\./${file_pattern//\./\\.}$ " # Match files in root
done

echo "Excluding paths starting with: ${EXCLUDE_PATHS[@]}"
echo "Excluding files matching: ${EXCLUDE_FILES[@]}"
echo "Skipping files larger than $MAX_SIZE_BYTES bytes."
echo "Outputting to: $(pwd)/$OUTPUT_FILE"

# Clear the output file before starting
> "$OUTPUT_FILE"

# 2. Find ALL files, then use grep -v to filter, then process
echo "Finding files and filtering..."
find . -type f -print | # Print all file paths, one per line
  grep -v $exclude_grep_pattern | # Exclude paths/files matching the patterns
  while IFS= read -r file; do
    # file path is relative like ./path/to/file.txt

    # Skip if file doesn't exist (grep might pass weird things?)
    [ ! -f "$file" ] && continue

    # Check if file is likely text using grep -I
    # This is less efficient than doing it once, but more reliable with find+grep -v
    if ! grep -Iq . "$file"; then
        # echo "[Skipping Binary]: $file" # Optional debug
        continue
    fi

    # Check file size (Linux syntax)
    current_size=$(stat -c%s "$file" 2>/dev/null)

    if [ -z "$current_size" ]; then
        echo "--- WARNING: Could not get size for ${file}. Skipping. ---" >> "$OUTPUT_FILE"
        echo "" >> "$OUTPUT_FILE"
        continue
    fi

    # Skip empty files
    if [ "$current_size" -eq 0 ]; then
        # echo "[Skipping Empty]: $file" # Optional debug
        continue
    fi

    echo "--- START FILE: ${file} ---" >> "$OUTPUT_FILE"
    if [ "$current_size" -lt "$MAX_SIZE_BYTES" ]; then
        # Append content or error message
        if LC_ALL=C cat -- "${file}" >> "$OUTPUT_FILE"; then
            [[ $(tail -c1 "${file}" | wc -l) -eq 0 ]] && echo >> "$OUTPUT_FILE"
        else
            echo >> "$OUTPUT_FILE"
            echo "--- ERROR READING FILE: ${file} (Code: $?) ---" >> "$OUTPUT_FILE"
        fi
    else
        echo "--- SKIPPED (Too large: ${current_size} bytes): ${file} ---" >> "$OUTPUT_FILE"
    fi
    echo "--- END FILE: ${file} ---" >> "$OUTPUT_FILE"
    echo "" >> "$OUTPUT_FILE"
done

echo "Finished creating $OUTPUT_FILE"
ls -lh "$OUTPUT_FILE"

# Optional: Go back
# cd - > /dev/null
