# backend/app/routers/data.py
import logging
import json
import os
import zipfile
import io
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse
from typing import List, Dict, Any, Generator, Optional
from pydantic import BaseModel

from ..core.config import DATA_DIR, RESULTS_DIR
from ..utils.files import get_directory_contents, get_safe_path, get_filebrowser_config
# Ensure models from pipeline are available if needed for type hinting or structure reference
# from ..models.pipeline import SampleInfo as PipelineSampleInfo, InputFilenames as PipelineInputFilenames, SarekParams as PipelineSarekParams

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Data Access"]
)

# --- Models ---
class RunParametersResponse(BaseModel):
    run_name: Optional[str] = None # <<< NEW
    run_description: Optional[str] = None # <<< NEW
    input_filenames: Optional[Dict[str, Optional[str]]] = None # Corresponds to InputFilenames in types.ts
    sarek_params: Optional[Dict[str, Any]] = None # Corresponds to SarekParams in types.ts
    sample_info: Optional[List[Dict[str, Any]]] = None # Corresponds to SampleInfo[] in types.ts
    # Add other fields if the metadata file contains more, like input_type, staged_job_id_origin etc.
    input_type: Optional[str] = None
    staged_job_id_origin: Optional[str] = None
    original_job_id: Optional[str] = None
    is_rerun_execution: Optional[bool] = None
    input_csv_path_used: Optional[str] = None


# --- Helper Functions ---
def zip_directory_generator(directory: Path) -> Generator[bytes, None, None]:
    """ Generator function to stream a zip archive of a directory. """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zipf:
        for file_path in directory.rglob('*'):
            if file_path.is_file():
                try:
                    arcname = file_path.relative_to(directory).as_posix()
                    zipf.write(file_path, arcname=arcname)
                    buffer.seek(0)
                    yield buffer.read()
                    buffer.seek(0)
                    buffer.truncate()
                except Exception as e:
                     logger.warning(f"Error adding file {file_path} to zip: {e}")
            elif file_path.is_dir() and not any(file_path.iterdir()):
                 arcname = file_path.relative_to(directory).as_posix() + '/'
                 zipi = zipfile.ZipInfo(arcname)
                 zipi.external_attr = 0o40755 << 16
                 zipf.writestr(zipi, '')
    buffer.seek(0)
    yield buffer.read()

# --- Existing Endpoints (Modified) ---

@router.get("/get_data", response_model=List[Dict[str, str]], summary="List Data Files")
async def get_data():
    if not DATA_DIR.exists() or not DATA_DIR.is_dir():
        logger.error(f"Configured DATA_DIR does not exist or is not a directory: {DATA_DIR}")
        raise HTTPException(status_code=500, detail="Server configuration error: Data directory not found.")
    fb_config = get_filebrowser_config()
    try:
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
    if not RESULTS_DIR.exists():
        logger.warning(f"Results directory not found: {RESULTS_DIR}. Returning empty list.")
        return []
    return get_directory_contents(RESULTS_DIR, RESULTS_DIR, list_dirs=True, list_files=False, fb_base_url=fb_config["baseURL"])


@router.get("/get_results/{run_dir_name:path}", response_model=List[Dict[str, Any]], summary="List Files in a Specific Run Directory")
async def get_results_run_files(run_dir_name: str, fb_config: Dict = Depends(get_filebrowser_config)):
    logger.info(f"Request to list files for run directory: '{run_dir_name}'")
    try:
        target_run_dir = get_safe_path(RESULTS_DIR, run_dir_name)
        if not target_run_dir.is_dir():
             logger.warning(f"Requested run directory not found or not a directory after validation: {target_run_dir}")
             raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")
    except HTTPException as e: raise e
    except Exception as e:
        logger.exception(f"Unexpected error validating path for run '{run_dir_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error during path validation.")
    return get_directory_contents(
        target_run_dir, RESULTS_DIR, list_dirs=True, list_files=True, fb_base_url=fb_config["baseURL"]
    )

