#!/bin/bash

# Sarek Pipeline Wrapper Script
# This script wraps the Sarek Nextflow pipeline with progress reporting

# Required parameters
input_csv="$1"
outdir="$2"
genome="$3"
tools="$4"
step="$5"
profile="$6"

# Optional parameters
intervals="$7"
known_variants="$8"
joint_germline="$9"
wes="${10}"

# Validate required parameters
if [ -z "$input_csv" ] || [ -z "$outdir" ] || [ -z "$genome" ]; then
    echo "Error: Missing required parameters"
    echo "Usage: $0 <input_csv> <outdir> <genome> <tools> <step> <profile> [intervals] [known_variants] [joint_germline] [wes]"
    exit 1
fi

# Generate timestamped results directory
timestamp=$(date +"%Y%m%d_%H%M%S")
results_dir="${outdir}/sarek_run_${timestamp}"
mkdir -p "$results_dir"

# Build the Sarek command
cmd="nextflow run nf-core/sarek \
    --input ${input_csv} \
    --outdir ${results_dir} \
    --genome ${genome}"

# Add optional parameters if provided
if [ ! -z "$tools" ]; then
    cmd="${cmd} --tools ${tools}"
fi

if [ ! -z "$step" ]; then
    cmd="${cmd} --step ${step}"
fi

if [ ! -z "$profile" ]; then
    cmd="${cmd} -profile ${profile}"
fi

if [ ! -z "$intervals" ]; then
    cmd="${cmd} --intervals ${intervals}"
fi

if [ ! -z "$known_variants" ]; then
    cmd="${cmd} --known_variants ${known_variants}"
fi

if [ "$joint_germline" = "true" ]; then
    cmd="${cmd} --joint_germline"
fi

if [ "$wes" = "true" ]; then
    cmd="${cmd} --wes"
fi

# Add resume flag to allow resuming interrupted runs
cmd="${cmd} -resume"

# Execute the pipeline with progress reporting
echo "status::Starting Sarek pipeline"
echo "progress::5"
echo "Running command: ${cmd}" > "${results_dir}/pipeline_command.log"

# Run the pipeline and capture output
$cmd 2>&1 | while IFS= read -r line; do
    # Echo the line for logging
    echo "$line"
    
    # Check for progress indicators in Nextflow output
    if [[ $line == *"process > "* ]]; then
        # Extract process name and status
        process_name=$(echo "$line" | sed -n 's/.*process > \([^ ]*\).*/\1/p')
        if [ ! -z "$process_name" ]; then
            echo "status::Running ${process_name}"
            # Calculate approximate progress based on typical Sarek workflow
            case "$process_name" in
                "FASTQC")
                    echo "progress::10"
                    ;;
                "BWA_MEM")
                    echo "progress::20"
                    ;;
                "MARKDUPLICATES")
                    echo "progress::30"
                    ;;
                "BASERECALIBRATOR")
                    echo "progress::40"
                    ;;
                "APPLYBQSR")
                    echo "progress::50"
                    ;;
                "MUTECT2"|"STRELKA"|"FREEBAYES"|"HAPLOTYPECALLER")
                    echo "progress::60"
                    ;;
                "VEP"|"SNPEFF")
                    echo "progress::80"
                    ;;
                "MULTIQC")
                    echo "progress::90"
                    ;;
            esac
        fi
    fi
done

# Check if pipeline completed successfully
if [ ${PIPESTATUS[0]} -eq 0 ]; then
    echo "status::Pipeline completed successfully"
    echo "progress::100"
    echo "Results directory: ${results_dir}"
    exit 0
else
    echo "status::Pipeline failed"
    echo "progress::100"
    exit 1
fi 