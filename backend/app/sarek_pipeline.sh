#!/bin/bash

# Sarek Pipeline Wrapper Script
# This script wraps the Sarek Nextflow pipeline with improved logging for debugging.

# --- Logging Setup ---
log() {
    # Adding PID for clarity in logs
    echo "[$(date '+%Y-%m-%d %H:%M:%S')][PID:$$] $1"
}

# --- Environment Variables ---
# Ensure HOME is set (should be set by tasks.py, but double-check)
if [ -z "$HOME" ]; then
    log "WARNING: HOME environment variable not set. Using current user's home directory."
    # Attempt to get home directory reliably
    export HOME=$(getent passwd $(id -u) | cut -d: -f6)
    if [ -z "$HOME" ]; then
        log "ERROR: Failed to determine HOME directory automatically. Exiting."
        exit 1
    fi
fi

# Ensure NXF_HOME is set (defaults to $HOME/.nextflow)
if [ -z "$NXF_HOME" ]; then
    log "NXF_HOME not set. Using default: $HOME/.nextflow"
    export NXF_HOME="$HOME/.nextflow"
fi

# Create NXF_HOME directory if it doesn't exist
# Check write permissions too
if [ ! -d "$NXF_HOME" ]; then
    log "Creating NXF_HOME directory: $NXF_HOME"
    mkdir -p "$NXF_HOME"
    if [ $? -ne 0 ]; then
        log "ERROR: Failed to create NXF_HOME directory: $NXF_HOME. Check permissions." >&2
        exit 1
    fi
elif [ ! -w "$NXF_HOME" ]; then
     log "ERROR: NXF_HOME directory ($NXF_HOME) is not writable by user $(whoami)." >&2
     exit 1
fi


