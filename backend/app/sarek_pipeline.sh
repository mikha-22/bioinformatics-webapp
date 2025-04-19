#!/bin/bash

# Sarek Pipeline Wrapper Script
# This script wraps the Sarek Nextflow pipeline with progress reporting

# --- Argument Parsing (Positional, MUST match order in tasks.py) ---
input_csv="$1"
outdir_base="$2"  # Base directory for output, not the final dir
genome="$3"
tools="$4"
step="$5"
profile="$6"
aligner="$7"      # New
intervals="$8"
dbsnp="$9"        # New
known_indels="${10}" # New
pon="${11}"        # New
joint_germline_flag="${12}" # New (passed as "true" or "false")
wes_flag="${13}"        # New (passed as "true" or "false")
trim_fastq_flag="${14}" # New (passed as "true" or "false")
skip_qc_flag="${15}"    # New (passed as "true" or "false")
skip_anno_flag="${16}" # New (passed as "true" or "false")

# --- Basic Validation ---
if [ -z "$input_csv" ] || [ -z "$outdir_base" ] || [ -z "$genome" ]; then
    echo "[ERROR] Missing required arguments: input_csv, outdir_base, or genome." >&2
    # List expected arguments based on the order above for debugging help
    echo "Usage: $0 <input_csv> <outdir_base> <genome> [tools] [step] [profile] [aligner] [intervals] [dbsnp] [known_indels] [pon] [joint_germline_flag] [wes_flag] [trim_fastq_flag] [skip_qc_flag] [skip_anno_flag]" >&2
    exit 1
fi

# --- Generate Timestamped Results Directory ---
timestamp=$(date +"%Y%m%d_%H%M%S")
# Optional: Include part of input name for better identification
csv_basename=$(basename "$input_csv" .csv)
# Create the final results directory inside the base directory
results_dir="${outdir_base}/sarek_run_${timestamp}_${csv_basename}"

# Attempt to create the directory
mkdir -p "$results_dir"
if [ $? -ne 0 ]; then
    echo "[ERROR] Failed to create results directory: ${results_dir}" >&2
    exit 1
fi
echo "Results directory: ${results_dir}" # Echo the final path for backend parsing

# --- Build the Sarek Command ---
# Use quotes around paths and potentially comma-separated values
cmd="nextflow run nf-core/sarek \
    --input \"${input_csv}\" \
    --outdir \"${results_dir}\" \
    --genome \"${genome}\""

# Add optional parameters only if they are not empty strings
[ ! -z "$tools" ] && cmd+=" --tools \"${tools}\""
[ ! -z "$step" ] && cmd+=" --step \"${step}\""
[ ! -z "$profile" ] && cmd+=" -profile \"${profile}\"" # Profile doesn't need quotes typically
[ ! -z "$aligner" ] && cmd+=" --aligner \"${aligner}\""
[ ! -z "$intervals" ] && cmd+=" --intervals \"${intervals}\""
[ ! -z "$dbsnp" ] && cmd+=" --dbsnp \"${dbsnp}\""
[ ! -z "$known_indels" ] && cmd+=" --known_indels \"${known_indels}\""
[ ! -z "$pon" ] && cmd+=" --pon \"${pon}\""

# Add boolean flags only if their value is "true"
[ "$joint_germline_flag" = "true" ] && cmd+=" --joint_germline"
[ "$wes_flag" = "true" ] && cmd+=" --wes"
[ "$trim_fastq_flag" = "true" ] && cmd+=" --trim_fastq"
[ "$skip_qc_flag" = "true" ] && cmd+=" --skip_qc"
[ "$skip_anno_flag" = "true" ] && cmd+=" --skip_annotation"

# Add resume flag to allow resuming interrupted runs
cmd+=" -resume"

# --- Execute the pipeline with progress reporting ---
echo "status::Starting Sarek pipeline"
echo "progress::5"
echo "Running command: ${cmd}" > "${results_dir}/pipeline_command.log"

# Run the pipeline and capture output for progress reporting
# Redirect stderr to stdout (2>&1) so the 'while read' loop captures both
# Use PIPESTATUS[0] to get the exit code of the `nextflow run` command, not the `while` loop
exec 5>&1 # Save original stdout
output=$($cmd 2>&1 | tee >(cat - >&5)) # Execute, tee output to saved stdout and capture in variable
exit_code=${PIPESTATUS[0]} # Get exit code of the nextflow command

# Process captured output for progress (can be less reliable with complex logs)
echo "$output" | while IFS= read -r line; do
    # Echo the line for debugging if needed (already tee'd to original stdout)
    # echo "$line" >&2 # Example debug logging to stderr

    # Check for progress indicators in Nextflow output (keep existing logic)
    if [[ $line == *"process > "* ]]; then
        process_name=$(echo "$line" | sed -n 's/.*process > \([^ ]*\).*/\1/p')
        if [ ! -z "$process_name" ]; then
            echo "status::Running ${process_name}"
            # Calculate approximate progress (adjust percentages if needed for Sarek 3.5.1)
            case "$process_name" in
                "FASTQC"|"TRIMGALORE") # Added TrimGalore
                    echo "progress::10" ;;
                "MAP_FASTQS_BWAMEM"|"MAP_FASTQS_DRAGMAP") # Updated aligner processes
                    echo "progress::20" ;;
                "MARKDUPLICATES"|"PREPARE_BQSR") # Combined steps
                    echo "progress::30" ;;
                "GATHER_BQSR_REPORTS"|"APPLYBQSR") # Combined steps
                    echo "progress::40" ;;
                "GATHER_PILEUPS"|"QUALIMAP_BAMQC")
                    echo "progress::50" ;;
                "MUTECT2"|"STRELKA"|"FREEBAYES"|"MANTA"|"CNVKIT"|"ASCAT") # Variant callers/CNV
                    echo "progress::60" ;;
                "MERGE_VARIANTS"|"BCFTOOLS_MERGE")
                    echo "progress::70" ;;
                "VEP"|"SNPEFF")
                    echo "progress::80" ;;
                "TABIX_ANNOTATED"|"CUSTOM_DUMPSOFTWAREVERSIONS")
                    echo "progress::90" ;;
                "MULTIQC")
                    echo "progress::95" ;; # Make MultiQC slightly later
            esac
        fi
    fi
done

# --- Check Final Status ---
if [ $exit_code -eq 0 ]; then
    echo "status::Pipeline completed successfully"
    echo "progress::100"
    # The results directory path was already echoed at the start
    exit 0
else
    echo "[ERROR] Pipeline failed with exit code ${exit_code}" >&2
    echo "status::Pipeline failed"
    echo "progress::100" # Report 100% even on failure for UI
    exit $exit_code # Exit with the actual error code
fi
