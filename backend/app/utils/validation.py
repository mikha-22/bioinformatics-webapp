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

# --- MAPPING OF STEP TO EXPECTED INPUT TYPE ---
STEP_TO_INPUT_TYPE = {
    "mapping": "fastq",
    "markduplicates": "bam_cram",
    "prepare_recalibration": "bam_cram",
    "recalibrate": "bam_cram",
    "variant_calling": "bam_cram",
    "annotation": "vcf",
}

# Updated function signature and return type
def validate_pipeline_input(input_data: PipelineInput) -> tuple[Dict[str, Optional[Path]], List[str]]:
    """
    Validates Sarek pipeline input based on the PipelineInput model, including input_type and step consistency.
    Generates a temporary samplesheet CSV with direct HOST paths and the correct columns.

    Returns:
        - A dictionary mapping logical file keys ('input_csv', 'intervals', 'dbsnp', etc.)
          to their validated absolute Path objects (or None if not provided/invalid).
          The 'input_csv' path is the path to the generated temporary CSV.
        - A list of validation error strings.
    Raises HTTPException for critical errors.
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

    # --- Basic Input Type and Step Validation ---
    input_type = input_data.input_type
    step = input_data.step

    if input_type not in ["fastq", "bam_cram", "vcf"]:
        validation_errors.append(f"Invalid input_type specified: '{input_type}'. Must be 'fastq', 'bam_cram', or 'vcf'.")
    if step not in VALID_SAREK_STEPS:
         validation_errors.append(f"Invalid starting step specified: '{step}'. Valid options are: {', '.join(VALID_SAREK_STEPS)}")

    # --- Check Consistency between Input Type and Step ---
    expected_input_type = STEP_TO_INPUT_TYPE.get(step)
    if expected_input_type and input_type != expected_input_type:
        validation_errors.append(f"Input type '{input_type}' is not valid for starting step '{step}'. Expected input type: '{expected_input_type}'.")

    # --- Define Expected Samplesheet Headers based on Input Type ---
    csv_headers = []
    if input_type == "fastq":
        csv_headers = ['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2']
    elif input_type == "bam_cram":
        # Determine if using 'bam' or 'cram' based on first sample's file extension (basic check)
        first_file = input_data.samples[0].bam_cram if input_data.samples else None
        bam_cram_col = 'cram' if first_file and (first_file.endswith('.cram')) else 'bam'
        csv_headers = ['patient', 'sample', 'sex', 'status', bam_cram_col, 'index'] # Use 'index' for bai/crai
    elif input_type == "vcf":
        csv_headers = ['patient', 'sample', 'sex', 'status', 'vcf', 'index'] # Use 'index' for tbi
    else:
        # If input_type was invalid earlier, skip samplesheet generation
        pass

    try:
        # Ensure DATA_DIR exists
        if not DATA_DIR.is_dir():
            logger.critical(f"CRITICAL: Data directory not found at configured path: {DATA_DIR}")
            raise HTTPException(status_code=500, detail=f"Server configuration error: Cannot access data directory {DATA_DIR}.")

        # --- Validate Sample Information and Prepare CSV Rows ---
        if not input_data.samples or len(input_data.samples) == 0:
            validation_errors.append("At least one sample must be provided.")
        elif not csv_headers:
             # Error added during consistency check or invalid input_type
             pass # Don't add another error message here
        else:
            sample_rows_for_csv = [] # Store rows with host paths for CSV
            for i, sample in enumerate(input_data.samples):
                sample_id_str = f"Sample #{i+1} (Patient '{sample.patient}', Sample '{sample.sample}')"

                # --- Common Validations ---
                if not sample.patient or not NO_SPACES_REGEX.match(sample.patient):
                    validation_errors.append(f"{sample_id_str}: Patient ID '{sample.patient}' is invalid (cannot be empty or contain spaces).")
                if not sample.sample or not NO_SPACES_REGEX.match(sample.sample):
                     validation_errors.append(f"{sample_id_str}: Sample ID '{sample.sample}' is invalid (cannot be empty or contain spaces).")
                if sample.status not in [0, 1]:
                     validation_errors.append(f"{sample_id_str}: Status '{sample.status}' is invalid (must be 0 or 1).")
                if sample.sex not in ["XX", "XY", "X", "Y", "other"]:
                     validation_errors.append(f"{sample_id_str}: Sex '{sample.sex}' is invalid.")

                if sample.status == 1: has_tumor_sample_in_sheet = True

                # --- Type-Specific Validations and Row Prep ---
                row_data = [sample.patient, sample.sample, sample.sex, sample.status]
                validated_main_file_host: Optional[Path] = None
                validated_index_file_host: Optional[Path] = None

                if input_type == "fastq":
                    if not sample.lane or not re.match(r"^L\d{3}$", sample.lane):
                        validation_errors.append(f"{sample_id_str}: Lane '{sample.lane}' is invalid (must be like L001). Required for FASTQ input.")
                    if not sample.fastq_1 or not sample.fastq_2:
                         validation_errors.append(f"{sample_id_str}: Both fastq_1 and fastq_2 are required for FASTQ input.")
                    else:
                        try:
                            fq1_path = get_safe_path(DATA_DIR, sample.fastq_1)
                            if not fq1_path.is_file(): validation_errors.append(f"{sample_id_str}: FASTQ_1 file not found: {sample.fastq_1}")
                            else: validated_main_file_host = fq1_path # Use fq1 as main for row creation
                        except HTTPException as e: validation_errors.append(f"{sample_id_str} FASTQ_1: {e.detail}")
                        except Exception as e: logger.error(f"Unexpected error validating FASTQ_1 for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating FASTQ_1.")

                        try:
                            fq2_path = get_safe_path(DATA_DIR, sample.fastq_2)
                            if not fq2_path.is_file(): validation_errors.append(f"{sample_id_str}: FASTQ_2 file not found: {sample.fastq_2}")
                            else: validated_index_file_host = fq2_path # Use fq2 as index for row creation logic
                        except HTTPException as e: validation_errors.append(f"{sample_id_str} FASTQ_2: {e.detail}")
                        except Exception as e: logger.error(f"Unexpected error validating FASTQ_2 for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating FASTQ_2.")

                    row_data.extend([
                        sample.lane,
                        str(validated_main_file_host) if validated_main_file_host else sample.fastq_1,
                        str(validated_index_file_host) if validated_index_file_host else sample.fastq_2
                    ])

                elif input_type == "bam_cram":
                    if not sample.bam_cram:
                         validation_errors.append(f"{sample_id_str}: bam_cram file path is required for BAM/CRAM input.")
                    else:
                        try:
                            bam_path = get_safe_path(DATA_DIR, sample.bam_cram)
                            if not bam_path.is_file(): validation_errors.append(f"{sample_id_str}: BAM/CRAM file not found: {sample.bam_cram}")
                            elif not (bam_path.suffix == '.bam' or bam_path.suffix == '.cram'):
                                validation_errors.append(f"{sample_id_str}: File must be .bam or .cram: {sample.bam_cram}")
                            else: validated_main_file_host = bam_path
                        except HTTPException as e: validation_errors.append(f"{sample_id_str} BAM/CRAM: {e.detail}")
                        except Exception as e: logger.error(f"Unexpected error validating BAM/CRAM for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating BAM/CRAM file.")

                        # Validate index file (optional but recommended/required by Sarek)
                        if sample.index:
                            try:
                                idx_path = get_safe_path(DATA_DIR, sample.index)
                                if not idx_path.is_file(): validation_errors.append(f"{sample_id_str}: Index file not found: {sample.index}")
                                else: validated_index_file_host = idx_path
                            except HTTPException as e: validation_errors.append(f"{sample_id_str} Index: {e.detail}")
                            except Exception as e: logger.error(f"Unexpected error validating Index for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating Index file.")
                        elif validated_main_file_host and validated_main_file_host.suffix == '.cram':
                            validation_errors.append(f"{sample_id_str}: CRAM file requires a corresponding index file (.crai).")

                    row_data.extend([
                         str(validated_main_file_host) if validated_main_file_host else sample.bam_cram,
                         str(validated_index_file_host) if validated_index_file_host else (sample.index or '') # Pass empty string if None
                    ])

                elif input_type == "vcf":
                    if not sample.vcf:
                         validation_errors.append(f"{sample_id_str}: VCF file path is required for VCF input.")
                    else:
                        try:
                            vcf_path = get_safe_path(DATA_DIR, sample.vcf)
                            if not vcf_path.is_file(): validation_errors.append(f"{sample_id_str}: VCF file not found: {sample.vcf}")
                            elif not (vcf_path.suffix == '.vcf' or vcf_path.name.endswith('.vcf.gz')):
                                validation_errors.append(f"{sample_id_str}: File must be .vcf or .vcf.gz: {sample.vcf}")
                            else: validated_main_file_host = vcf_path
                        except HTTPException as e: validation_errors.append(f"{sample_id_str} VCF: {e.detail}")
                        except Exception as e: logger.error(f"Unexpected error validating VCF for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating VCF file.")

                        # Validate index file (optional but recommended/required by Sarek)
                        if sample.index:
                            try:
                                idx_path = get_safe_path(DATA_DIR, sample.index)
                                if not idx_path.is_file(): validation_errors.append(f"{sample_id_str}: Index file not found: {sample.index}")
                                elif not (idx_path.suffix == '.tbi' or idx_path.suffix == '.csi'):
                                     validation_errors.append(f"{sample_id_str}: VCF index file must be .tbi or .csi: {sample.index}")
                                else: validated_index_file_host = idx_path
                            except HTTPException as e: validation_errors.append(f"{sample_id_str} Index: {e.detail}")
                            except Exception as e: logger.error(f"Unexpected error validating Index for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating Index file.")
                        elif validated_main_file_host and validated_main_file_host.name.endswith('.vcf.gz'):
                             validation_errors.append(f"{sample_id_str}: Compressed VCF (.vcf.gz) requires a corresponding index file (.tbi).")

                    row_data.extend([
                         str(validated_main_file_host) if validated_main_file_host else sample.vcf,
                         str(validated_index_file_host) if validated_index_file_host else (sample.index or '') # Pass empty string if None
                    ])

                sample_rows_for_csv.append(row_data)

            # --- Create Samplesheet CSV ---
            if not validation_errors and csv_headers: # Only create if NO errors so far and headers defined
                try:
                    with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv:
                        csv_writer = csv.writer(temp_csv)
                        csv_writer.writerow(csv_headers) # Write dynamic headers
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

        # --- Validate Sarek Parameters (Consider Step/Input Type) ---
        if not input_data.genome:
            validation_errors.append("Genome build must be specified.")
        elif input_data.genome not in VALID_SAREK_GENOMES:
             validation_errors.append(f"Invalid genome key specified: '{input_data.genome}'. Please choose a valid key (e.g., GATK.GRCh38, hg38).")

        selected_tools = input_data.tools or []
        if selected_tools and step == "annotation":
             validation_errors.append(f"Variant calling tools ({', '.join(selected_tools)}) cannot be specified when starting from the 'annotation' step.")
        elif selected_tools:
            invalid_tools = [tool for tool in selected_tools if tool not in VALID_SAREK_TOOLS]
            if invalid_tools:
                validation_errors.append(f"Invalid tools specified: {', '.join(invalid_tools)}. Valid options are: {', '.join(VALID_SAREK_TOOLS)}")

        if input_data.profile and input_data.profile not in VALID_SAREK_PROFILES:
            validation_errors.append(f"Invalid profile specified: {input_data.profile}. Valid options include: {', '.join(VALID_SAREK_PROFILES)}")

        if input_data.aligner and input_type != "fastq":
             validation_errors.append(f"Aligner ('{input_data.aligner}') can only be specified when input type is 'fastq'.")
        elif input_data.aligner and input_data.aligner not in VALID_SAREK_ALIGNERS:
            validation_errors.append(f"Invalid aligner specified: {input_data.aligner}. Valid options are: {', '.join(VALID_SAREK_ALIGNERS)}")

        if input_data.trim_fastq and input_type != "fastq":
             validation_errors.append(f"'Trim FASTQ' can only be enabled when input type is 'fastq'.")

        if input_data.skip_baserecalibrator and step in ["variant_calling", "annotation"]:
             validation_errors.append(f"'Skip Base Recalibration' has no effect when starting at or after the 'variant_calling' step.")

        if input_data.skip_annotation and step == "annotation":
             validation_errors.append(f"'Skip Annotation' cannot be enabled when starting directly from the 'annotation' step.")

        # Check for tumor sample if somatic tools selected and starting before annotation
        somatic_callers_selected = any(tool in selected_tools for tool in SOMATIC_TOOLS_REQUIRING_TUMOR)
        if somatic_callers_selected and step != "annotation" and not has_tumor_sample_in_sheet:
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
