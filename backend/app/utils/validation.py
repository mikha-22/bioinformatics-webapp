# backend/app/utils/validation.py
import logging
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from fastapi import HTTPException

from ..models.pipeline import PipelineInput
from ..core.config import DATA_DIR, SAREK_DEFAULT_TOOLS, SAREK_DEFAULT_PROFILE
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

    try:
        # Ensure DATA_DIR exists
        if not DATA_DIR.is_dir():
            logger.critical(f"CRITICAL: Data directory not found at configured path: {DATA_DIR}")
            raise HTTPException(status_code=500, detail="Server configuration error: Cannot access data directory.")

        # --- Validate Required Files ---
        required_files_map = {
            "input_csv": input_data.input_csv_file,
            "reference_genome": input_data.reference_genome_file,
        }
        required_display_names = {
            "input_csv": "Input CSV",
            "reference_genome": "Reference Genome",
        }

        for key, filename in required_files_map.items():
            if not filename:
                validation_errors.append(f"{required_display_names[key]} file selection is missing.")
                continue
            try:
                file_path = get_safe_path(DATA_DIR, filename)
                if not file_path.is_file():
                    validation_errors.append(f"{required_display_names[key]} file not found: {filename}")
                else:
                    paths_map[key] = file_path
            except HTTPException as e:
                validation_errors.append(f"{required_display_names[key]}: {e.detail}")
            except Exception as e:
                logger.error(f"Unexpected error validating {key} file '{filename}': {e}")
                validation_errors.append(f"Error validating {required_display_names[key]} file.")

        # --- Validate Optional Files ---
        optional_files_map = {
            "intervals": input_data.intervals_file,
            "known_variants": input_data.known_variants_file,
        }
        optional_display_names = {
            "intervals": "Intervals",
            "known_variants": "Known Variants",
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
