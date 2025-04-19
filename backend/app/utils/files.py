# backend/app/utils/files.py
import logging
import json
import os
import urllib.parse
from pathlib import Path
from typing import List, Dict, Any
from fastapi import HTTPException

# Import paths from config
from ..core.config import DOCKER_DIR, RESULTS_DIR, DATA_DIR # Added DATA_DIR

logger = logging.getLogger(__name__)

def get_filebrowser_config() -> Dict[str, Any]:
    """Loads File Browser base URL from settings.json"""
    settings_path = DOCKER_DIR / "settings.json"
    config = {"baseURL": "filebrowser"} # Default fallback
    try:
        if settings_path.is_file():
            with open(settings_path, 'r') as f:
                fb_settings = json.load(f)
                base_url = fb_settings.get("baseURL", "/filebrowser").strip('/')
                config["baseURL"] = base_url if base_url else "filebrowser"
            logger.info(f"Loaded File Browser config: baseURL='{config['baseURL']}'")
        else:
            logger.warning(f"File Browser settings not found at {settings_path}, using default baseURL '{config['baseURL']}'.")
    except (json.JSONDecodeError, OSError) as e:
        logger.error(f"Error reading File Browser settings: {e}, using default baseURL '{config['baseURL']}'.")
    return config

def get_safe_path(base_dir: Path, requested_path_str: str) -> Path:
    """
    Safely join a base directory and a requested path string, preventing path traversal.
    Decodes URL encoding from the requested path string.
    Raises HTTPException 400 for invalid or traversal attempts.
    Raises HTTPException 404 if the final path doesn't exist (optional check).
    """
    if not requested_path_str:
        # Allow empty path to refer to the base directory itself (e.g., for listing root)
        # But handle potential None or truly empty strings explicitly if needed elsewhere
        return base_dir.resolve() # Return resolved base if path is empty

    try:
        # Decode URL-encoded characters (like %20 for space)
        decoded_path_str = urllib.parse.unquote(requested_path_str)
        # Normalize path separators for the OS
        normalized_path_str = os.path.normpath(decoded_path_str)
        requested_path = Path(normalized_path_str)
    except Exception as e:
         logger.error(f"Error decoding/normalizing requested path '{requested_path_str}': {e}")
         raise HTTPException(status_code=400, detail="Invalid encoding or format in requested path.")

    # Prevent absolute paths or paths starting with known traversal patterns
    if requested_path.is_absolute() or normalized_path_str.strip().startswith(("..", "/")):
        logger.warning(f"Attempted path traversal with absolute or '..' start: {requested_path_str}")
        raise HTTPException(status_code=400, detail="Invalid path requested (absolute or traversal).")

    # Prevent '..' components within the path after normalization
    if '..' in requested_path.parts:
        logger.warning(f"Attempted path traversal with '..' component: {requested_path_str}")
        raise HTTPException(status_code=400, detail="Invalid path requested (contains '..').")

    # Resolve the full path (resolves symlinks, normalizes path)
    try:
        # Ensure base_dir exists and is a directory before resolving
        if not base_dir.is_dir():
             logger.error(f"Base directory '{base_dir}' does not exist or is not a directory.")
             raise HTTPException(status_code=500, detail="Server configuration error: Base directory invalid.")

        full_path = (base_dir / requested_path).resolve()
    except Exception as e:
         # Catch potential errors during resolution (e.g., path too long, permissions)
         logger.error(f"Error resolving path '{base_dir / requested_path}': {e}")
         raise HTTPException(status_code=400, detail="Invalid file name or path structure.")

    # Crucial check: Ensure the resolved path is *still* within the base directory.
    try:
        # Check if base_dir is a parent of full_path or if they are the same
        is_within_base = base_dir.resolve() in full_path.parents or base_dir.resolve() == full_path
    except OSError as e:
         logger.error(f"OSError during path comparison for '{full_path}' against base '{base_dir}': {e}")
         raise HTTPException(status_code=500, detail="Server error during path validation.")


    if not is_within_base:
        logger.warning(f"Path traversal attempt: Resolved path '{full_path}' is outside base directory '{base_dir.resolve()}'. Original request: '{requested_path_str}'")
        raise HTTPException(status_code=400, detail="Invalid path requested (resolved outside base).")

    # Optional: Check if the final path actually exists (depends on use case, can be done by caller)
    # if check_exists and not full_path.exists():
    #     logger.warning(f"Requested path does not exist: {full_path}")
    #     raise HTTPException(status_code=404, detail="Requested resource not found.")

    return full_path


