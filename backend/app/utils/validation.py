# backend/app/utils/validation.py
import logging
import csv
import tempfile
import os
import re # Import regex module
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from fastapi import HTTPException

# Import the updated model
from ..models.pipeline import PipelineInput, SampleInfo
# Import config (now pointing to host paths) and safe path function
from ..core.config import DATA_DIR, RESULTS_DIR, SAREK_DEFAULT_TOOLS, SAREK_DEFAULT_PROFILE, SAREK_DEFAULT_STEP, SAREK_DEFAULT_ALIGNER
from .files import get_safe_path

logger = logging.getLogger(__name__)

# --- Sarek 3.5.1 Valid Parameter Options ---
VALID_SAREK_TOOLS = ["strelka", "mutect2", "freebayes", "mpileup", "vardict", "manta", "cnvkit"]
VALID_SAREK_STEPS = ["mapping", "markduplicates", "prepare_recalibration", "recalibrate", "variant_calling", "annotation"]
VALID_SAREK_PROFILES = ["docker", "singularity", "conda", "podman", "test", "test_annotation", "test_tumor_only", "test_tumor_normal", "test_joint_germline"]
VALID_SAREK_ALIGNERS = ["bwa-mem", "dragmap"]
VALID_SAREK_GENOMES = [
    "GATK.GRCh37", "GATK.GRCh38", "Ensembl.GRCh37", "NCBI.GRCh38", "CHM13",
    "GRCm38", "TAIR10", "EB2", "UMD3.1", "WBcel235", "CanFam3.1", "GRCz10",
    "BDGP6", "EquCab2", "EB1", "Galgal4", "Gm01", "Mmul_1", "IRGSP-1.0",
    "CHIMP2.1.4", "Rnor_5.0", "Rnor_6.0", "R64-1-1", "EF2", "Sbi1",
    "Sscrofa10.2", "AGPv3", "hg38", "hg19", "mm10", "bosTau8", "ce10",
    "canFam3", "danRer10", "dm6", "equCab2", "galGal4", "panTro4", "rn6",
    "sacCer3", "susScr3", "testdata.nf-core.sarek"
]

# Regex for validating patient/sample IDs (no spaces)
NO_SPACES_REGEX = re.compile(r"^[^\s]+$")
# Allowed suffixes for intervals file
ALLOWED_INTERVAL_SUFFIXES = ['.bed', '.list', '.interval_list']
# Tools requiring tumor sample
SOMATIC_TOOLS_REQUIRING_TUMOR = ["mutect2", "strelka"] # Adjust if needed

