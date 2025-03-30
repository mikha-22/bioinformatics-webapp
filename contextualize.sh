#!/bin/bash

# --- Configuration ---
PROJECT_DIR="/home/mikha/labs/bioinformatics-webapp"
OUTPUT_FILE="project_context.txt" # Output file will be created inside PROJECT_DIR
MAX_SIZE_BYTES=1048576 # 1MB limit (1 * 1024 * 1024) - Adjust as needed

# Directories to exclude (paths relative to PROJECT_DIR)
# Using an array for easier reading/management
EXCLUDE_PATHS=(
    "./.git"
    "./bioinformatics/data"
    "./bioinformatics/logs"
    "./bioinformatics/results"
    "./tls"
    "./__pycache__"
    "./node_modules"
    "./venv"
    "./build"
    "./dist"
    "./target"
    # Add any other specific directories if needed
    # e.g., "./some_other_vendor_dir"
)

# Specific files to exclude by name (relative to PROJECT_DIR)
# The output file itself is the primary one. Add others if necessary.
EXCLUDE_FILES=(
    "$OUTPUT_FILE"
    "*.pyc" # Also exclude python bytecode directly
    # "*.log" # You could exclude all logs here instead of the dir, but dir is safer
    "filebrowser.db" # Exclude the specific db file in docker/
)
# --- End Configuration ---

# 1. Navigate to your project directory
cd "$PROJECT_DIR" || { echo "Error: Could not change directory to $PROJECT_DIR"; exit 1; }

echo "Scanning directory: $(pwd)"
echo "Excluding paths matching: ${EXCLUDE_PATHS[@]}"
echo "Excluding files matching: ${EXCLUDE_FILES[@]}"
echo "Skipping files larger than $MAX_SIZE_BYTES bytes."
echo "Outputting to: $(pwd)/$OUTPUT_FILE"

# Clear the output file before starting
> "$OUTPUT_FILE"

# 2. Construct the find command arguments for exclusion
find_exclude_args=()
# Add directory path exclusions with -prune
for exclude_path in "${EXCLUDE_PATHS[@]}"; do
    find_exclude_args+=(-o -path "$exclude_path" -type d)
done
# Remove the leading '-o' if it exists (only happens if array is not empty)
[[ "${find_exclude_args[0]}" == "-o" ]] && find_exclude_args=("${find_exclude_args[@]:1}")
# Add the -prune action
find_exclude_args+=(-prune)

# Add specific filename exclusions
find_name_exclude_args=()
for exclude_file in "${EXCLUDE_FILES[@]}"; do
     find_name_exclude_args+=(-o -name "$exclude_file")
done
# Remove the leading '-o'
[[ "${find_name_exclude_args[0]}" == "-o" ]] && find_name_exclude_args=("${find_name_exclude_args[@]:1}")

# 3. Use find to locate files, excluding specified paths/files, then pipe to grep for binary check
#    find .                    # Start search from current dir (.)
#    \( args \) -prune         # Exclude specified directory paths *before* descending
#    -o                        # OR (if not pruned)
#    \( name_args \)           # Exclude specified file names
#    -o                        # OR (if not pruned and not excluded file name)
#    -type f -print0           # Print the path if it's a file, null-separated

#    xargs -0 grep -I -Z -l '.' # Read null-sep files, run grep -I (binary check), output null-sep filenames
#    while read ...            # Read null-separated filenames

echo "Running find command..."
find . \
    \( "${find_exclude_args[@]}" \) \
    -o \
    \( "${find_name_exclude_args[@]}" \) \
    -o \
    -type f -print0 |
    xargs -0 --no-run-if-empty grep -I -Z -l '.' |
    while IFS= read -r -d $'\0' file; do
        # file path is relative like ./path/to/file.txt

        # Check file size (Linux syntax)
        current_size=$(stat -c%s "$file" 2>/dev/null)

        if [ -z "$current_size" ]; then
            echo "--- WARNING: Could not get size for ${file}. Skipping. ---" >> "$OUTPUT_FILE"
            echo "" >> "$OUTPUT_FILE"
            continue
        fi

        echo "--- START FILE: ${file} ---" >> "$OUTPUT_FILE"
        if [ "$current_size" -lt "$MAX_SIZE_BYTES" ]; then
            # Append content or error message to the output file
            # Using LC_ALL=C to potentially speed up cat and avoid locale issues
            if LC_ALL=C cat -- "${file}" >> "$OUTPUT_FILE"; then
                # Add a newline after successful cat if file doesn't end with one
                [[ $(tail -c1 "${file}" | wc -l) -eq 0 ]] && echo >> "$OUTPUT_FILE"
            else
                echo >> "$OUTPUT_FILE" # Ensure newline before error message
                echo "--- ERROR READING FILE: ${file} (Code: $?) ---" >> "$OUTPUT_FILE"
            fi
        else
            echo "--- SKIPPED (Too large: ${current_size} bytes): ${file} ---" >> "$OUTPUT_FILE"
        fi
        echo "--- END FILE: ${file} ---" >> "$OUTPUT_FILE"
        echo "" >> "$OUTPUT_FILE" # Add a blank line for separation
    done

echo "Finished creating $OUTPUT_FILE"
ls -lh "$OUTPUT_FILE"

# Optional: Go back to the directory you were in before running the script
# cd - > /dev/null