# --- Updated get_directory_contents ---
def get_directory_contents(
    directory_to_list: Path, # The specific directory whose contents we want
    base_dir_for_relative_path: Path, # The top-level dir (e.g., RESULTS_DIR) for calculating relative paths
    list_dirs: bool = False,
    list_files: bool = False,
    fb_base_url: str = "filebrowser"
    ) -> List[Dict[str, Any]]:
    """
    Retrieves metadata for items in a directory, calculating relative paths.
    Assumes 'directory_to_list' path is already validated and exists.
    """
    items = []
    if not directory_to_list.is_dir():
        logger.warning(f"Directory not found or is not a directory: {directory_to_list}")
        return items # Return empty list if directory doesn't exist

    try:
        # Sort: Directories first, then alphabetically ignoring case
        sorted_paths = sorted(
            list(directory_to_list.iterdir()),
            key=lambda p: (not p.is_dir(), p.name.lower())
        )

        for item_path in sorted_paths:
            try:
                stat_result = item_path.stat() # Can raise FileNotFoundError if item disappears
                is_dir = item_path.is_dir() # Check type after stat

                if (is_dir and list_dirs) or (not is_dir and list_files):
                    fb_link = None
                    # --- Calculate relative path ---
                    # Use os.path.relpath for robust relative path calculation
                    try:
                        relative_path = os.path.relpath(item_path, base_dir_for_relative_path)
                        # Ensure consistent separators (e.g., use '/')
                        relative_path = Path(relative_path).as_posix()
                    except ValueError as e:
                        # This might happen if paths are on different drives on Windows
                        logger.error(f"Could not determine relative path for {item_path} from base {base_dir_for_relative_path}: {e}")
                        relative_path = item_path.name # Fallback to just the name

                    # Construct File Browser link IF it's a top-level directory listing for RESULTS_DIR
                    # Link construction logic might need adjustment based on FileBrowser root config
                    if directory_to_list.resolve() == RESULTS_DIR.resolve():
                         # Assumes File Browser root is '/srv' containing 'data' and 'results'
                         # fb_link target: /filebrowser/files/results/run_xyz or /filebrowser/files/results/run_xyz/subfolder
                         # The relative path needs to be prefixed with 'results/'
                         fb_target_path = Path("results") / relative_path # Use calculated relative path
                         # Ensure path separators are URL-friendly (forward slashes)
                         fb_link = f"/{fb_base_url}/files/{urllib.parse.quote(fb_target_path.as_posix())}"

                    item_info = {
                        "name": item_path.name,
                        "is_dir": is_dir,
                        "modified_time": stat_result.st_mtime, # Unix timestamp
                        "size": stat_result.st_size if not is_dir else None,
                        "extension": item_path.suffix.lower() if not is_dir else None,
                        "filebrowser_link": fb_link, # Include link if generated
                        "relative_path": relative_path # --- ADDED ---
                    }
                    items.append(item_info)

            except FileNotFoundError:
                logger.warning(f"Item '{item_path.name}' disappeared while listing directory '{directory_to_list}'. Skipping.")
                continue # Skip this item
            except OSError as stat_e:
                logger.error(f"Could not get stat info for item {item_path}: {stat_e}")
                items.append({
                    "name": item_path.name,
                    "is_dir": item_path.is_dir(), # Best guess
                    "error": "Could not access item metadata.",
                    "relative_path": item_path.name, # Fallback relative path
                })
    except OSError as list_e:
        logger.error(f"Error reading directory {directory_to_list}: {list_e}")
        raise HTTPException(status_code=500, detail=f"Server error reading directory: {directory_to_list.name}") from list_e

    return items
# --- End updated get_directory_contents ---