# --- Input Validation (Argument Count) ---
if [ $# -lt 18 ]; then
    log "ERROR: Insufficient arguments provided. Expected 18, got $#."
    log "Usage: $0 <input_csv> <outdir> <genome> <tools> <step> <profile> <aligner> <intervals> <dbsnp> <known_indels> <pon> <joint_germline> <wes> <trim_fastq> <skip_qc> <skip_annotation> <skip_baserecalibrator> <is_rerun>"
    exit 1
fi

# --- Argument Parsing (Positional, MUST match order in tasks.py) ---
input_csv="$1"
outdir_base="$2"  # Base directory for output, not the final dir
genome="$3"
tools="$4"
step="$5"
profile="$6"
aligner="$7"
intervals="$8"
dbsnp="$9"
known_indels="${10}"
pon="${11}"
joint_germline_flag="${12}"
wes_flag="${13}"
trim_fastq_flag="${14}"
skip_qc_flag="${15}"
skip_annotation_flag="${16}"
skip_baserecalibrator_flag="${17}"
is_rerun="${18}"  # New parameter to indicate if this is a re-run

# --- Basic Validation (Required Args) ---
# Added logging for clarity
log "Validating required arguments..."
if [ -z "$input_csv" ]; then
    log "ERROR: Missing required argument: input_csv (Argument #1)" >&2
    exit 1
fi
if [ -z "$outdir_base" ]; then
    log "ERROR: Missing required argument: outdir_base (Argument #2)" >&2
    exit 1
fi
if [ -z "$genome" ]; then
    log "ERROR: Missing required argument: genome (Argument #3)" >&2
    exit 1
fi
log "Input CSV: $input_csv"
log "Output Base Dir: $outdir_base"
log "Genome: $genome"
# Log optional args only if they have a value
[ -n "$tools" ] && log "Tools: $tools"
[ -n "$step" ] && log "Step: $step"
[ -n "$profile" ] && log "Profile: $profile"
[ -n "$aligner" ] && log "Aligner: $aligner"
[ -n "$intervals" ] && log "Intervals: $intervals"
[ -n "$dbsnp" ] && log "dbSNP: $dbsnp"
[ -n "$known_indels" ] && log "Known Indels: $known_indels"
[ -n "$pon" ] && log "PoN: $pon"
log "Joint Germline: $joint_germline_flag"
log "WES: $wes_flag"
log "Trim FASTQ: $trim_fastq_flag"
log "Skip QC: $skip_qc_flag"
log "Skip Annotation: $skip_annotation_flag"
log "Skip Base Recalibrator: $skip_baserecalibrator_flag"
log "Is Rerun: $is_rerun"


# --- Generate Timestamped Results Directory ---
log "Generating results directory..."
timestamp=$(date +"%Y%m%d_%H%M%S")
csv_basename=$(basename "$input_csv" .csv)
results_dir="${outdir_base}/sarek_run_${timestamp}_${csv_basename}"

# Attempt to create directory, check permissions
mkdir -p "$results_dir"
if [ $? -ne 0 ]; then
    log "ERROR: Failed to create results directory: ${results_dir}. Check permissions for base directory: $outdir_base" >&2
    exit 1
fi
if [ ! -w "$results_dir" ]; then
     log "ERROR: Results directory (${results_dir}) is not writable by user $(whoami)." >&2
     # Optional: attempt to fix if possible, or just exit
     # chmod u+w "$results_dir" || exit 1
     exit 1
fi

# Echo the final path for backend parsing (keep this simple echo for easy parsing by tasks.py)
echo "Results directory: ${results_dir}"
log "Successfully created results directory: ${results_dir}"

# --- Define Paths ---
# Use absolute path for nextflow executable found in the worker's PATH
# Make sure this path matches the output of 'which nextflow' in your working environment
NXF_EXECUTABLE="/usr/local/bin/nextflow"

# <<< UPDATED config path variable >>>
NEXTFLOW_CONFIG="/home/admin01/labs/temp/nextflow_run/nextflow.config"
log "Using Nextflow config: ${NEXTFLOW_CONFIG}"

# <<< Define Nextflow Run Directory >>>
NEXTFLOW_RUN_DIR="/home/admin01/labs/temp/nextflow_run"
log "Using Nextflow run directory (for logs/work): ${NEXTFLOW_RUN_DIR}"

# <<< Define Nextflow Work Directory and Log File paths >>>
NEXTFLOW_WORK_DIR="${NEXTFLOW_RUN_DIR}/work"
NEXTFLOW_LOG_FILE="${NEXTFLOW_RUN_DIR}/.nextflow.log"

# <<< Ensure Nextflow Run Directory exists and is writable >>>
log "Checking Nextflow run directory..."
mkdir -p "$NEXTFLOW_RUN_DIR"
if [ $? -ne 0 ]; then
    log "ERROR: Failed to create Nextflow run directory: ${NEXTFLOW_RUN_DIR}. Check permissions." >&2
    exit 1
fi
if [ ! -w "$NEXTFLOW_RUN_DIR" ]; then
    log "ERROR: Nextflow run directory (${NEXTFLOW_RUN_DIR}) is not writable by user $(whoami)." >&2
    exit 1
fi
log "Nextflow run directory check passed."

# --- Build the Sarek Command ---
log "Building Nextflow command..."
# Start with the absolute path to nextflow
cmd="$NXF_EXECUTABLE run nf-core/sarek -r 3.5.1" # Use the specific version
cmd+=" --input ${input_csv}"
cmd+=" --outdir ${results_dir}"
cmd+=" --genome ${genome}"
cmd+=" -c ${NEXTFLOW_CONFIG}" # Use variable for config path

# <<< EXPORT Nextflow environment variables >>>
export NXF_WORK="${NEXTFLOW_WORK_DIR}"
export NXF_LOG_FILE="${NEXTFLOW_LOG_FILE}"
log "Setting NXF_WORK=${NXF_WORK}"
log "Setting NXF_LOG_FILE=${NXF_LOG_FILE}"
# <<< END EXPORT >>>

# Add wes flag if true
if [ "$wes_flag" = "true" ]; then
    cmd+=" --wes"
fi

# Add skip_baserecalibrator flag if true (MUST be before other tools)
if [ "$skip_baserecalibrator_flag" = "true" ]; then
    cmd+=" --skip_tools baserecalibrator"
fi

# Add tools if specified and not empty
# Check specifically against " " which might have been passed if tools was None in Python
if [ -n "$tools" ] && [ "$tools" != " " ]; then
    cmd+=" --tools ${tools}"
fi

# Add step if specified and not empty
if [ -n "$step" ] && [ "$step" != " " ]; then
    cmd+=" --step ${step}"
fi

# Add profile (use provided profile or default to docker)
# Use the variable $profile here
effective_profile="${profile:-docker}" # Default to 'docker' if $profile is empty or null
if [ -n "$effective_profile" ] && [ "$effective_profile" != " " ]; then
    cmd+=" -profile ${effective_profile}"
fi

# Add aligner if specified and not empty
if [ -n "$aligner" ] && [ "$aligner" != " " ]; then
    cmd+=" --aligner ${aligner}"
fi

# Add intervals if specified and not empty
if [ -n "$intervals" ] && [ "$intervals" != " " ]; then
    cmd+=" --intervals ${intervals}"
fi

# Add dbsnp if specified and not empty
if [ -n "$dbsnp" ] && [ "$dbsnp" != " " ]; then
    cmd+=" --dbsnp ${dbsnp}"
fi

# Add known_indels if specified and not empty
if [ -n "$known_indels" ] && [ "$known_indels" != " " ]; then
    cmd+=" --known_indels ${known_indels}"
fi

# Add pon if specified and not empty
if [ -n "$pon" ] && [ "$pon" != " " ]; then
    cmd+=" --pon ${pon}"
fi

# Add joint_germline flag if true
if [ "$joint_germline_flag" = "true" ]; then
    cmd+=" --joint_germline"
fi

# Add trim_fastq flag if true
if [ "$trim_fastq_flag" = "true" ]; then
    cmd+=" --trim_fastq"
fi

# Add skip_qc flag if true
if [ "$skip_qc_flag" = "true" ]; then
    cmd+=" --skip_qc"
fi

# Add skip_annotation flag if true
if [ "$skip_annotation_flag" = "true" ]; then
    cmd+=" --skip_annotation"
fi

# Add resume flag only for re-runs
if [ "$is_rerun" = "true" ]; then
    cmd+=" -resume"
fi

# --- DIAGNOSTIC BLOCK ---
log "--- Worker Environment ---"
log "User: $(whoami) (UID: $(id -u))"
log "Current Directory: $(pwd)" # This script runs from backend/app/
log "PATH: $PATH"
log "JAVA_HOME: ${JAVA_HOME:-<not set>}" # Check if JAVA_HOME is explicitly set
log "NXF_HOME: $NXF_HOME"
log "NXF_WORK (Explicit): $NXF_WORK" # <<< Added
log "NXF_LOG_FILE (Explicit): $NXF_LOG_FILE" # <<< Added
log "NXF_VER used in script: $(${NXF_EXECUTABLE} -v | head -n 1 || echo '<failed>') " # Show resolved NF version
log "--- Sanity Checks ---"
log "Checking Java..."
if command -v java >/dev/null 2>&1; then
    log "Java Path: $(command -v java)"
    log "Java Version: $(java -version 2>&1 | head -n 1)"
else
    log "ERROR: 'java' command not found in PATH ($PATH)" >&2
fi
log "Checking Nextflow executable..."
if [ -x "$NXF_EXECUTABLE" ]; then
     log "Nextflow executable found and is executable: $NXF_EXECUTABLE"
     log "Nextflow Version Check Output:"
     $NXF_EXECUTABLE -v || log "ERROR: 'nextflow -v' command failed using path $NXF_EXECUTABLE" >&2
else
     log "ERROR: Nextflow executable not found or not executable at $NXF_EXECUTABLE" >&2
     exit 1 # Exit if NF is not executable
fi
log "Checking Input CSV..."
if [ -f "$input_csv" ] && [ -r "$input_csv" ]; then
    log "Input CSV found and readable: $input_csv"
else
    log "ERROR: Input CSV not found or not readable: $input_csv" >&2
    ls -l "$input_csv" # Show details if possible
    exit 1 # Exit if input CSV missing
fi
log "Checking Config File..."
if [ -f "$NEXTFLOW_CONFIG" ] && [ -r "$NEXTFLOW_CONFIG" ]; then
    log "Config file found and readable: $NEXTFLOW_CONFIG"
else
    log "ERROR: Config file not found or not readable: $NEXTFLOW_CONFIG" >&2
    ls -l "$NEXTFLOW_CONFIG" # Show details if possible
    exit 1 # Exit if config file missing
fi
log "--- End Sanity Checks ---"
# --- END DIAGNOSTIC BLOCK ---


# --- Execute the pipeline ---
log "Executing Nextflow Command:"
log "$cmd"
# Log the command to a file as well for easier debugging
echo "Timestamp: $(date)" > "${results_dir}/pipeline_command.log"
echo "Executing User: $(whoami) (UID: $(id -u))" >> "${results_dir}/pipeline_command.log"
echo "Working Directory (of script): $(pwd)" >> "${results_dir}/pipeline_command.log"
echo "NXF_WORK: ${NXF_WORK}" >> "${results_dir}/pipeline_command.log"
echo "NXF_LOG_FILE: ${NXF_LOG_FILE}" >> "${results_dir}/pipeline_command.log"
echo "Command: ${cmd}" >> "${results_dir}/pipeline_command.log"
echo "---------------------" >> "${results_dir}/pipeline_command.log"

# *** MODIFIED EXECUTION LINE ***
# Execute directly, merging stdout/stderr, let Python capture it
# Environment variables NXF_WORK and NXF_LOG_FILE are already exported
$cmd 2>&1

exit_code=$? # Get exit code directly from the nextflow command
# *** END MODIFIED EXECUTION LINE ***

log "Nextflow command finished with exit code: ${exit_code}"
echo "---------------------" >> "${results_dir}/pipeline_command.log"
echo "Exit Code: ${exit_code}" >> "${results_dir}/pipeline_command.log"
echo "Finished: $(date)" >> "${results_dir}/pipeline_command.log"

# --- Check Final Status ---
if [ $exit_code -eq 0 ]; then
    log "Pipeline completed successfully (Exit Code 0)."
    # Echo simple status for Python - can enhance later if needed
    # e.g., could parse pipeline_command.log for specific success markers
    echo "status::success"
    exit 0
else
    log "ERROR: Pipeline failed with exit code ${exit_code}" >&2
    # Echo simple status for Python
    echo "status::failed"
    # It's important to exit with the non-zero code so RQ knows it failed
    exit ${exit_code}
fi
