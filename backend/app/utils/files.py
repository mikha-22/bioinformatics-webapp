# backend/app/utils/files.py
import logging
import json
import os
import urllib.parse
from pathlib import Path
from typing import List, Dict, Any
from fastapi import HTTPException

# Import paths from config
from ..core.config import DOCKER_DIR, RESULTS_DIR

logger = logging.getLogger(__name__)

def get_filebrowser_config() -> Dict[str, Any]:
    """Loads File Browser base URL from settings.json"""
    settings_path = DOCKER_DIR / "settings.json"
    config = {"baseURL": "filebrowser"} # Default fallback, ensure no leading/trailing slashes internally
    try:
        if settings_path.is_file():
            with open(settings_path, 'r') as f:
                fb_settings = json.load(f)
                # Get baseURL, strip leading/trailing slashes for consistency
                base_url = fb_settings.get("baseURL", "/filebrowser").strip('/')
                # If the result is an empty string (e.g., baseURL was "/"), use the default
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
        raise HTTPException(status_code=400, detail="Requested path cannot be empty.")

    try:
        # Decode URL-encoded characters (like %20 for space)
        decoded_path_str = urllib.parse.unquote(requested_path_str)
        requested_path = Path(decoded_path_str)
    except Exception as e:
         logger.error(f"Error decoding requested path '{requested_path_str}': {e}")
         raise HTTPException(status_code=400, detail="Invalid encoding in requested path.")

    # Prevent absolute paths or paths starting with '..'
    if requested_path.is_absolute() or decoded_path_str.strip().startswith(".."):
        logger.warning(f"Attempted path traversal with absolute or '..' start: {requested_path_str}")
        raise HTTPException(status_code=400, detail="Invalid path requested (absolute or traversal).")

    # Prevent '..' components within the path
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
    # This protects against more complex symlink attacks or edge cases.
    try:
        # Check if base_dir is a parent of full_path or if they are the same
        is_within_base = base_dir.resolve() in full_path.parents or base_dir.resolve() == full_path
    except OSError as e:
         logger.error(f"OSError during path comparison for '{full_path}' against base '{base_dir}': {e}")
         raise HTTPException(status_code=500, detail="Server error during path validation.")


    if not is_within_base:
        logger.warning(f"Path traversal attempt: Resolved path '{full_path}' is outside base directory '{base_dir.resolve()}'. Original request: '{requested_path_str}'")
        raise HTTPException(status_code=400, detail="Invalid path requested (resolved outside base).")

    # Optional: Check if the final path actually exists (depends on use case)
    # if not full_path.exists():
    #     logger.warning(f"Requested path does not exist: {full_path}")
    #     raise HTTPException(status_code=404, detail="Requested resource not found.")

    return full_path


def get_directory_contents(
    directory: Path,
    list_dirs: bool = False,
    list_files: bool = False,
    fb_base_url: str = "filebrowser",
    file_extensions: List[str] = None
    ) -> List[Dict[str, Any]]:
    """
    Retrieves metadata for items in a directory.
    Uses get_safe_path internally if needed, but assumes 'directory' path is already trusted here.
    
    Args:
        directory: Path to the directory to list
        list_dirs: Whether to include directories in the results
        list_files: Whether to include files in the results
        fb_base_url: Base URL for File Browser links
        file_extensions: Optional list of file extensions to filter by (e.g., ['.txt', '.csv'])
    """
    items = []
    if not directory.is_dir():
        logger.warning(f"Directory not found or is not a directory: {directory}")
        return items

    try:
        # Sort: Directories first, then alphabetically ignoring case
        sorted_paths = sorted(
            list(directory.iterdir()),
            key=lambda p: (not p.is_dir(), p.name.lower())
        )

        for item_path in sorted_paths:
            try:
                stat_result = item_path.stat()
                is_dir = item_path.is_dir()

                # Skip if it's a file and doesn't match the extension filter
                if not is_dir and file_extensions:
                    if not any(item_path.name.lower().endswith(ext.lower()) for ext in file_extensions):
                        continue

                if (is_dir and list_dirs) or (not is_dir and list_files):
                    fb_link = None
                    if is_dir and list_dirs and directory.resolve() == RESULTS_DIR.resolve():
                        relative_path_to_fb_root = Path("results") / item_path.name
                        fb_link = f"/{fb_base_url}/files/{urllib.parse.quote(str(relative_path_to_fb_root))}"

                    item_info = {
                        "name": item_path.name,
                        "is_dir": is_dir,
                        "modified_time": stat_result.st_mtime,
                        "size": stat_result.st_size if not is_dir else None,
                        "extension": item_path.suffix.lower() if not is_dir else None,
                        "filebrowser_link": fb_link
                    }
                    items.append(item_info)

            except FileNotFoundError:
                logger.warning(f"Item '{item_path.name}' disappeared while listing directory '{directory}'. Skipping.")
                continue
            except OSError as stat_e:
                logger.error(f"Could not get stat info for item {item_path}: {stat_e}")
                items.append({
                    "name": item_path.name,
                    "is_dir": item_path.is_dir(),
                    "error": "Could not access item metadata."
                })
    except OSError as list_e:
        logger.error(f"Error reading directory {directory}: {list_e}")
        raise HTTPException(status_code=500, detail=f"Server error reading directory: {directory.name}") from list_e

    return items
