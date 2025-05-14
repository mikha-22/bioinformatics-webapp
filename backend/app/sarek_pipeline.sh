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

if [ -z "$JAVA_HOME" ]; then
    log "JAVA_HOME not set. Attempting to infer..."
    if command -v java >/dev/null 2>&1; then
        JAVA_PATH_CMD_V=$(command -v java)
        JAVA_REAL_PATH=$(realpath "$JAVA_PATH_CMD_V")
        log "Found java executable at: $JAVA_REAL_PATH (from $JAVA_PATH_CMD_V)"
        POTENTIAL_JAVA_HOME=$(dirname "$(dirname "$JAVA_REAL_PATH")")
        log "Potential JAVA_HOME based on dirname: $POTENTIAL_JAVA_HOME"
        if [ -f "$POTENTIAL_JAVA_HOME/release" ] || [ -d "$POTENTIAL_JAVA_HOME/jre" ] || [ -d "$POTENTIAL_JAVA_HOME/lib/jli" ]; then
            export JAVA_HOME="$POTENTIAL_JAVA_HOME"
            log "Successfully inferred and set JAVA_HOME: $JAVA_HOME"
        else
            log "WARNING: Could not reliably infer JAVA_HOME from java path: $JAVA_REAL_PATH. Structure doesn't match typical JDK/JRE. JAVA_HOME remains unset by this script."
            if [ -d "/usr/lib/jvm/default-java" ]; then
                export JAVA_HOME="/usr/lib/jvm/default-java"
                log "Fallback: Set JAVA_HOME to /usr/lib/jvm/default-java"
            fi
        fi
    else
        log "WARNING: 'java' command not found in PATH. JAVA_HOME cannot be set by this script."
    fi
else
    log "JAVA_HOME is already set to: $JAVA_HOME"
fi

