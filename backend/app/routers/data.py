# backend/app/routers/data.py
import logging
import json
import os
import zipfile
import io
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse # Added StreamingResponse, FileResponse
from typing import List, Dict, Any, Generator, Optional # Added Generator, Optional
from pydantic import BaseModel # For parameter response model

# Import config and utils
from ..core.config import DATA_DIR, RESULTS_DIR
from ..utils.files import get_directory_contents, get_safe_path, get_filebrowser_config

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Data Access"] # Tag for OpenAPI docs
    # prefix="/api" # Prefix is added in app.py
)

# --- Models ---
# Define a model for the parameters response (can mirror JobMetaInputParams if desired)
class RunParametersResponse(BaseModel):
    input_filenames: Optional[Dict[str, Optional[str]]] = None
    sarek_params: Optional[Dict[str, Any]] = None
    sample_info: Optional[List[Dict[str, Any]]] = None
    # Add other fields if the metadata file contains more

# --- Helper Functions ---
def zip_directory_generator(directory: Path) -> Generator[bytes, None, None]:
    """ Generator function to stream a zip archive of a directory. """
    buffer = io.BytesIO()
    # Use compression for potentially large files
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zipf:
        for file_path in directory.rglob('*'): # Recursively glob all files/dirs
            if file_path.is_file():
                try:
                    # Calculate arcname relative to the directory being zipped
                    arcname = file_path.relative_to(directory).as_posix()
                    zipf.write(file_path, arcname=arcname)
                    # Yield the buffer content periodically to stream
                    # This simple approach yields after each file, might need optimization
                    buffer.seek(0)
                    yield buffer.read()
                    buffer.seek(0)
                    buffer.truncate() # Reset buffer for next chunk
                except Exception as e:
                     logger.warning(f"Error adding file {file_path} to zip: {e}")
                     # Optionally write an error marker to the zip?
                     # zipf.writestr(f"{arcname}.zip_error", f"Error adding file: {e}")

            elif file_path.is_dir() and not any(file_path.iterdir()):
                 # Add empty directories explicitly if needed
                 arcname = file_path.relative_to(directory).as_posix() + '/'
                 zipi = zipfile.ZipInfo(arcname)
                 zipi.external_attr = 0o40755 << 16 # drwxr-xr-x
                 zipf.writestr(zipi, '')

    # Yield any remaining data in the buffer
    buffer.seek(0)
    yield buffer.read()

# --- Existing Endpoints (Modified) ---

@router.get("/get_data", response_model=List[Dict[str, str]], summary="List Data Files")
async def get_data():
    """ Lists files (not directories) directly within the configured DATA_DIR. """
    if not DATA_DIR.exists() or not DATA_DIR.is_dir():
        logger.error(f"Configured DATA_DIR does not exist or is not a directory: {DATA_DIR}")
        raise HTTPException(status_code=500, detail="Server configuration error: Data directory not found.")

    fb_config = get_filebrowser_config()
    try:
        # Pass DATA_DIR as both directory_to_list and base_dir_for_relative_path
        contents = get_directory_contents(
            DATA_DIR, DATA_DIR, list_dirs=False, list_files=True, fb_base_url=fb_config["baseURL"]
        )
        response_data = [
            {"name": item.get("name", "Unknown"), "type": "file"}
            for item in contents if not item.get("is_dir") and "name" in item
        ]
        return response_data
    except HTTPException as e:
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
        return []

    # Pass RESULTS_DIR as both directory_to_list and base_dir_for_relative_path
    return get_directory_contents(RESULTS_DIR, RESULTS_DIR, list_dirs=True, list_files=False, fb_base_url=fb_config["baseURL"])


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

        if not target_run_dir.is_dir():
             logger.warning(f"Requested run directory not found or not a directory after validation: {target_run_dir}")
             raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")

    except HTTPException as e:
         raise e
    except Exception as e:
        logger.exception(f"Unexpected error validating path for run '{run_dir_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error during path validation.")

    # Pass target_run_dir as directory_to_list, and RESULTS_DIR as base_dir_for_relative_path
    return get_directory_contents(
        target_run_dir,
        RESULTS_DIR, # Base for relative paths calculation
        list_dirs=True,
        list_files=True,
        fb_base_url=fb_config["baseURL"]
    )

