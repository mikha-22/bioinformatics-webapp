#!/bin/bash

# Sarek Pipeline Wrapper Script
# This script wraps the Sarek Nextflow pipeline with improved logging for debugging.

# --- Logging Setup ---
log() {
    # Adding PID for clarity in logs
    echo "[$(date '+%Y-%m-%d %H:%M:%S')][PID:$$] $1"
}

# --- Environment Variables ---
if [ -z "$HOME" ]; then
    log "WARNING: HOME environment variable not set. Using current user's home directory."
    export HOME=$(getent passwd $(id -u) | cut -d: -f6)
    if [ -z "$HOME" ]; then
        log "ERROR: Failed to determine HOME directory automatically. Exiting."
        exit 1
    fi
fi
if [ -z "$NXF_HOME" ]; then
    log "NXF_HOME not set. Using default: $HOME/.nextflow"
    export NXF_HOME="$HOME/.nextflow"
fi
if [ ! -d "$NXF_HOME" ]; then
    log "Creating NXF_HOME directory: $NXF_HOME"
    mkdir -p "$NXF_HOME"
    if [ $? -ne 0 ]; then log "ERROR: Failed to create NXF_HOME directory: $NXF_HOME. Check permissions." >&2; exit 1; fi
elif [ ! -w "$NXF_HOME" ]; then
     log "ERROR: NXF_HOME directory ($NXF_HOME) is not writable by user $(whoami)." >&2; exit 1;
fi

