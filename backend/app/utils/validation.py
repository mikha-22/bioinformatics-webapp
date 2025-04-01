# backend/app/utils/validation.py
import logging
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from fastapi import HTTPException

from ..models.pipeline import PipelineInput
from ..core.config import DATA_DIR
from .files import get_safe_path # Use the safe path helper

logger = logging.getLogger(__name__)

def validate_pipeline_input(input_data: PipelineInput) -> tuple[Dict[str, Path], Optional[str], List[str]]:
    """
    Validates pipeline input files exist within DATA_DIR using safe paths.
    Returns:
        - A dictionary mapping logical names to validated absolute Path objects.
        - The validated absolute path string for known_variants (or None).
        - A list of user-friendly validation error strings.
    Raises HTTPException for critical errors like DATA_DIR missing or path traversal attempts.
    """
    validation_errors: List[str] = []
    paths_map: Dict[str, Path] = {}
    known_variants_path_str: Optional[str] = None

    try:
        # Ensure DATA_DIR exists before proceeding (critical server config check)
        if not DATA_DIR.is_dir():
            logger.critical(f"CRITICAL: Data directory not found at configured path: {DATA_DIR}")
            raise HTTPException(status_code=500, detail="Server configuration error: Cannot access data directory.")

        # --- Validate Required Files ---
        required_files_map = {
            "forward_reads": input_data.forward_reads_file,
            "reverse_reads": input_data.reverse_reads_file,
            "reference_genome": input_data.reference_genome_file,
            "target_regions": input_data.target_regions_file,
        }
        required_display_names = {
             "forward_reads": "Forward Reads",
             "reverse_reads": "Reverse Reads",
             "reference_genome": "Reference Genome",
             "target_regions": "Target Regions",
        }

        for key, filename in required_files_map.items():
            if not filename:
                 validation_errors.append(f"{required_display_names[key]} file selection is missing.")
                 continue
            try:
                file_path = get_safe_path(DATA_DIR, filename)
                if not file_path.is_file():
                    # Use original filename for user-friendly error
                    validation_errors.append(f"{required_display_names[key]} file not found: {filename}")
                else:
                    paths_map[key] = file_path
            except HTTPException as e:
                 # Catch errors from get_safe_path (e.g., 400 Bad Request for traversal)
                 validation_errors.append(f"{required_display_names[key]}: {e.detail}")
            except Exception as e:
                 logger.error(f"Unexpected error validating {key} file '{filename}': {e}")
                 validation_errors.append(f"Error validating {required_display_names[key]} file.")


        # --- Validate Optional Known Variants File ---
        if input_data.known_variants_file and input_data.known_variants_file.strip().lower() not in ["", "none"]:
             filename = input_data.known_variants_file
             try:
                file_path = get_safe_path(DATA_DIR, filename)
                if not file_path.is_file():
                    validation_errors.append(f"Known Variants file not found: {filename}")
                else:
                    paths_map["known_variants"] = file_path
                    known_variants_path_str = str(file_path) # Store the string path
             except HTTPException as e:
                 validation_errors.append(f"Known Variants: {e.detail}")
             except Exception as e:
                 logger.error(f"Unexpected error validating known_variants file '{filename}': {e}")
                 validation_errors.append("Error validating Known Variants file.")
        else:
             known_variants_path_str = None # Explicitly set to None if not provided or "None"

    except HTTPException as http_exc:
        # Re-raise critical HTTP exceptions (like the 500 for missing DATA_DIR)
        raise http_exc
    except Exception as e:
         # Catch any other unexpected errors during validation setup
         logger.exception(f"Unexpected error during input validation setup: {e}")
         # Use a generic error to avoid leaking internal details
         raise HTTPException(status_code=500, detail="Internal server error during input validation.")

    return paths_map, known_variants_path_str, validation_errors