# --- New Endpoints ---

@router.get("/results/{run_dir_name:path}/parameters", response_model=RunParametersResponse, summary="Get Parameters for a Run")
async def get_run_parameters(run_dir_name: str):
    """
    Attempts to read and return the parameters used for a specific pipeline run
    from a metadata file (e.g., run_metadata.json) within the run directory.
    """
    logger.info(f"Request for parameters for run: '{run_dir_name}'")
    try:
        target_run_dir = get_safe_path(RESULTS_DIR, run_dir_name)
        if not target_run_dir.is_dir():
            raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")

        # --- Look for metadata file ---
        # Option A: Look for run_metadata.json (preferred, assumes task saves it)
        metadata_file = target_run_dir / "run_metadata.json"
        # Option B: Fallback to pipeline_command.log (more complex parsing needed)
        # command_log_file = target_run_dir / "pipeline_command.log"

        parameters = {}
        if metadata_file.is_file():
             try:
                 with open(metadata_file, 'r') as f:
                     # Assuming the file contains the same structure as JobMeta
                     data = json.load(f)
                     # Extract relevant parts for the response model
                     parameters = RunParametersResponse(
                         input_filenames=data.get("input_params"),
                         sarek_params=data.get("sarek_params"),
                         sample_info=data.get("sample_info")
                     ).model_dump(exclude_none=True) # Use model_dump for Pydantic v2

                 logger.info(f"Successfully loaded parameters from {metadata_file}")
                 return parameters
             except (json.JSONDecodeError, OSError, KeyError) as e:
                 logger.warning(f"Failed to read or parse parameters from {metadata_file}: {e}")
                 # Continue to potentially look for other sources or return empty

        # Add parsing logic for pipeline_command.log here if needed as a fallback

        # If no parameters found from any source
        logger.warning(f"No parameter metadata found for run '{run_dir_name}'")
        # Return empty object instead of 404, frontend can display "not found"
        return RunParametersResponse().model_dump()


    except HTTPException as e:
        raise e
    except Exception as e:
        logger.exception(f"Unexpected error fetching parameters for run '{run_dir_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error fetching run parameters.")


@router.get("/download_result/{run_dir_name:path}", summary="Download Run Directory as Zip")
async def download_result_run(run_dir_name: str):
    """
    Creates a zip archive of the specified run directory and streams the download.
    """
    logger.info(f"Request to download run directory: '{run_dir_name}'")
    try:
        target_run_dir = get_safe_path(RESULTS_DIR, run_dir_name)
        if not target_run_dir.is_dir():
            raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")

        # Create a safe filename for the download
        safe_filename = "".join(c if c.isalnum() or c in ['_', '-'] else '_' for c in run_dir_name) + ".zip"

        return StreamingResponse(
            zip_directory_generator(target_run_dir),
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename=\"{safe_filename}\""}
        )

    except HTTPException as e:
        raise e
    except Exception as e:
        logger.exception(f"Unexpected error creating zip for run '{run_dir_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error creating zip archive.")


@router.get("/download_file/{run_dir_name:path}/{file_path:path}", summary="Download Single Result File")
async def download_result_file(run_dir_name: str, file_path: str):
    """
    Downloads a specific file from within a run directory.
    """
    logger.info(f"Request to download file '{file_path}' from run '{run_dir_name}'")
    try:
        # First, validate the run directory itself exists within RESULTS_DIR
        target_run_dir = get_safe_path(RESULTS_DIR, run_dir_name)
        if not target_run_dir.is_dir():
            raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")

        # Second, validate the file path exists within the validated run directory
        target_file_path = get_safe_path(target_run_dir, file_path)
        if not target_file_path.is_file():
             raise HTTPException(status_code=404, detail=f"File '{file_path}' not found within run '{run_dir_name}'.")

        # Extract filename for Content-Disposition
        filename = target_file_path.name

        return FileResponse(
            path=target_file_path,
            filename=filename,
            media_type='application/octet-stream' # Generic type for download
        )

    except HTTPException as e:
        raise e
    except Exception as e:
        logger.exception(f"Unexpected error downloading file '{file_path}' from run '{run_dir_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error downloading file.")
