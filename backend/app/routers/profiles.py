# backend/app/routers/profiles.py
import logging
import json
import re # For name validation
import redis
from fastapi import APIRouter, Depends, HTTPException, Body
from typing import List, Dict

from ..core.config import PIPELINE_PROFILES_KEY
from ..core.redis_rq import get_redis_connection
from ..models.pipeline import ProfileData, SaveProfileRequest # Import updated models

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["Profiles Management"], # Tag for OpenAPI docs
    prefix="/api/profiles"        # Prefix for all routes in this router
)

# Basic validation for profile names (alphanumeric, underscore, dash)
VALID_PROFILE_NAME_REGEX = re.compile(r"^[a-zA-Z0-9_\-]+$")
MAX_PROFILE_NAME_LENGTH = 50

@router.get("", response_model=List[str], summary="List Saved Profile Names")
async def list_profile_names(
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    """ Retrieves a list of all saved pipeline configuration profile names. """
    try:
        profile_names_bytes = redis_conn.hkeys(PIPELINE_PROFILES_KEY)
        profile_names = sorted([name.decode('utf-8') for name in profile_names_bytes])
        logger.info(f"Retrieved {len(profile_names)} profile names.")
        return profile_names
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error listing profiles: {e}")
        raise HTTPException(status_code=503, detail="Could not retrieve profiles due to storage error.")
    except Exception as e:
        logger.exception("Unexpected error listing profiles.")
        raise HTTPException(status_code=500, detail="Internal server error listing profiles.")

@router.get("/{profile_name}", response_model=ProfileData, summary="Get Profile Data")
async def get_profile_data(
    profile_name: str,
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    """ Retrieves the configuration data for a specific profile name. """
    logger.info(f"Attempting to retrieve profile data for: {profile_name}")
    if not VALID_PROFILE_NAME_REGEX.match(profile_name):
         raise HTTPException(status_code=400, detail="Invalid profile name format.")
    try:
        profile_data_json = redis_conn.hget(PIPELINE_PROFILES_KEY, profile_name)
        if profile_data_json is None:
            logger.warning(f"Profile '{profile_name}' not found.")
            raise HTTPException(status_code=404, detail=f"Profile '{profile_name}' not found.")

        profile_data = json.loads(profile_data_json.decode('utf-8'))
        logger.info(f"Successfully retrieved profile data for: {profile_name}")
        # Validate data against the model (includes step now)
        return ProfileData(**profile_data)
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error getting profile '{profile_name}': {e}")
        raise HTTPException(status_code=503, detail="Could not retrieve profile due to storage error.")
    except (json.JSONDecodeError, TypeError) as e:
        logger.error(f"Error decoding profile data for '{profile_name}': {e}")
        raise HTTPException(status_code=500, detail="Internal server error: Corrupted profile data.")
    except Exception as e:
        logger.exception(f"Unexpected error getting profile '{profile_name}'.")
        raise HTTPException(status_code=500, detail="Internal server error getting profile.")

@router.post("", status_code=201, summary="Save or Update Profile")
async def save_profile(
    payload: SaveProfileRequest = Body(...), # Use the request body model
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    """ Saves a new profile configuration or updates an existing one. """
    profile_name = payload.name
    profile_data = payload.data # This is ProfileData type, includes step

    logger.info(f"Attempting to save profile: {profile_name}")

    # Validate Name
    if not profile_name or not VALID_PROFILE_NAME_REGEX.match(profile_name):
        raise HTTPException(status_code=400, detail="Invalid profile name format. Use alphanumeric, underscore, or dash.")
    if len(profile_name) > MAX_PROFILE_NAME_LENGTH:
         raise HTTPException(status_code=400, detail=f"Profile name exceeds maximum length of {MAX_PROFILE_NAME_LENGTH} characters.")

    try:
        # ProfileData now includes step, which is saved
        profile_data_json = profile_data.model_dump_json(exclude_none=True) # Use model_dump_json for Pydantic v2

        # Use HSET (handles both create and update)
        redis_conn.hset(PIPELINE_PROFILES_KEY, profile_name, profile_data_json)
        logger.info(f"Successfully saved/updated profile: {profile_name}")
        return {"message": f"Profile '{profile_name}' saved successfully.", "profile_name": profile_name}
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error saving profile '{profile_name}': {e}")
        raise HTTPException(status_code=503, detail="Could not save profile due to storage error.")
    except Exception as e:
        logger.exception(f"Unexpected error saving profile '{profile_name}'.")
        raise HTTPException(status_code=500, detail="Internal server error saving profile.")

@router.delete("/{profile_name}", status_code=200, summary="Delete Profile")
async def delete_profile(
    profile_name: str,
    redis_conn: redis.Redis = Depends(get_redis_connection)
):
    """ Deletes a saved pipeline configuration profile. """
    logger.info(f"Attempting to delete profile: {profile_name}")
    if not VALID_PROFILE_NAME_REGEX.match(profile_name):
         raise HTTPException(status_code=400, detail="Invalid profile name format.")

    try:
        deleted_count = redis_conn.hdel(PIPELINE_PROFILES_KEY, profile_name)
        if deleted_count == 0:
            logger.warning(f"Profile '{profile_name}' not found for deletion.")
            raise HTTPException(status_code=404, detail=f"Profile '{profile_name}' not found.")

        logger.info(f"Successfully deleted profile: {profile_name}")
        return {"message": f"Profile '{profile_name}' deleted successfully.", "profile_name": profile_name}
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis error deleting profile '{profile_name}': {e}")
        raise HTTPException(status_code=503, detail="Could not delete profile due to storage error.")
    except Exception as e:
        logger.exception(f"Unexpected error deleting profile '{profile_name}'.")
        raise HTTPException(status_code=500, detail="Internal server error deleting profile.")
