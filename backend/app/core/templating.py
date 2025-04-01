# backend/app/core/templating.py
import logging
from fastapi.templating import Jinja2Templates
from .config import TEMPLATES_DIR # Import the directory path from config

logger = logging.getLogger(__name__)

try:
    # Initialize the Jinja2Templates instance using the path from config
    templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
    logger.info(f"Jinja2 templates initialized successfully from: {TEMPLATES_DIR}")
except Exception as e:
    # Log the exception and raise a RuntimeError if initialization fails,
    # as templates are likely essential for the HTML pages.
    logger.exception(f"CRITICAL: Failed to initialize Jinja2 templates from {TEMPLATES_DIR}", exc_info=True)
    raise RuntimeError("Failed to initialize templates.") from e

# Optional: Dependency function if you prefer using Depends() in routes later
# def get_templates() -> Jinja2Templates:
#     """FastAPI dependency function to get the templates instance."""
#     return templates