# --- Input Validation (Argument Count) ---
# <<< INCREASED EXPECTED ARGUMENT COUNT BY 1 (for run_name) >>>
if [ $# -lt 19 ]; then
    log "ERROR: Insufficient arguments provided. Expected 19, got $#."
    log "Usage: $0 <run_name> <input_csv> <outdir_base> <genome> <tools> <step> <profile> <aligner> <intervals> <dbsnp> <known_indels> <pon> <joint_germline> <wes> <trim_fastq> <skip_qc> <skip_annotation> <skip_baserecalibrator> <is_rerun>"
    exit 1
fi

# --- Argument Parsing (Positional, MUST match order in tasks.py) ---
# <<< ADDED run_name AS FIRST ARGUMENT >>>
run_name_input="$1"
input_csv="$2"
outdir_base="$3"
genome="$4"
tools="$5"
step="$6"
profile="$7"
aligner="$8"
intervals="$9"
dbsnp="${10}"
known_indels="${11}"
pon="${12}"
joint_germline_flag="${13}"
wes_flag="${14}"
trim_fastq_flag="${15}"
skip_qc_flag="${16}"
skip_annotation_flag="${17}"
skip_baserecalibrator_flag="${18}"
is_rerun="${19}"

# --- Basic Validation (Required Args) ---
log "Validating required arguments..."
if [ -z "$run_name_input" ]; then
    log "ERROR: Missing required argument: run_name_input (Argument #1)" >&2
    exit 1
fi
if [ -z "$input_csv" ]; then log "ERROR: Missing required argument: input_csv (Argument #2)" >&2; exit 1; fi
if [ -z "$outdir_base" ]; then log "ERROR: Missing required argument: outdir_base (Argument #3)" >&2; exit 1; fi
if [ -z "$genome" ]; then log "ERROR: Missing required argument: genome (Argument #4)" >&2; exit 1; fi

log "Run Name (Input): $run_name_input"
log "Input CSV: $input_csv"
log "Output Base Dir: $outdir_base"
log "Genome: $genome"
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

# --- Sanitize run_name_input for use in directory names (already mostly done in backend) ---
# Further sanitize: remove any characters not suitable for directory names
# Allows alphanumeric, underscore, hyphen. Replaces others with underscore.
sanitized_run_name=$(echo "$run_name_input" | sed 's/[^a-zA-Z0-9_-]/_/g')
if [ -z "$sanitized_run_name" ]; then
    log "ERROR: Sanitized run name is empty. Original was '$run_name_input'." >&2
    sanitized_run_name="unnamed_run" # Fallback if sanitization results in empty
fi
log "Sanitized Run Name (for dir): $sanitized_run_name"


# --- Determine Project Root, Artifact Dirs, and Run Identifier ---
log "Determining project root and artifact directories..."
SCRIPT_CWD=$(pwd) # Should be backend/app
# Assuming this script is in backend/app, project root is two levels up
PROJECT_ROOT_ABS=$(realpath "${SCRIPT_CWD}/../../")

log "Script current working directory (from where sarek_pipeline.sh is run): ${SCRIPT_CWD}"
log "Project root identified as: ${PROJECT_ROOT_ABS}"

NEXTFLOW_RUN_ARTIFACTS_DIR="${PROJECT_ROOT_ABS}/nextflow_run_artifacts"
NEXTFLOW_CONFIG_DIR="${NEXTFLOW_RUN_ARTIFACTS_DIR}/config"
NEXTFLOW_WORK_BASE_DIR="${NEXTFLOW_RUN_ARTIFACTS_DIR}/work" # Base for all work dirs
NEXTFLOW_LOG_BASE_DIR="${NEXTFLOW_RUN_ARTIFACTS_DIR}/logs" # Base for all .nextflow.log files

log "Ensuring Nextflow artifact directories exist under ${NEXTFLOW_RUN_ARTIFACTS_DIR}..."
mkdir -p "$NEXTFLOW_CONFIG_DIR" || { log "ERROR: Failed to create Nextflow config dir: $NEXTFLOW_CONFIG_DIR" >&2; exit 1; }
mkdir -p "$NEXTFLOW_WORK_BASE_DIR" || { log "ERROR: Failed to create Nextflow base work dir: $NEXTFLOW_WORK_BASE_DIR" >&2; exit 1; }
mkdir -p "$NEXTFLOW_LOG_BASE_DIR" || { log "ERROR: Failed to create Nextflow base log dir: $NEXTFLOW_LOG_BASE_DIR" >&2; exit 1; }

NEXTFLOW_CONFIG_FILE="${NEXTFLOW_CONFIG_DIR}/default_sarek.config"
log "Using Nextflow config file: ${NEXTFLOW_CONFIG_FILE}"
if [ ! -f "$NEXTFLOW_CONFIG_FILE" ]; then log "ERROR: Nextflow config file not found at ${NEXTFLOW_CONFIG_FILE}" >&2; exit 1; fi
if [ ! -r "$NEXTFLOW_CONFIG_FILE" ]; then log "ERROR: Nextflow config file not readable at ${NEXTFLOW_CONFIG_FILE}" >&2; exit 1; fi

log "Generating Sarek results directory name..."
timestamp=$(date +"%Y%m%d_%H%M%S")
# <<< USE SANITIZED RUN NAME AND TIMESTAMP FOR RESULTS DIRECTORY >>>
results_dir_name="${sanitized_run_name}_${timestamp}"
results_dir="${outdir_base}/${results_dir_name}" # Full path to results

mkdir -p "$results_dir"
if [ $? -ne 0 ]; then log "ERROR: Failed to create Sarek results directory: ${results_dir}. Check permissions for base: $outdir_base" >&2; exit 1; fi
if [ ! -w "$results_dir" ]; then log "ERROR: Sarek results directory (${results_dir}) is not writable by user $(whoami)." >&2; exit 1; fi
echo "Results directory: ${results_dir}" # This line is parsed by tasks.py
log "Successfully created Sarek results directory: ${results_dir}"

# Use the same unique identifier for work and log files for consistency
RUN_SPECIFIC_IDENTIFIER="${results_dir_name}" # Use the same name as the results folder for clarity
RUN_SPECIFIC_WORK_DIR="${NEXTFLOW_WORK_BASE_DIR}/${RUN_SPECIFIC_IDENTIFIER}"
RUN_SPECIFIC_LOG_FILE="${NEXTFLOW_LOG_BASE_DIR}/${RUN_SPECIFIC_IDENTIFIER}.nextflow.log"

log "Run-specific Nextflow work directory will be: ${RUN_SPECIFIC_WORK_DIR}"
log "Run-specific Nextflow log file will be: ${RUN_SPECIFIC_LOG_FILE}"

mkdir -p "$RUN_SPECIFIC_WORK_DIR" || { log "ERROR: Failed to create run-specific work dir: $RUN_SPECIFIC_WORK_DIR" >&2; exit 1; }

# --- Define Paths ---
NXF_EXECUTABLE="/usr/local/bin/nextflow" # Assuming Nextflow is installed here in the worker container

# --- Build the Sarek Command ---
log "Building Nextflow command..."
cmd="$NXF_EXECUTABLE run nf-core/sarek -r 3.5.1"
cmd+=" --input ${input_csv}"
cmd+=" --outdir ${results_dir}" # Use the newly constructed results_dir
cmd+=" --genome ${genome}"
cmd+=" -c ${NEXTFLOW_CONFIG_FILE}"
cmd+=" -name ${RUN_SPECIFIC_IDENTIFIER}" # <<< ADDED -name for Nextflow run name (useful in Tower/logs)

export NXF_WORK="${RUN_SPECIFIC_WORK_DIR}" # Explicitly set work directory
export NXF_LOG_FILE="${RUN_SPECIFIC_LOG_FILE}" # Explicitly set log file
log "Setting NXF_WORK=${NXF_WORK}"
log "Setting NXF_LOG_FILE=${NXF_LOG_FILE}"


if [ "$wes_flag" = "true" ]; then cmd+=" --wes"; fi
if [ "$skip_baserecalibrator_flag" = "true" ]; then cmd+=" --skip_tools baserecalibrator"; fi # Sarek specific way
if [ -n "$tools" ] && [ "$tools" != " " ]; then cmd+=" --tools ${tools}"; fi
if [ -n "$step" ] && [ "$step" != " " ]; then cmd+=" --step ${step}"; fi
effective_profile="${profile:-docker}" # Default to docker if not provided
if [ -n "$effective_profile" ] && [ "$effective_profile" != " " ]; then cmd+=" -profile ${effective_profile}"; fi
if [ -n "$aligner" ] && [ "$aligner" != " " ]; then cmd+=" --aligner ${aligner}"; fi
if [ -n "$intervals" ] && [ "$intervals" != " " ]; then cmd+=" --intervals ${intervals}"; fi
if [ -n "$dbsnp" ] && [ "$dbsnp" != " " ]; then cmd+=" --dbsnp ${dbsnp}"; fi
if [ -n "$known_indels" ] && [ "$known_indels" != " " ]; then cmd+=" --known_indels ${known_indels}"; fi
if [ -n "$pon" ] && [ "$pon" != " " ]; then cmd+=" --pon ${pon}"; fi
if [ "$joint_germline_flag" = "true" ]; then cmd+=" --joint_germline"; fi
if [ "$trim_fastq_flag" = "true" ]; then cmd+=" --trim_fastq"; fi
if [ "$skip_qc_flag" = "true" ]; then cmd+=" --skip_qc"; fi
if [ "$skip_annotation_flag" = "true" ]; then cmd+=" --skip_annotation"; fi
if [ "$is_rerun" = "true" ]; then cmd+=" -resume"; fi


log "--- Worker Environment & Sanity Checks ---"
log "User: $(whoami) (UID: $(id -u))"
log "Current Directory (of script execution): $(pwd)"
log "PROJECT_ROOT_ABS (Determined): ${PROJECT_ROOT_ABS}"
log "NEXTFLOW_RUN_ARTIFACTS_DIR: ${NEXTFLOW_RUN_ARTIFACTS_DIR}"
log "PATH: $PATH"
log "JAVA_HOME: ${JAVA_HOME:-<not set>}"
log "NXF_HOME (for assets/plugins): $NXF_HOME"
log "NXF_WORK (explicitly set for this run): $NXF_WORK"
log "NXF_LOG_FILE (explicitly set for this run): $NXF_LOG_FILE"
log "NXF_VER used in script: $(${NXF_EXECUTABLE} -v | head -n 1 || echo '<failed>') "
log "Checking Java..."
if command -v java >/dev/null 2>&1; then log "Java Path: $(command -v java)"; log "Java Version: $(java -version 2>&1 | head -n 1)"; else log "ERROR: 'java' command not found in PATH ($PATH)" >&2; fi
log "Checking Nextflow executable..."
if [ -x "$NXF_EXECUTABLE" ]; then log "Nextflow executable found and is executable: $NXF_EXECUTABLE"; log "Nextflow Version Check Output:"; $NXF_EXECUTABLE -v || log "ERROR: 'nextflow -v' command failed using path $NXF_EXECUTABLE" >&2; else log "ERROR: Nextflow executable not found or not executable at $NXF_EXECUTABLE" >&2; exit 1; fi
log "Checking Input CSV..."
if [ -f "$input_csv" ] && [ -r "$input_csv" ]; then log "Input CSV found and readable: $input_csv"; else log "ERROR: Input CSV not found or not readable: $input_csv" >&2; ls -l "$input_csv"; exit 1; fi
log "Checking Nextflow Config File..."
if [ -f "$NEXTFLOW_CONFIG_FILE" ] && [ -r "$NEXTFLOW_CONFIG_FILE" ]; then log "Config file found and readable: $NEXTFLOW_CONFIG_FILE"; else log "ERROR: Config file not found or not readable: $NEXTFLOW_CONFIG_FILE" >&2; ls -l "$NEXTFLOW_CONFIG_FILE"; exit 1; fi
log "--- End Sanity Checks ---"

# --- Execute the pipeline ---
log "Executing Nextflow Command:"
log "$cmd"
# Store command and details in a log file within the results directory
COMMAND_LOG_FILE="${results_dir}/pipeline_execution_details.log"
echo "Timestamp: $(date)" > "${COMMAND_LOG_FILE}"
echo "Executing User: $(whoami) (UID: $(id -u))" >> "${COMMAND_LOG_FILE}"
echo "Working Directory (of script): $(pwd)" >> "${COMMAND_LOG_FILE}"
echo "Run Name (Input): ${run_name_input}" >> "${COMMAND_LOG_FILE}"
echo "Sanitized Run Name (for dir): ${sanitized_run_name}" >> "${COMMAND_LOG_FILE}"
echo "Results Directory: ${results_dir}" >> "${COMMAND_LOG_FILE}"
echo "NXF_WORK (run-specific): ${NXF_WORK}" >> "${COMMAND_LOG_FILE}"
echo "NXF_LOG_FILE (run-specific): ${NXF_LOG_FILE}" >> "${COMMAND_LOG_FILE}"
echo "Nextflow Command: ${cmd}" >> "${COMMAND_LOG_FILE}"
echo "---------------------" >> "${COMMAND_LOG_FILE}"

# Execute the command, tee output to both the command log and stdout/stderr
# This allows live logging via tasks.py and also captures it in the results folder.
# Using a pipe to tee might affect how exit codes are handled by `set -e` if it were active.
# Since `set -e` is not active here, we capture $? manually.
{
    eval "$cmd" # Use eval to correctly handle quoted arguments within the cmd string
} 2>&1 | tee -a "${COMMAND_LOG_FILE}"

exit_code=${PIPESTATUS[0]} # Get exit code of the eval "$cmd" part

log "Nextflow command finished with exit code: ${exit_code}"
echo "---------------------" >> "${COMMAND_LOG_FILE}"
echo "Exit Code: ${exit_code}" >> "${COMMAND_LOG_FILE}"
echo "Finished: $(date)" >> "${COMMAND_LOG_FILE}"

if [ $exit_code -eq 0 ]; then
    log "Pipeline completed successfully (Exit Code 0)."
    echo "status::success" # Parsed by tasks.py
    exit 0
else
    log "ERROR: Pipeline failed with exit code ${exit_code}" >&2
    echo "status::failed" # Parsed by tasks.py
    exit ${exit_code}
fi