# --- New Endpoints ---

@router.get("/results/{run_dir_name:path}/parameters", response_model=RunParametersResponse, summary="Get Parameters for a Run")
async def get_run_parameters(run_dir_name: str):
    logger.info(f"Request for parameters for run: '{run_dir_name}'")
    try:
        target_run_dir = get_safe_path(RESULTS_DIR, run_dir_name)
        if not target_run_dir.is_dir():
            raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")

        metadata_file = target_run_dir / "run_metadata.json" # Defined in tasks.py
        parameters = {}
        if metadata_file.is_file():
             try:
                 with open(metadata_file, 'r') as f:
                     data = json.load(f)
                     # Extract relevant parts for the response model
                     # The 'description' field in job.meta (which is run_description) will be used for run_description here
                     parameters = RunParametersResponse(
                         run_name=data.get("run_name"), # <<< GET run_name
                         run_description=data.get("description"), # <<< GET run_description (from job.meta.description)
                         input_filenames=data.get("input_params"),
                         sarek_params=data.get("sarek_params"),
                         sample_info=data.get("sample_info"),
                         input_type=data.get("input_type"),
                         staged_job_id_origin=data.get("staged_job_id_origin"),
                         original_job_id=data.get("original_job_id"),
                         is_rerun_execution=data.get("is_rerun_execution"),
                         input_csv_path_used=data.get("input_csv_path_used")
                     ).model_dump(exclude_none=True)
                 logger.info(f"Successfully loaded parameters from {metadata_file}")
                 return parameters
             except (json.JSONDecodeError, OSError, KeyError) as e:
                 logger.warning(f"Failed to read or parse parameters from {metadata_file}: {e}")
        logger.warning(f"No parameter metadata found for run '{run_dir_name}' or file was unreadable.")
        return RunParametersResponse().model_dump(exclude_none=True) # Return empty with exclude_none
    except HTTPException as e: raise e
    except Exception as e:
        logger.exception(f"Unexpected error fetching parameters for run '{run_dir_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error fetching run parameters.")


@router.get("/download_result/{run_dir_name:path}", summary="Download Run Directory as Zip")
async def download_result_run(run_dir_name: str):
    logger.info(f"Request to download run directory: '{run_dir_name}'")
    try:
        target_run_dir = get_safe_path(RESULTS_DIR, run_dir_name)
        if not target_run_dir.is_dir():
            raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")
        safe_filename = "".join(c if c.isalnum() or c in ['_', '-'] else '_' for c in run_dir_name) + ".zip"
        return StreamingResponse(
            zip_directory_generator(target_run_dir),
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename=\"{safe_filename}\""}
        )
    except HTTPException as e: raise e
    except Exception as e:
        logger.exception(f"Unexpected error creating zip for run '{run_dir_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error creating zip archive.")


@router.get("/download_file/{run_dir_name:path}/{file_path:path}", summary="Download Single Result File")
async def download_result_file(run_dir_name: str, file_path: str):
    logger.info(f"Request to download file '{file_path}' from run '{run_dir_name}'")
    try:
        target_run_dir = get_safe_path(RESULTS_DIR, run_dir_name)
        if not target_run_dir.is_dir():
            raise HTTPException(status_code=404, detail=f"Run directory '{run_dir_name}' not found.")
        target_file_path = get_safe_path(target_run_dir, file_path)
        if not target_file_path.is_file():
             raise HTTPException(status_code=404, detail=f"File '{file_path}' not found within run '{run_dir_name}'.")
        filename = target_file_path.name
        return FileResponse(
            path=target_file_path,
            filename=filename,
            media_type='application/octet-stream'
        )
    except HTTPException as e: raise e
    except Exception as e:
        logger.exception(f"Unexpected error downloading file '{file_path}' from run '{run_dir_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error downloading file.")