if [ $# -lt 20 ]; then
    log "ERROR: Insufficient arguments provided. Expected 20, got $#."
    log "Usage: $0 <run_name> <input_csv> <outdir_base> <genome> <tools> <step> <profile> <aligner> <intervals> <dbsnp> <known_indels> <pon> <joint_germline> <wes> <trim_fastq> <skip_qc> <skip_annotation> <skip_baserecalibrator> <is_rerun> <job_id_suffix>"
    exit 1
fi

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
job_id_suffix_arg="${20}"

log "Validating required arguments..."
if [ -z "$run_name_input" ]; then log "ERROR: Missing required argument: run_name_input (Argument #1)" >&2; exit 1; fi
if [ -z "$input_csv" ]; then log "ERROR: Missing required argument: input_csv (Argument #2)" >&2; exit 1; fi
if [ -z "$outdir_base" ]; then log "ERROR: Missing required argument: outdir_base (Argument #3)" >&2; exit 1; fi
if [ -z "$genome" ]; then log "ERROR: Missing required argument: genome (Argument #4)" >&2; exit 1; fi

log "Run Name (Input): $run_name_input"
# ... (logging for other arguments remains the same) ...
log "Is Rerun: $is_rerun"
log "Job ID Suffix Arg: $job_id_suffix_arg"

final_sanitized_run_name=$(echo "$run_name_input" | sed 's/[^a-zA-Z0-9_-]/_/g')
if [ -z "$final_sanitized_run_name" ]; then
    log "ERROR: Sanitized run name is empty. Original was '$run_name_input'." >&2
    final_sanitized_run_name="unnamed_run_$(date +"%Y%m%d%H%M%S")"
fi
log "Final Sanitized Run Name (for dir): $final_sanitized_run_name"

log "Determining project root and artifact directories..."
SCRIPT_CWD=$(pwd)
PROJECT_ROOT_ABS=$(realpath "${SCRIPT_CWD}/../../")
log "Script current working directory (from where sarek_pipeline.sh is run): ${SCRIPT_CWD}"
log "Project root identified as: ${PROJECT_ROOT_ABS}"

NEXTFLOW_RUN_ARTIFACTS_DIR="${PROJECT_ROOT_ABS}/nextflow_run_artifacts"
NEXTFLOW_CONFIG_DIR="${NEXTFLOW_RUN_ARTIFACTS_DIR}/config"
NEXTFLOW_WORK_BASE_DIR="${NEXTFLOW_RUN_ARTIFACTS_DIR}/work"
NEXTFLOW_LOG_BASE_DIR="${NEXTFLOW_RUN_ARTIFACTS_DIR}/logs"

log "Ensuring Nextflow artifact directories exist under ${NEXTFLOW_RUN_ARTIFACTS_DIR}..."
mkdir -p "$NEXTFLOW_CONFIG_DIR" || { log "ERROR: Failed to create Nextflow config dir: $NEXTFLOW_CONFIG_DIR" >&2; exit 1; }
mkdir -p "$NEXTFLOW_WORK_BASE_DIR" || { log "ERROR: Failed to create Nextflow base work dir: $NEXTFLOW_WORK_BASE_DIR" >&2; exit 1; }
mkdir -p "$NEXTFLOW_LOG_BASE_DIR" || { log "ERROR: Failed to create Nextflow base log dir: $NEXTFLOW_LOG_BASE_DIR" >&2; exit 1; }

NEXTFLOW_CONFIG_FILE="${NEXTFLOW_CONFIG_DIR}/default_sarek.config"
log "Using Nextflow config file: ${NEXTFLOW_CONFIG_FILE}"
if [ ! -f "$NEXTFLOW_CONFIG_FILE" ]; then log "ERROR: Nextflow config file not found at ${NEXTFLOW_CONFIG_FILE}" >&2; exit 1; fi
if [ ! -r "$NEXTFLOW_CONFIG_FILE" ]; then log "ERROR: Nextflow config file not readable at ${NEXTFLOW_CONFIG_FILE}" >&2; exit 1; fi

log "Generating Sarek results directory name..."
if [ -n "$job_id_suffix_arg" ] && [ "$job_id_suffix_arg" != " " ] && [ "$job_id_suffix_arg" != "NOSUFF" ]; then
    RUN_SPECIFIC_IDENTIFIER="${final_sanitized_run_name}_${job_id_suffix_arg}"
else
    timestamp_fallback=$(date +"%Y%m%d%H%M%S")
    RUN_SPECIFIC_IDENTIFIER="${final_sanitized_run_name}_${timestamp_fallback}"
    log "WARNING: Job ID suffix problematic ('$job_id_suffix_arg'), using timestamp for uniqueness in folder/run name: ${RUN_SPECIFIC_IDENTIFIER}"
fi
log "Using RUN_SPECIFIC_IDENTIFIER for output directory and Nextflow run name: ${RUN_SPECIFIC_IDENTIFIER}"

results_dir_name="${RUN_SPECIFIC_IDENTIFIER}"
results_dir="${outdir_base}/${results_dir_name}" # This is the key variable for --outdir and -with-trace

mkdir -p "$results_dir"
if [ $? -ne 0 ]; then log "ERROR: Failed to create Sarek results directory: ${results_dir}. Check permissions for base: $outdir_base" >&2; exit 1; fi
if [ ! -w "$results_dir" ]; then log "ERROR: Sarek results directory (${results_dir}) is not writable by user $(whoami)." >&2; exit 1; fi
echo "Results directory: ${results_dir}" # This line is parsed by tasks.py
log "Successfully created Sarek results directory: ${results_dir}"

RUN_SPECIFIC_WORK_DIR="${NEXTFLOW_WORK_BASE_DIR}/${RUN_SPECIFIC_IDENTIFIER}"
RUN_SPECIFIC_LOG_FILE="${NEXTFLOW_LOG_BASE_DIR}/${RUN_SPECIFIC_IDENTIFIER}.nextflow.log"
log "Run-specific Nextflow work directory will be: ${RUN_SPECIFIC_WORK_DIR}"
log "Run-specific Nextflow log file will be: ${RUN_SPECIFIC_LOG_FILE}"
mkdir -p "$RUN_SPECIFIC_WORK_DIR" || { log "ERROR: Failed to create run-specific work dir: $RUN_SPECIFIC_WORK_DIR" >&2; exit 1; }

NXF_EXECUTABLE="/usr/local/bin/nextflow"

log "Building Nextflow command..."
cmd="$NXF_EXECUTABLE run nf-core/sarek -r 3.5.1"
cmd+=" --input \"${input_csv}\""
cmd+=" --outdir \"${results_dir}\"" # Sarek output directory
cmd+=" --genome \"${genome}\""
cmd+=" -c \"${NEXTFLOW_CONFIG_FILE}\""
cmd+=" -name \"${RUN_SPECIFIC_IDENTIFIER}\""

# <<< --- ADDED -with-trace OPTION --- >>>
# The trace file will be generated inside the Sarek results directory for this specific run.
cmd+=" -with-trace \"${results_dir}/execution_trace.txt\""
# <<< --- END ADDED OPTION --- >>>


export NXF_WORK="${RUN_SPECIFIC_WORK_DIR}"
export NXF_LOG_FILE="${RUN_SPECIFIC_LOG_FILE}"
log "Setting NXF_WORK=${NXF_WORK}"
log "Setting NXF_LOG_FILE=${NXF_LOG_FILE}"

if [ "$wes_flag" = "true" ]; then cmd+=" --wes"; fi
if [ "$skip_baserecalibrator_flag" = "true" ]; then cmd+=" --skip_tools baserecalibrator"; fi
if [ -n "$tools" ] && [ "$tools" != " " ]; then cmd+=" --tools \"${tools}\""; fi
if [ -n "$step" ] && [ "$step" != " " ]; then cmd+=" --step \"${step}\""; fi
effective_profile="${profile:-docker}"
if [ -n "$effective_profile" ] && [ "$effective_profile" != " " ]; then cmd+=" -profile \"${effective_profile}\""; fi
if [ -n "$aligner" ] && [ "$aligner" != " " ]; then cmd+=" --aligner \"${aligner}\""; fi
if [ -n "$intervals" ] && [ "$intervals" != " " ]; then cmd+=" --intervals \"${intervals}\""; fi
if [ -n "$dbsnp" ] && [ "$dbsnp" != " " ]; then cmd+=" --dbsnp \"${dbsnp}\""; fi
if [ -n "$known_indels" ] && [ "$known_indels" != " " ]; then cmd+=" --known_indels \"${known_indels}\""; fi
if [ -n "$pon" ] && [ "$pon" != " " ]; then cmd+=" --pon \"${pon}\""; fi
if [ "$joint_germline_flag" = "true" ]; then cmd+=" --joint_germline"; fi
if [ "$trim_fastq_flag" = "true" ]; then cmd+=" --trim_fastq"; fi
if [ "$skip_qc_flag" = "true" ]; then cmd+=" --skip_qc"; fi
if [ "$skip_annotation_flag" = "true" ]; then cmd+=" --skip_annotation"; fi
if [ "$is_rerun" = "true" ]; then cmd+=" -resume"; fi

# ... (Sanity Checks remain the same) ...
log "--- Worker Environment & Sanity Checks ---"
log "User: $(whoami) (UID: $(id -u))"
log "Current Directory (of script execution): $(pwd)"
log "PROJECT_ROOT_ABS (Determined): ${PROJECT_ROOT_ABS}"
log "NEXTFLOW_RUN_ARTIFACTS_DIR: ${NEXTFLOW_RUN_ARTIFACTS_DIR}"
log "PATH: $PATH"
log "JAVA_HOME: ${JAVA_HOME:-<not set by script or environment>}"
log "NXF_HOME (for assets/plugins): $NXF_HOME"
log "NXF_WORK (explicitly set for this run): $NXF_WORK"
log "NXF_LOG_FILE (explicitly set for this run): $NXF_LOG_FILE"
log "NXF_VER used in script: $(${NXF_EXECUTABLE} -v | head -n 1 || echo '<failed to get nextflow version>') "
log "Checking Java..."
if command -v java >/dev/null 2>&1; then log "Java Path: $(command -v java)"; log "Java Version: $(java -version 2>&1 | head -n 1)"; else log "ERROR: 'java' command not found in PATH ($PATH)" >&2; fi
log "Checking Nextflow executable..."
if [ -x "$NXF_EXECUTABLE" ]; then log "Nextflow executable found and is executable: $NXF_EXECUTABLE"; log "Nextflow Version Check Output:"; $NXF_EXECUTABLE -v || log "ERROR: 'nextflow -v' command failed using path $NXF_EXECUTABLE" >&2; else log "ERROR: Nextflow executable not found or not executable at $NXF_EXECUTABLE" >&2; exit 1; fi
log "Checking Input CSV..."
if [ -f "$input_csv" ] && [ -r "$input_csv" ]; then log "Input CSV found and readable: $input_csv"; else log "ERROR: Input CSV not found or not readable: $input_csv" >&2; ls -l "$input_csv"; exit 1; fi
log "Checking Nextflow Config File..."
if [ -f "$NEXTFLOW_CONFIG_FILE" ] && [ -r "$NEXTFLOW_CONFIG_FILE" ]; then log "Config file found and readable: $NEXTFLOW_CONFIG_FILE"; else log "ERROR: Config file not found or not readable: $NEXTFLOW_CONFIG_FILE" >&2; ls -l "$NEXTFLOW_CONFIG_FILE"; exit 1; fi
log "--- End Sanity Checks ---"


log "Executing Nextflow Command:"
log "$cmd"
COMMAND_LOG_FILE="${results_dir}/pipeline_execution_details.log"
echo "Timestamp: $(date)" > "${COMMAND_LOG_FILE}"
echo "Executing User: $(whoami) (UID: $(id -u))" >> "${COMMAND_LOG_FILE}"
echo "Working Directory (of script): $(pwd)" >> "${COMMAND_LOG_FILE}"
echo "Run Name (Input): ${run_name_input}" >> "${COMMAND_LOG_FILE}"
echo "Job ID Suffix: ${job_id_suffix_arg}" >> "${COMMAND_LOG_FILE}"
echo "RUN_SPECIFIC_IDENTIFIER (Folder/NF Run Name): ${RUN_SPECIFIC_IDENTIFIER}" >> "${COMMAND_LOG_FILE}"
echo "Results Directory: ${results_dir}" >> "${COMMAND_LOG_FILE}"
echo "NXF_WORK (run-specific): ${NXF_WORK}" >> "${COMMAND_LOG_FILE}"
echo "NXF_LOG_FILE (run-specific): ${RUN_SPECIFIC_LOG_FILE}" >> "${COMMAND_LOG_FILE}"
echo "JAVA_HOME (effective): ${JAVA_HOME:-<not set>}" >> "${COMMAND_LOG_FILE}"
echo "Nextflow Command: ${cmd}" >> "${COMMAND_LOG_FILE}"
echo "---------------------" >> "${COMMAND_LOG_FILE}"

{
    eval "$cmd"
} 2>&1 | tee -a "${COMMAND_LOG_FILE}"

exit_code=${PIPESTATUS[0]}

log "Nextflow command finished with exit code: ${exit_code}"
echo "---------------------" >> "${COMMAND_LOG_FILE}"
echo "Exit Code: ${exit_code}" >> "${COMMAND_LOG_FILE}"
echo "Finished: $(date)" >> "${COMMAND_LOG_FILE}"

if [ $exit_code -eq 0 ]; then
    log "Pipeline completed successfully (Exit Code 0)."
    echo "status::success"
    exit 0
else
    log "ERROR: Pipeline failed with exit code ${exit_code}" >&2
    echo "status::failed"
    exit ${exit_code}
fi
