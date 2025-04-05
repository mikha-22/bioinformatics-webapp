# backend/app/routers/data.py
import logging
from fastapi import APIRouter, Depends, HTTPException
from typing import List, Dict, Any

# Import config and utils
from ..core.config import DATA_DIR, RESULTS_DIR
from ..utils.files import get_directory_contents, get_safe_path, get_filebrowser_config

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Data Access"] # Tag for OpenAPI docs
    # prefix="/api" # Optional: Add a prefix like /api/get_data
)

@router.get("/get_data", response_model=List[Dict[str, str]], summary="List Data Files")
async def get_data():
    """ Lists files (not directories) directly within the configured DATA_DIR. """
    if not DATA_DIR.exists() or not DATA_DIR.is_dir():
        logger.error(f"Configured DATA_DIR does not exist or is not a directory: {DATA_DIR}")
        raise HTTPException(status_code=500, detail="Server configuration error: Data directory not found.")

    fb_config = get_filebrowser_config() # Get FB config for context if needed, though not used directly here
    try:
        # List only files directly in DATA_DIR
        contents = get_directory_contents(
            DATA_DIR, list_dirs=False, list_files=True, fb_base_url=fb_config["baseURL"]
        )
        # Simplify response to match expected model: List[Dict[str, str]] {'name': ..., 'type': 'file'}
        response_data = [
            {"name": item.get("name", "Unknown"), "type": "file"}
            for item in contents if not item.get("is_dir") and "name" in item # Ensure it's a file and has a name
        ]
        return response_data
    except HTTPException as e:
        # Re-raise HTTPExceptions from get_directory_contents (like 500 errors)
        logger.error(f"HTTPException processing /get_data: {e.detail}")
        raise e
    except Exception as e:
        logger.exception(f"Unexpected error listing data directory contents for /get_data: {e}")
        raise HTTPException(status_code=500, detail="Internal server error processing data list.")


@router.get("/get_results", response_model=List[Dict[str, Any]], summary="List Result Run Directories")
async def get_results_runs(fb_config: Dict = Depends(get_filebrowser_config)):
    """ Lists the subdirectories (pipeline runs) within the main RESULTS_DIR. """
    if not RESULTS_DIR.exists():
        logger.warning(f"Results directory not found: {RESULTS_DIR}. Returning empty list.")
        return [] # Return empty list, frontend should handle 'No results'

    # List only directories directly in RESULTS_DIR
    return get_directory_contents(RESULTS_DIR, list_dirs=True, list_files=False, fb_base_url=fb_config["baseURL"])


@router.get("/get_results/{run_dir_name:path}", response_model=List[Dict[str, Any]], summary="List Files in a Specific Run Directory")
async def get_results_run_files(run_dir_name: str, fb_config: Dict = Depends(get_filebrowser_config)):
    """
    Lists the files and subdirectories within a specific pipeline run directory.
    The run_dir_name is taken as a path segment.
    """
    logger.info(f"Request to list files for run directory: '{run_dir_name}'")
    try:
        # Validate the run_dir_name and resolve the full path safely within RESULTS_DIR
        target_run_dir = get_safe_path(RESULTS_DIR, run_dir_name)

        # Explicitly check if the resolved path exists *and* is a directory after validation
        if not target_run_dir.is_dir():
             logger.warning(f"Requested run directory not found or not a directory after validation: {target_run_dir}")
             raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")

    except HTTPException as e:
         # Re-raise validation errors (400, 404, 500) from get_safe_path or the is_dir check
         raise e
    except Exception as e:
        logger.exception(f"Unexpected error validating path for run '{run_dir_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error during path validation.")

    # List both files and directories within the specific run directory
    return get_directory_contents(target_run_dir, list_dirs=True, list_files=True, fb_base_url=fb_config["baseURL"])


@router.get("/files", response_model=List[Dict[str, str]], summary="List Files by Type")
async def get_files_by_type(type: str):
    """Lists files of a specific type from the data directory."""
    if not DATA_DIR.exists() or not DATA_DIR.is_dir():
        logger.error(f"Configured DATA_DIR does not exist or is not a directory: {DATA_DIR}")
        raise HTTPException(status_code=500, detail="Server configuration error: Data directory not found.")

    # Define file extensions for each type
    type_extensions = {
        'inputCsv': ['.csv'],
        'referenceGenome': ['.fa', '.fasta', '.fa.gz', '.fasta.gz'],
        'intervals': ['.bed'],
        'knownVariants': ['.vcf', '.vcf.gz']
    }

    if type not in type_extensions:
        raise HTTPException(status_code=400, detail=f"Invalid file type: {type}")

    try:
        # List files in DATA_DIR
        contents = get_directory_contents(
            DATA_DIR, 
            list_dirs=False, 
            list_files=True,
            file_extensions=type_extensions[type]
        )
        
        # Filter and format response
        response_data = [
            {"name": item.get("name", "Unknown"), "type": "file"}
            for item in contents 
            if not item.get("is_dir") and "name" in item
        ]
        return response_data
    except Exception as e:
        logger.exception(f"Error listing files of type {type}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error processing file list.")
