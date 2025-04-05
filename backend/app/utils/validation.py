# backend/app/utils/validation.py
import logging
import csv
import tempfile
import os
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from fastapi import HTTPException

from ..models.pipeline import PipelineInput, SampleInfo
from ..core.config import DATA_DIR, SAREK_DEFAULT_TOOLS, SAREK_DEFAULT_PROFILE, SAREK_DEFAULT_STEP
from .files import get_safe_path

logger = logging.getLogger(__name__)

def validate_pipeline_input(input_data: PipelineInput) -> tuple[Dict[str, Path], Optional[str], List[str]]:
    """
    Validates Sarek pipeline input files and parameters.
    Returns:
        - A dictionary mapping logical names to validated absolute Path objects
        - The validated absolute path string for known variants (or None)
        - A list of validation error strings
    Raises HTTPException for critical errors.
    """
    validation_errors: List[str] = []
    paths_map: Dict[str, Path] = {}
    known_variants_path_str: Optional[str] = None
    input_csv_path_str: Optional[str] = None

    try:
        # Ensure DATA_DIR exists
        if not DATA_DIR.is_dir():
            logger.critical(f"CRITICAL: Data directory not found at configured path: {DATA_DIR}")
            raise HTTPException(status_code=500, detail="Server configuration error: Cannot access data directory.")

        # --- Validate Required Files ---
        # Validate reference genome file
        try:
            reference_genome_path = get_safe_path(DATA_DIR, input_data.reference_genome_file)
            if not reference_genome_path.is_file():
                validation_errors.append(f"Reference genome file not found: {input_data.reference_genome_file}")
            else:
                paths_map["reference_genome"] = reference_genome_path
        except HTTPException as e:
            validation_errors.append(f"Reference genome: {e.detail}")
        except Exception as e:
            logger.error(f"Unexpected error validating reference genome file '{input_data.reference_genome_file}': {e}")
            validation_errors.append(f"Error validating reference genome file.")

        # --- Validate Sample Information ---
        if not input_data.samples or len(input_data.samples) == 0:
            validation_errors.append("At least one sample must be provided.")
        else:
            # Create a temporary CSV file with the sample information
            with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as temp_csv:
                csv_writer = csv.writer(temp_csv)
                # Write header
                csv_writer.writerow(['patient', 'sample', 'sex', 'status', 'fastq_1', 'fastq_2'])
                
                # Write sample data
                for sample in input_data.samples:
                    # Validate FASTQ files
                    try:
                        fastq_1_path = get_safe_path(DATA_DIR, sample.fastq_1)
                        if not fastq_1_path.is_file():
                            validation_errors.append(f"FASTQ_1 file not found for sample {sample.sample}: {sample.fastq_1}")
                        else:
                            # Use the validated path in the CSV
                            fastq_1_path_str = str(fastq_1_path)
                    except HTTPException as e:
                        validation_errors.append(f"FASTQ_1 for sample {sample.sample}: {e.detail}")
                        fastq_1_path_str = sample.fastq_1  # Use original path for CSV
                    except Exception as e:
                        logger.error(f"Unexpected error validating FASTQ_1 file '{sample.fastq_1}': {e}")
                        validation_errors.append(f"Error validating FASTQ_1 file for sample {sample.sample}.")
                        fastq_1_path_str = sample.fastq_1  # Use original path for CSV
                    
                    try:
                        fastq_2_path = get_safe_path(DATA_DIR, sample.fastq_2)
                        if not fastq_2_path.is_file():
                            validation_errors.append(f"FASTQ_2 file not found for sample {sample.sample}: {sample.fastq_2}")
                        else:
                            # Use the validated path in the CSV
                            fastq_2_path_str = str(fastq_2_path)
                    except HTTPException as e:
                        validation_errors.append(f"FASTQ_2 for sample {sample.sample}: {e.detail}")
                        fastq_2_path_str = sample.fastq_2  # Use original path for CSV
                    except Exception as e:
                        logger.error(f"Unexpected error validating FASTQ_2 file '{sample.fastq_2}': {e}")
                        validation_errors.append(f"Error validating FASTQ_2 file for sample {sample.sample}.")
                        fastq_2_path_str = sample.fastq_2  # Use original path for CSV
                    
                    # Write sample row to CSV
                    csv_writer.writerow([
                        sample.patient,
                        sample.sample,
                        sample.sex,
                        sample.status,
                        fastq_1_path_str,
                        fastq_2_path_str
                    ])
                
                # Get the path of the temporary CSV file
                input_csv_path_str = temp_csv.name
                logger.info(f"Created temporary CSV file: {input_csv_path_str}")
                
                # Add the CSV file to the paths map
                paths_map["input_csv"] = Path(input_csv_path_str)

        # --- Validate Optional Files ---
        optional_files_map = {
            "intervals": input_data.intervals_file,
            "known_variants": input_data.known_variants_file
        }
        optional_display_names = {
            "intervals": "Intervals",
            "known_variants": "Known variants"
        }

        for key, filename in optional_files_map.items():
            if filename and filename.strip().lower() not in ["", "none"]:
                try:
                    file_path = get_safe_path(DATA_DIR, filename)
                    if not file_path.is_file():
                        validation_errors.append(f"{optional_display_names[key]} file not found: {filename}")
                    else:
                        paths_map[key] = file_path
                        if key == "known_variants":
                            known_variants_path_str = str(file_path)
                except HTTPException as e:
                    validation_errors.append(f"{optional_display_names[key]}: {e.detail}")
                except Exception as e:
                    logger.error(f"Unexpected error validating {key} file '{filename}': {e}")
                    validation_errors.append(f"Error validating {optional_display_names[key]} file.")

        # --- Validate Sarek Parameters ---
        # Validate genome
        if not input_data.genome:
            validation_errors.append("Genome build must be specified.")
        elif not isinstance(input_data.genome, str):
            validation_errors.append("Genome build must be a string.")

        # Validate tools
        if input_data.tools:
            tools_list = [tool.strip() for tool in input_data.tools.split(",")]
            valid_tools = ["strelka", "mutect2", "freebayes", "mpileup", "vardict", "manta", "cnvkit"]
            invalid_tools = [tool for tool in tools_list if tool not in valid_tools]
            if invalid_tools:
                validation_errors.append(f"Invalid tools specified: {', '.join(invalid_tools)}. Valid options are: {', '.join(valid_tools)}")

        # Validate step
        if input_data.step:
            valid_steps = ["mapping", "variant_calling", "annotation", "qc"]
            if input_data.step not in valid_steps:
                validation_errors.append(f"Invalid step specified: {input_data.step}. Valid options are: {', '.join(valid_steps)}")

        # Validate profile
        if input_data.profile:
            valid_profiles = ["docker", "singularity", "conda", "podman"]
            if input_data.profile not in valid_profiles:
                validation_errors.append(f"Invalid profile specified: {input_data.profile}. Valid options are: {', '.join(valid_profiles)}")

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.exception(f"Unexpected error during input validation setup: {e}")
        raise HTTPException(status_code=500, detail="Internal server error during input validation.")

    return paths_map, known_variants_path_str, validation_errors
