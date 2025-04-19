# backend/app/utils/validation.py
import logging
import csv
import tempfile
import os
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from fastapi import HTTPException

# Import the updated model
from ..models.pipeline import PipelineInput, SampleInfo
# Import config and safe path function
from ..core.config import DATA_DIR, SAREK_DEFAULT_TOOLS, SAREK_DEFAULT_PROFILE, SAREK_DEFAULT_STEP, SAREK_DEFAULT_ALIGNER
from .files import get_safe_path

logger = logging.getLogger(__name__)

# --- Sarek 3.5.1 Valid Parameter Options ---
# (Keep these updated based on the specific Sarek version)
VALID_SAREK_TOOLS = ["strelka", "mutect2", "freebayes", "mpileup", "vardict", "manta", "cnvkit"]
VALID_SAREK_STEPS = ["mapping", "markduplicates", "prepare_recalibration", "recalibrate", "variant_calling", "annotation", "qc"]
VALID_SAREK_PROFILES = ["docker", "singularity", "conda", "podman", "test", "test_annotation", "test_tumor_only", "test_tumor_normal", "test_joint_germline"] # Added test profiles
VALID_SAREK_ALIGNERS = ["bwa-mem", "dragmap"]
VALID_SAREK_GENOMES = ["GRCh37", "GRCh38", "hg19", "hg38", "CanFam3.1"] # Add more as needed