# Updated function signature and return type
def validate_pipeline_input(input_data: PipelineInput) -> tuple[Dict[str, Optional[Path]], List[str]]:
    """
    Validates Sarek pipeline input files and parameters based on the PipelineInput model.
    Generates a temporary samplesheet CSV with direct HOST paths (since webapp/worker run locally).

    Returns:
        - A dictionary mapping logical file keys ('input_csv', 'intervals', 'dbsnp', etc.)
          to their validated absolute Path objects (or None if not provided/invalid).
          The 'input_csv' path is the path to the generated temporary CSV.
        - A list of validation error strings.
    Raises HTTPException for critical errors like inaccessible DATA_DIR.
    """
    validation_errors: List[str] = []
    paths_map: Dict[str, Optional[Path]] = {
        "input_csv": None,
        "intervals": None,
        "dbsnp": None,
        "known_indels": None,
        "pon": None,
    }
    temp_csv_file_path: Optional[str] = None
    has_tumor_sample_in_sheet = False # Flag to track if any tumor sample exists

    try:
        # Ensure DATA_DIR exists (now checks the host path)
        if not DATA_DIR.is_dir():
            logger.critical(f"CRITICAL: Data directory not found at configured path: {DATA_DIR}")
            raise HTTPException(status_code=500, detail=f"Server configuration error: Cannot access data directory {DATA_DIR}.")

        # --- Validate Sample Information and Prepare CSV Rows ---
        if not input_data.samples or len(input_data.samples) == 0:
            validation_errors.append("At least one sample must be provided.")
        else:
            sample_rows_for_csv = [] # Store rows with host paths for CSV
            for i, sample in enumerate(input_data.samples):

                # Validate Patient and Sample IDs for spaces
                if not sample.patient or not NO_SPACES_REGEX.match(sample.patient):
                    validation_errors.append(f"Sample #{i+1}: Patient ID '{sample.patient}' is invalid (cannot be empty or contain spaces).")
                if not sample.sample or not NO_SPACES_REGEX.match(sample.sample):
                     validation_errors.append(f"Sample #{i+1} (Patient '{sample.patient}'): Sample ID '{sample.sample}' is invalid (cannot be empty or contain spaces).")

                # *** ADDED: Validate Lane format ***
                if not sample.lane or not re.match(r"^L\d{3}$", sample.lane):
                    validation_errors.append(f"Sample #{i+1} (Patient '{sample.patient}'): Lane '{sample.lane}' is invalid (must be like L001).")
                # **********************************

                # Track if we have a tumor sample
                if sample.status == 1:
                    has_tumor_sample_in_sheet = True

                # Validate FASTQ files relative to the HOST DATA_DIR
                validated_fastq_1_host: Optional[Path] = None
                validated_fastq_2_host: Optional[Path] = None

                try:
                    validated_fastq_1_host = get_safe_path(DATA_DIR, sample.fastq_1)
                    if not validated_fastq_1_host.is_file():
                        validation_errors.append(f"Sample '{sample.sample}': FASTQ_1 file not found: {sample.fastq_1} (in {DATA_DIR})")
                except HTTPException as e:
                    validation_errors.append(f"Sample '{sample.sample}' FASTQ_1: {e.detail}")
                except Exception as e:
                    logger.error(f"Unexpected error validating FASTQ_1 file '{sample.fastq_1}' for sample '{sample.sample}': {e}")
                    validation_errors.append(f"Sample '{sample.sample}': Error validating FASTQ_1 file.")

                try:
                    validated_fastq_2_host = get_safe_path(DATA_DIR, sample.fastq_2)
                    if not validated_fastq_2_host.is_file():
                        validation_errors.append(f"Sample '{sample.sample}': FASTQ_2 file not found: {sample.fastq_2} (in {DATA_DIR})")
                except HTTPException as e:
                    validation_errors.append(f"Sample '{sample.sample}' FASTQ_2: {e.detail}")
                except Exception as e:
                    logger.error(f"Unexpected error validating FASTQ_2 file '{sample.fastq_2}' for sample '{sample.sample}': {e}")
                    validation_errors.append(f"Sample '{sample.sample}': Error validating FASTQ_2 file.")

                # Use HOST Paths for CSV
                fastq_1_path_for_csv = str(validated_fastq_1_host) if validated_fastq_1_host else sample.fastq_1
                fastq_2_path_for_csv = str(validated_fastq_2_host) if validated_fastq_2_host else sample.fastq_2

                # *** MODIFIED: Append sample.sex, sample.status, AND sample.lane ***
                sample_rows_for_csv.append([
                    sample.patient, sample.sample, sample.sex, sample.status, sample.lane, # Added lane
                    fastq_1_path_for_csv, fastq_2_path_for_csv
                ])
                # *********************************************************************

            # --- Create Samplesheet CSV ---
            if not validation_errors: # Only create if NO errors so far
                try:
                    with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv:
                        csv_writer = csv.writer(temp_csv)
                        # *** MODIFIED: Add 'sex', 'status', and 'lane' to header ***
                        csv_writer.writerow(['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2'])
                        # ***********************************************************
                        csv_writer.writerows(sample_rows_for_csv)
                        temp_csv_file_path = temp_csv.name
                        logger.info(f"Created temporary samplesheet CSV with host paths: {temp_csv_file_path}")
                        paths_map["input_csv"] = Path(temp_csv_file_path)
                except (OSError, csv.Error) as e:
                     logger.error(f"Failed to create temporary samplesheet CSV: {e}")
                     validation_errors.append("Internal server error: Could not create samplesheet.")
                     paths_map["input_csv"] = None
                     if temp_csv_file_path and os.path.exists(temp_csv_file_path):
                         os.remove(temp_csv_file_path)

        # --- Validate Optional Files (relative to HOST DATA_DIR) ---
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
                        validation_errors.append(f"{display_name} file not found: {filename} (in {DATA_DIR})")
                    else:
                        # Validate suffix for intervals file if provided
                        if key == "intervals" and file_path.suffix.lower() not in ALLOWED_INTERVAL_SUFFIXES:
                            validation_errors.append(f"{display_name} file must end with one of: {', '.join(ALLOWED_INTERVAL_SUFFIXES)}")
                        else:
                            paths_map[key] = file_path # Store validated host path
                except HTTPException as e:
                    validation_errors.append(f"{display_name}: {e.detail}")
                except Exception as e:
                    logger.error(f"Unexpected error validating {key} file '{filename}': {e}")
                    validation_errors.append(f"Error validating {display_name} file.")

        # --- Validate Sarek Parameters ---
        if not input_data.genome:
            validation_errors.append("Genome build must be specified.")
        elif input_data.genome not in VALID_SAREK_GENOMES:
             validation_errors.append(f"Invalid genome key specified: '{input_data.genome}'. Please choose a valid key (e.g., GATK.GRCh38, hg38).")

        selected_tools = []
        # *** Convert list back to comma-separated string for validation logic below ***
        tools_str = ",".join(input_data.tools) if input_data.tools else None
        if tools_str:
            selected_tools = [tool.strip() for tool in tools_str.split(",") if tool.strip()]
        # *****************************************************************************
            invalid_tools = [tool for tool in selected_tools if tool not in VALID_SAREK_TOOLS]
            if invalid_tools:
                validation_errors.append(f"Invalid tools specified: {', '.join(invalid_tools)}. Valid options are: {', '.join(VALID_SAREK_TOOLS)}")

        if input_data.step and input_data.step not in VALID_SAREK_STEPS:
            validation_errors.append(f"Invalid starting step specified: {input_data.step}. Valid options are: {', '.join(VALID_SAREK_STEPS)}")

        if input_data.profile and input_data.profile not in VALID_SAREK_PROFILES:
            validation_errors.append(f"Invalid profile specified: {input_data.profile}. Valid options include: {', '.join(VALID_SAREK_PROFILES)}")

        if input_data.aligner and input_data.aligner not in VALID_SAREK_ALIGNERS:
            validation_errors.append(f"Invalid aligner specified: {input_data.aligner}. Valid options are: {', '.join(VALID_SAREK_ALIGNERS)}")

        # *** Check for tumor sample if somatic tools selected ***
        somatic_callers_selected = any(tool in selected_tools for tool in SOMATIC_TOOLS_REQUIRING_TUMOR)
        if somatic_callers_selected and not has_tumor_sample_in_sheet:
            validation_errors.append(f"Selected tools ({', '.join(s for s in selected_tools if s in SOMATIC_TOOLS_REQUIRING_TUMOR)}) require at least one sample with Status=1 (Tumor).")
        # -------------------------------------------------------------


    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.exception(f"Unexpected error during input validation: {e}")
        validation_errors.append("An unexpected internal error occurred during validation.")

    # Check errors again *after* all validation steps
    if validation_errors:
        # If CSV was created but other errors occurred, clean it up
        if paths_map.get("input_csv") and paths_map["input_csv"].exists():
             try:
                 os.remove(paths_map["input_csv"])
                 logger.info(f"Cleaned up temporary CSV file due to validation errors: {paths_map['input_csv']}")
                 paths_map["input_csv"] = None # Nullify path in map
             except OSError as e:
                 logger.warning(f"Could not clean up temporary CSV file {paths_map['input_csv']}: {e}")
        # Raise HTTPException with accumulated errors
        error_message = "Validation errors:\n" + "\n".join(f"- {error}" for error in validation_errors)
        logger.warning(f"Validation failed: {error_message}")
        raise HTTPException(status_code=400, detail=error_message)


    # Return the map of validated HOST paths and an empty error list
    return paths_map, validation_errors
