# backend/app/routers/pages.py
import logging
from fastapi import APIRouter, Request, Depends
from fastapi.responses import HTMLResponse
# NOTE: No longer need to import Jinja2Templates directly here

# Import the initialized 'templates' instance from the new core location
from ..core.templating import templates
# Import necessary config values like RESULTS_DIR
from ..core.config import RESULTS_DIR

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["HTML Pages"], # Tag for OpenAPI documentation organization
    # prefix="/pages" # Optional: Add a prefix if you want routes like /pages/results
)

@router.get("/", response_class=HTMLResponse, summary="Serve Main Home Page")
async def main_page(request: Request):
    """Serves the main index.html page."""
    # Use the imported 'templates' object directly
    return templates.TemplateResponse("pages/index/index.html", {"request": request})

@router.get("/run_pipeline", response_class=HTMLResponse, summary="Serve Run Pipeline Page")
async def run_pipeline_page(request: Request):
    """Serves the page for staging a new pipeline run."""
    return templates.TemplateResponse("pages/run_pipeline/run_pipeline.html", {"request": request})

@router.get("/results", response_class=HTMLResponse, summary="Serve Results Page")
async def results_page(request: Request):
    """
    Serves the page listing completed pipeline runs.
    Ensures the base results directory exists.
    Accepts an optional 'highlight' query parameter.
    """
    try:
        # Ensure the results directory exists when the page is loaded.
        # This prevents errors if the directory hasn't been created yet.
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
         # Log an error if the directory can't be created or accessed,
         # but don't block the page load. The frontend JS should handle
         # the case where the /get_results endpoint returns an error or empty list.
         logger.error(f"Could not create or access results directory {RESULTS_DIR}: {e}")

    # Get the 'highlight' query parameter if provided in the URL (e.g., /results?highlight=run_xyz)
    highlight = request.query_params.get("highlight")

    # Render the template, passing the request context and the highlight parameter
    return templates.TemplateResponse(
        "pages/results/results.html",
        {"request": request, "highlight": highlight}
    )

@router.get("/jobs", response_class=HTMLResponse, summary="Serve Jobs Page")
async def jobs_page(request: Request):
    """Serves the jobs dashboard page."""
    return templates.TemplateResponse("pages/jobs/jobs.html", {"request": request})
