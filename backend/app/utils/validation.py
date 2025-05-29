# backend/app/utils/validation.py
import logging
import csv
import tempfile
import os
import re
import gzip # <<< ADDED
import shutil # <<< ADDED
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from fastapi import HTTPException

from ..models.pipeline import PipelineInput, SampleInfo
from ..core.config import DATA_DIR # RESULTS_DIR, SAREK_DEFAULT_TOOLS etc. are not directly used in this function but good to keep if other utils use them
from .files import get_safe_path

logger = logging.getLogger(__name__)

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
NO_SPACES_REGEX = re.compile(r"^[^\s]+$")
ALLOWED_INTERVAL_SUFFIXES = ['.bed', '.list', '.interval_list']
SOMATIC_TOOLS_REQUIRING_TUMOR = ["mutect2", "strelka"]
STEP_TO_INPUT_TYPE = {
    "mapping": "fastq",
    "markduplicates": "bam_cram",
    "prepare_recalibration": "bam_cram",
    "recalibrate": "bam_cram",
    "variant_calling": "bam_cram",
    "annotation": "vcf",
}

def validate_pipeline_input(input_data: PipelineInput) -> tuple[Dict[str, Optional[Path]], List[str]]:
    validation_errors: List[str] = []
    # Collect informational messages about auto-gzipping separately
    info_messages: List[str] = []
    paths_map: Dict[str, Optional[Path]] = {
        "input_csv": None, "intervals": None, "dbsnp": None,
        "known_indels": None, "pon": None,
    }
    temp_csv_file_path: Optional[str] = None
    has_tumor_sample_in_sheet = False

    input_type = input_data.input_type
    step = input_data.step

    if input_type not in ["fastq", "bam_cram", "vcf"]:
        validation_errors.append(f"Invalid input_type: '{input_type}'. Must be 'fastq', 'bam_cram', or 'vcf'.")
    if step not in VALID_SAREK_STEPS:
         validation_errors.append(f"Invalid starting step: '{step}'. Valid: {', '.join(VALID_SAREK_STEPS)}")

    expected_input_type = STEP_TO_INPUT_TYPE.get(step)
    if expected_input_type and input_type != expected_input_type:
        validation_errors.append(f"Input type '{input_type}' invalid for step '{step}'. Expected: '{expected_input_type}'.")

    csv_headers = []
    if input_type == "fastq":
        csv_headers = ['patient', 'sample', 'sex', 'status', 'lane', 'fastq_1', 'fastq_2']
    elif input_type == "bam_cram":
        first_file = input_data.samples[0].bam_cram if input_data.samples else None
        bam_cram_col = 'cram' if first_file and (first_file.endswith('.cram')) else 'bam'
        csv_headers = ['patient', 'sample', 'sex', 'status', bam_cram_col, 'index']
    elif input_type == "vcf":
        csv_headers = ['patient', 'sample', 'sex', 'status', 'vcf', 'index']

    try:
        if not DATA_DIR.is_dir():
            logger.critical(f"Data directory not found: {DATA_DIR}")
            raise HTTPException(status_code=500, detail=f"Server config error: Data directory missing.")

        if not input_data.samples:
            validation_errors.append("At least one sample must be provided.")
        elif not csv_headers:
             pass # Error already added
        else:
            sample_rows_for_csv = []
            for i, sample in enumerate(input_data.samples):
                sample_id_str = f"Sample #{i+1} (Patient '{sample.patient}', Sample '{sample.sample}')"

                if not sample.patient or not NO_SPACES_REGEX.match(sample.patient):
                    validation_errors.append(f"{sample_id_str}: Patient ID invalid.")
                if not sample.sample or not NO_SPACES_REGEX.match(sample.sample):
                     validation_errors.append(f"{sample_id_str}: Sample ID invalid.")
                if sample.status not in [0, 1]:
                     validation_errors.append(f"{sample_id_str}: Status invalid (0 or 1).")
                if sample.sex not in ["XX", "XY", "X", "Y", "other"]:
                     validation_errors.append(f"{sample_id_str}: Sex invalid.")
                if sample.status == 1: has_tumor_sample_in_sheet = True

                row_data = [sample.patient, sample.sample, sample.sex, sample.status]
                validated_main_file_host: Optional[Path] = None
                validated_index_file_host: Optional[Path] = None # Used for fastq_2 or actual index

                if input_type == "fastq":
                    if not sample.lane or not re.match(r"^L\d{3}$", sample.lane):
                        validation_errors.append(f"{sample_id_str}: Lane '{sample.lane}' invalid (e.g., L001).")
                    if not sample.fastq_1 or not sample.fastq_2:
                         validation_errors.append(f"{sample_id_str}: Both fastq_1 and fastq_2 required.")
                    else:
                        for fq_field, is_r1 in [('fastq_1', True), ('fastq_2', False)]:
                            original_path_str = getattr(sample, fq_field)
                            if not original_path_str: continue # Should be caught by above check

                            try:
                                abs_path = get_safe_path(DATA_DIR, original_path_str)
                                if not abs_path.is_file():
                                    validation_errors.append(f"{sample_id_str}: {fq_field.upper()} file not found: {original_path_str}")
                                    continue
                                
                                final_path_for_csv = abs_path
                                if abs_path.name.endswith(('.fastq', '.fq')):
                                    gz_path = abs_path.with_name(abs_path.name + '.gz')
                                    if not gz_path.exists():
                                        info_msg = f"{sample_id_str}: Auto-gzipping {original_path_str} to {gz_path.name}."
                                        logger.info(f"[Validation] {info_msg}")
                                        info_messages.append(info_msg) # Collect info message
                                        try:
                                            with open(abs_path, 'rb') as f_in, gzip.open(gz_path, 'wb') as f_out:
                                                shutil.copyfileobj(f_in, f_out)
                                            logger.info(f"[Validation] Successfully gzipped {abs_path} to {gz_path}")
                                            final_path_for_csv = gz_path
                                        except Exception as e_gzip:
                                            logger.error(f"[Validation] Failed to gzip {abs_path}: {e_gzip}")
                                            validation_errors.append(f"{sample_id_str}: Failed to auto-gzip {fq_field.upper()} file {original_path_str}.")
                                            final_path_for_csv = None # Mark as error
                                    else: # Gzipped version already exists
                                        logger.info(f"[Validation] Using existing gzipped file for {fq_field.upper()}: {gz_path}")
                                        final_path_for_csv = gz_path
                                elif not abs_path.name.endswith(('.fastq.gz', '.fq.gz')):
                                    validation_errors.append(f"{sample_id_str}: {fq_field.upper()} file '{original_path_str}' has unsupported extension.")
                                    final_path_for_csv = None

                                if final_path_for_csv:
                                    if is_r1: validated_main_file_host = final_path_for_csv
                                    else: validated_index_file_host = final_path_for_csv
                                else: # Error occurred
                                    if is_r1: validated_main_file_host = None
                                    else: validated_index_file_host = None
                                    
                            except HTTPException as e: validation_errors.append(f"{sample_id_str} {fq_field.upper()}: {e.detail}")
                            except Exception as e: logger.error(f"Unexpected error for {fq_field.upper()} of {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating {fq_field.upper()}.")
                    
                    row_data.extend([
                        sample.lane,
                        str(validated_main_file_host) if validated_main_file_host else sample.fastq_1,
                        str(validated_index_file_host) if validated_index_file_host else sample.fastq_2
                    ])
                elif input_type == "bam_cram":
                    # ... (BAM/CRAM logic remains the same) ...
                    if not sample.bam_cram:
                         validation_errors.append(f"{sample_id_str}: bam_cram file path is required.")
                    else:
                        try:
                            bam_path = get_safe_path(DATA_DIR, sample.bam_cram)
                            if not bam_path.is_file(): validation_errors.append(f"{sample_id_str}: BAM/CRAM file not found: {sample.bam_cram}")
                            elif not (bam_path.suffix == '.bam' or bam_path.suffix == '.cram'):
                                validation_errors.append(f"{sample_id_str}: File must be .bam or .cram: {sample.bam_cram}")
                            else: validated_main_file_host = bam_path
                        except HTTPException as e: validation_errors.append(f"{sample_id_str} BAM/CRAM: {e.detail}")
                        except Exception as e: logger.error(f"Unexpected error validating BAM/CRAM for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating BAM/CRAM file.")

                        if sample.index:
                            try:
                                idx_path = get_safe_path(DATA_DIR, sample.index)
                                if not idx_path.is_file(): validation_errors.append(f"{sample_id_str}: Index file not found: {sample.index}")
                                else: validated_index_file_host = idx_path
                            except HTTPException as e: validation_errors.append(f"{sample_id_str} Index: {e.detail}")
                            except Exception as e: logger.error(f"Unexpected error validating Index for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating Index file.")
                        elif validated_main_file_host and validated_main_file_host.suffix == '.cram':
                            validation_errors.append(f"{sample_id_str}: CRAM file requires a .crai index.")
                    row_data.extend([
                         str(validated_main_file_host) if validated_main_file_host else sample.bam_cram,
                         str(validated_index_file_host) if validated_index_file_host else (sample.index or '')
                    ])
                elif input_type == "vcf":
                    # ... (VCF logic remains the same) ...
                    if not sample.vcf:
                         validation_errors.append(f"{sample_id_str}: VCF file path is required.")
                    else:
                        try:
                            vcf_path = get_safe_path(DATA_DIR, sample.vcf)
                            if not vcf_path.is_file(): validation_errors.append(f"{sample_id_str}: VCF file not found: {sample.vcf}")
                            elif not (vcf_path.suffix == '.vcf' or vcf_path.name.endswith('.vcf.gz')):
                                validation_errors.append(f"{sample_id_str}: File must be .vcf or .vcf.gz: {sample.vcf}")
                            else: validated_main_file_host = vcf_path
                        except HTTPException as e: validation_errors.append(f"{sample_id_str} VCF: {e.detail}")
                        except Exception as e: logger.error(f"Unexpected error validating VCF for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating VCF file.")

                        if sample.index:
                            try:
                                idx_path = get_safe_path(DATA_DIR, sample.index)
                                if not idx_path.is_file(): validation_errors.append(f"{sample_id_str}: Index file not found: {sample.index}")
                                elif not (idx_path.suffix == '.tbi' or idx_path.suffix == '.csi'):
                                     validation_errors.append(f"{sample_id_str}: VCF index must be .tbi or .csi: {sample.index}")
                                else: validated_index_file_host = idx_path
                            except HTTPException as e: validation_errors.append(f"{sample_id_str} Index: {e.detail}")
                            except Exception as e: logger.error(f"Unexpected error validating Index for {sample_id_str}: {e}"); validation_errors.append(f"{sample_id_str}: Error validating Index file.")
                        elif validated_main_file_host and validated_main_file_host.name.endswith('.vcf.gz'):
                             validation_errors.append(f"{sample_id_str}: Compressed VCF (.vcf.gz) requires an index.")
                    row_data.extend([
                         str(validated_main_file_host) if validated_main_file_host else sample.vcf,
                         str(validated_index_file_host) if validated_index_file_host else (sample.index or '')
                    ])
                sample_rows_for_csv.append(row_data)

            if not validation_errors and csv_headers:
                try:
                    with tempfile.NamedTemporaryFile(mode='w', newline='', suffix='.csv', delete=False) as temp_csv:
                        csv_writer = csv.writer(temp_csv)
                        csv_writer.writerow(csv_headers)
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
                        if key == "intervals" and file_path.suffix.lower() not in ALLOWED_INTERVAL_SUFFIXES:
                            validation_errors.append(f"{display_name} file must end with: {', '.join(ALLOWED_INTERVAL_SUFFIXES)}")
                        else:
                            paths_map[key] = file_path
                except HTTPException as e: validation_errors.append(f"{display_name}: {e.detail}")
                except Exception as e: logger.error(f"Error validating {key} '{filename}': {e}"); validation_errors.append(f"Error validating {display_name} file.")

        if not input_data.genome:
            validation_errors.append("Genome build must be specified.")
        elif input_data.genome not in VALID_SAREK_GENOMES:
             validation_errors.append(f"Invalid genome: '{input_data.genome}'.")
        selected_tools = input_data.tools or []
        if selected_tools and step == "annotation":
             validation_errors.append(f"Tools ({', '.join(selected_tools)}) cannot be specified for 'annotation' step.")
        elif selected_tools:
            invalid_tools = [tool for tool in selected_tools if tool not in VALID_SAREK_TOOLS]
            if invalid_tools: validation_errors.append(f"Invalid tools: {', '.join(invalid_tools)}. Valid: {', '.join(VALID_SAREK_TOOLS)}")
        if input_data.profile and input_data.profile not in VALID_SAREK_PROFILES:
            validation_errors.append(f"Invalid profile: {input_data.profile}. Valid: {', '.join(VALID_SAREK_PROFILES)}")
        if input_data.aligner and input_type != "fastq":
             validation_errors.append(f"Aligner ('{input_data.aligner}') only for 'fastq' input.")
        elif input_data.aligner and input_data.aligner not in VALID_SAREK_ALIGNERS:
            validation_errors.append(f"Invalid aligner: {input_data.aligner}. Valid: {', '.join(VALID_SAREK_ALIGNERS)}")
        if input_data.trim_fastq and input_type != "fastq":
             validation_errors.append(f"'Trim FASTQ' only for 'fastq' input.")
        if input_data.skip_baserecalibrator and step in ["variant_calling", "annotation"]:
             validation_errors.append(f"'Skip Base Recalibration' no effect for step '{step}'.")
        if input_data.skip_annotation and step == "annotation":
             validation_errors.append(f"'Skip Annotation' cannot be enabled for 'annotation' step.")
        somatic_callers_selected = any(tool in selected_tools for tool in SOMATIC_TOOLS_REQUIRING_TUMOR)
        if somatic_callers_selected and step != "annotation" and not has_tumor_sample_in_sheet:
            validation_errors.append(f"Selected tools ({', '.join(s for s in selected_tools if s in SOMATIC_TOOLS_REQUIRING_TUMOR)}) require a Tumor sample (Status=1).")

    except HTTPException as http_exc: raise http_exc
    except Exception as e:
        logger.exception(f"Unexpected error during input validation: {e}")
        validation_errors.append("Unexpected internal error during validation.")

    if validation_errors:
        if paths_map.get("input_csv") and paths_map["input_csv"].exists(): # type: ignore
             try: os.remove(paths_map["input_csv"]) # type: ignore
             except OSError as e: logger.warning(f"Could not clean up temp CSV {paths_map['input_csv']}: {e}")
             paths_map["input_csv"] = None
        error_message = "Validation errors:\n" + "\n".join(f"- {error}" for error in validation_errors)
        if info_messages: # Prepend info messages if any
            error_message = "Info:\n" + "\n".join(f"- {info}" for info in info_messages) + "\n\n" + error_message
        logger.warning(f"Validation failed: {error_message}")
        raise HTTPException(status_code=400, detail=error_message)

    # If successful, but there were info messages (like auto-gzipping), we might want to return them
    # For now, the primary return is paths_map and an empty error list on success.
    # The info_messages are logged by the backend. If they need to go to frontend,
    # the return signature of this function or the API endpoint would need adjustment.
    # For simplicity, we'll assume backend logging is sufficient for these auto-corrections.

    return paths_map, validation_errors
