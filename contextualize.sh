#!/bin/bash

# --- Configuration ---
PROJECT_DIR="/home/mikha/labs/bioinformatics-webapp"
OUTPUT_FILE="project_context.txt" # Output file will be created inside PROJECT_DIR
MAX_SIZE_BYTES=1048576 # 1MB limit (1 * 1024 * 1024) - Adjust as needed

# Directories to exclude (relative to PROJECT_DIR)
# Added __pycache__, data, logs, results, tls based on your tree output
EXCLUDE_DIRS="{.git,__pycache__,data,logs,results,tls,node_modules,venv,build,dist,target}"

# Specific files to exclude (relative to PROJECT_DIR)
EXCLUDE_FILES="project_context.txt"
# --- End Configuration ---

# 1. Navigate to your project directory
cd "$PROJECT_DIR" || { echo "Error: Could not change directory to $PROJECT_DIR"; exit 1; }

echo "Scanning directory: $(pwd)"
echo "Excluding directories matching pattern: $EXCLUDE_DIRS"
echo "Excluding files matching pattern: $EXCLUDE_FILES"
echo "Skipping files larger than $MAX_SIZE_BYTES bytes."
echo "Outputting to: $(pwd)/$OUTPUT_FILE"

# Clear the output file before starting
> "$OUTPUT_FILE"

# 2. Find, filter, and concatenate readable files
#    -I: Skip binary
#    -r: Recursive
#    -l: List filenames only
#    --exclude-dir: Skip specified directories
#    --exclude: Skip specified files
#    '.': Search pattern (anything)
#    '.': Search in current directory
grep -Irl --exclude-dir=$EXCLUDE_DIRS --exclude=$EXCLUDE_FILES '.' . | \
  while IFS= read -r file; do
    # Make file path relative for cleaner output
    relative_file=${file#./}

    # Check file size (Linux syntax)
    current_size=$(stat -c%s "$file" 2>/dev/null)

    if [ -z "$current_size" ]; then
      # Append warning to the log file instead of just stdout
      echo "--- WARNING: Could not get size for ${relative_file}. Skipping. ---" >> "$OUTPUT_FILE"
      echo "" >> "$OUTPUT_FILE"
      continue
    fi

    echo "--- START FILE: ${relative_file} ---" >> "$OUTPUT_FILE"
    if [ "$current_size" -lt "$MAX_SIZE_BYTES" ]; then
       # Append content or error message to the output file
       if cat "${file}" >> "$OUTPUT_FILE"; then
           # Add a newline after successful cat if file doesn't end with one
           # This helps separate the content from the END marker better
           [[ $(tail -c1 "${file}" | wc -l) -eq 0 ]] && echo >> "$OUTPUT_FILE"
       else
           echo >> "$OUTPUT_FILE" # Ensure newline before error message
           echo "--- ERROR READING FILE: ${relative_file} ---" >> "$OUTPUT_FILE"
       fi
    else
       echo "--- SKIPPED (Too large: ${current_size} bytes): ${relative_file} ---" >> "$OUTPUT_FILE"
    fi
    echo "--- END FILE: ${relative_file} ---" >> "$OUTPUT_FILE"
    echo "" >> "$OUTPUT_FILE" # Add a blank line for separation
  done

echo "Finished creating $OUTPUT_FILE"
# Optional: Display the size of the created file
ls -lh "$OUTPUT_FILE"

# Optional: Go back to the directory you were in before running the script
# cd - > /dev/null