# Updated function signature and return type
def validate_pipeline_input(input_data: PipelineInput) -> tuple[Dict[str, Optional[Path]], List[str]]:
    """
    Validates Sarek pipeline input files and parameters based on the PipelineInput model.
    Generates a temporary samplesheet CSV.

    Returns:
        - A dictionary mapping logical file keys ('input_csv', 'intervals', 'dbsnp', etc.)
          to their validated absolute Path objects (or None if not provided/invalid).
        - A list of validation error strings.
    Raises HTTPException for critical errors like inaccessible DATA_DIR.
    """
    validation_errors: List[str] = []
    # Initialize paths map with None for optional files
    paths_map: Dict[str, Optional[Path]] = {
        "input_csv": None,
        "intervals": None,
        "dbsnp": None,
        "known_indels": None,
        "pon": None,
    }
    temp_csv_file_path: Optional[str] = None

    try:
        # Ensure DATA_DIR exists
        if not DATA_DIR.is_dir():
            logger.critical(f"CRITICAL: Data directory not found at configured path: {DATA_DIR}")
            raise HTTPException(status_code=500, detail="Server configuration error: Cannot access data directory.")

        # --- Validate Sample Information and Create Samplesheet ---
        if not input_data.samples or len(input_data.samples) == 0:
            validation_errors.append("At least one sample must be provided.")
        else:
            sample_rows = []
            for i, sample in enumerate(input_data.samples):
                # Validate FASTQ files for the current sample
                fastq_1_path_str = f"samples[{i}].fastq_1"
                fastq_2_path_str = f"samples[{i}].fastq_2"
                validated_fastq_1: Optional[Path] = None
                validated_fastq_2: Optional[Path] = None

                try:
                    validated_fastq_1 = get_safe_path(DATA_DIR, sample.fastq_1)
                    if not validated_fastq_1.is_file():
                        validation_errors.append(f"Sample '{sample.sample}': FASTQ_1 file not found: {sample.fastq_1}")
                except HTTPException as e:
                    validation_errors.append(f"Sample '{sample.sample}' FASTQ_1: {e.detail}")
                except Exception as e:
                    logger.error(f"Unexpected error validating FASTQ_1 file '{sample.fastq_1}' for sample '{sample.sample}': {e}")
                    validation_errors.append(f"Sample '{sample.sample}': Error validating FASTQ_1 file.")

                try:
                    validated_fastq_2 = get_safe_path(DATA_DIR, sample.fastq_2)
                    if not validated_fastq_2.is_file():
                        validation_errors.append(f"Sample '{sample.sample}': FASTQ_2 file not found: {sample.fastq_2}")
                except HTTPException as e:
                    validation_errors.append(f"Sample '{sample.sample}' FASTQ_2: {e.detail}")
                except Exception as e:
                    logger.error(f"Unexpected error validating FASTQ_2 file '{sample.fastq_2}' for sample '{sample.sample}': {e}")
                    validation_errors.append(f"Sample '{sample.sample}': Error validating FASTQ_2 file.")

                # Use validated paths if available, otherwise original path for CSV row consistency
                sample_rows.append([
                    sample.patient,
                    sample.sample,
                    sample.sex,
                    sample.status,
                    str(validated_fastq_1) if validated_fastq_1 else sample.fastq_1,
                    str(validated_fastq_2) if validated_fastq_2 else sample.fastq_2
                ])

            # If no validation errors occurred *during FASTQ path checks*, create the CSV
            if not any("FASTQ" in error for error in validation_errors):
                try:
                    # Create a temporary CSV file with the sample information
                    with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv:
                        csv_writer = csv.writer(temp_csv)
                        # Write header
                        csv_writer.writerow(['patient', 'sample', 'sex', 'status', 'fastq_1', 'fastq_2'])
                        # Write sample data rows
                        csv_writer.writerows(sample_rows)
                        # Get the path of the temporary CSV file
                        temp_csv_file_path = temp_csv.name
                        logger.info(f"Created temporary samplesheet CSV: {temp_csv_file_path}")
                        paths_map["input_csv"] = Path(temp_csv_file_path) # Store path object
                except (OSError, csv.Error) as e:
                     logger.error(f"Failed to create temporary samplesheet CSV: {e}")
                     validation_errors.append("Internal server error: Could not create samplesheet.")
                     # Ensure path map reflects failure
                     paths_map["input_csv"] = None
                     if temp_csv_file_path and os.path.exists(temp_csv_file_path):
                         os.remove(temp_csv_file_path) # Clean up partially written file

        # --- Validate Optional Files ---
        optional_files_map = {
            "intervals": (input_data.intervals_file, "Intervals"),
            "dbsnp": (input_data.dbsnp, "dbSNP"),
            "known_indels": (input_data.known_indels, "Known Indels"),
            "pon": (input_data.pon, "Panel of Normals"),
        }

        for key, (filename, display_name) in optional_files_map.items():
            if filename and filename.strip().lower() not in ["", "none"]:
                try:
                    file_path = get_safe_path(DATA_DIR, filename)
                    if not file_path.is_file():
                        validation_errors.append(f"{display_name} file not found: {filename}")
                    else:
                        paths_map[key] = file_path # Store validated Path object
                except HTTPException as e:
                    validation_errors.append(f"{display_name}: {e.detail}")
                except Exception as e:
                    logger.error(f"Unexpected error validating {key} file '{filename}': {e}")
                    validation_errors.append(f"Error validating {display_name} file.")

        # --- Validate Sarek Parameters ---
        # Validate genome
        if not input_data.genome:
            validation_errors.append("Genome build must be specified.")
        elif input_data.genome not in VALID_SAREK_GENOMES:
             validation_errors.append(f"Invalid genome specified: {input_data.genome}. Valid options include: {', '.join(VALID_SAREK_GENOMES)}")

        # Validate tools (if provided)
        if input_data.tools:
            tools_list = [tool.strip() for tool in input_data.tools.split(",") if tool.strip()]
            invalid_tools = [tool for tool in tools_list if tool not in VALID_SAREK_TOOLS]
            if invalid_tools:
                validation_errors.append(f"Invalid tools specified: {', '.join(invalid_tools)}. Valid options are: {', '.join(VALID_SAREK_TOOLS)}")

        # Validate step (if provided)
        if input_data.step and input_data.step not in VALID_SAREK_STEPS:
            validation_errors.append(f"Invalid step specified: {input_data.step}. Valid options are: {', '.join(VALID_SAREK_STEPS)}")

        # Validate profile (if provided)
        if input_data.profile and input_data.profile not in VALID_SAREK_PROFILES:
            validation_errors.append(f"Invalid profile specified: {input_data.profile}. Valid options include: {', '.join(VALID_SAREK_PROFILES)}")

        # Validate aligner (if provided)
        if input_data.aligner and input_data.aligner not in VALID_SAREK_ALIGNERS:
            validation_errors.append(f"Invalid aligner specified: {input_data.aligner}. Valid options are: {', '.join(VALID_SAREK_ALIGNERS)}")

        # Validate WES requires intervals
        if input_data.wes and not paths_map.get("intervals"):
            # Check if the error wasn't already added during file validation
            if not any("Intervals file not found" in err for err in validation_errors) and \
               not any("Intervals: Invalid" in err for err in validation_errors):
                validation_errors.append("Intervals file is required when WES is selected.")


    except HTTPException as http_exc:
        # If DATA_DIR validation fails, re-raise immediately
        raise http_exc
    except Exception as e:
        logger.exception(f"Unexpected error during input validation: {e}")
        # Catch-all for other unexpected issues
        validation_errors.append("An unexpected internal error occurred during validation.")

    # Return the map of validated paths and the list of errors
    return paths_map, validation_errors
