from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import List, Dict
import subprocess
from pydantic import BaseModel

# Initialize FastAPI app
app = FastAPI()

# Project root directory (adjust based on `main.py` location)
PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_APP_DIR = Path(__file__).parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"

# Ensure Jinja2Templates points to the correct path
TEMPLATES_DIR = BACKEND_APP_DIR / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount the frontend directory to serve static files (CSS, JavaScript, HTML, etc.)
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

class PipelineInput(BaseModel):
    forward_reads_file: str
    reverse_reads_file: str
    reference_genome_file: str
    target_regions_file: str
    known_variants_file: str = None  # Optional

def get_directory_contents(directory: Path) -> List[Dict[str, str]]:
    """Retrieves a list of files and directories from the specified directory."""
    if not directory.exists():
        return# Return an empty list if the directory doesn't exist

    return [{"name": item.name, "type": "directory" if item.is_dir() else "file"} for item in directory.iterdir()]

@app.get("/", response_class=HTMLResponse)
async def main_page(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/run_pipeline", response_class=HTMLResponse)
async def run_pipeline_page():
    """Serves the Run Pipeline HTML page from the frontend directory."""
    html_path = FRONTEND_DIR / "pages" / "run_pipeline" / "run_pipeline.html"
    if not html_path.exists():
        raise HTTPException(status_code=404, detail="Run pipeline page not found.")
    with open(html_path, "r") as f:
        content = f.read()
    return HTMLResponse(content=content)

@app.get("/files", response_model=List[Dict[str, str]])
async def get_files():
    """Returns a list of files and directories in 'bioinformatics/data'."""
    data_dir = PROJECT_ROOT / "bioinformatics" / "data"
    return get_directory_contents(data_dir)

@app.get("/results", response_model=List[Dict[str, str]])
async def get_results():
    """Returns a list of files and directories in 'bioinformatics/results'."""
    results_dir = PROJECT_ROOT / "bioinformatics" / "results"
    return get_directory_contents(results_dir)

@app.post("/run_pipeline")
async def trigger_pipeline(input_data: PipelineInput):
    """Triggers the bioinformatics pipeline script with selected files."""
    pipeline_script_path = PROJECT_ROOT / "backend" / "app" / "pipeline.sh"
    data_dir = PROJECT_ROOT / "bioinformatics" / "data"

    forward_reads_path = data_dir / input_data.forward_reads_file
    reverse_reads_path = data_dir / input_data.reverse_reads_file
    reference_genome_path = data_dir / input_data.reference_genome_file
    target_regions_path = data_dir / input_data.target_regions_file
    known_variants_path = data_dir / input_data.known_variants_file if input_data.known_variants_file else ""

    if not pipeline_script_path.exists():
        raise HTTPException(status_code=500, detail=f"Pipeline script not found at {pipeline_script_path}")

    # Check if the selected files exist
    for path in [forward_reads_path, reverse_reads_path, reference_genome_path, target_regions_path]:
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"Input file not found: {path.name}")
    if known_variants_path and not Path(known_variants_path).exists():
        raise HTTPException(status_code=404, detail=f"Input file not found: {Path(known_variants_path).name}")

    command = [
        "bash",
        str(pipeline_script_path),
        str(forward_reads_path),
        str(reverse_reads_path),
        str(reference_genome_path),
        str(target_regions_path),
        str(known_variants_path),
    ]

    try:
        process = subprocess.run(command, capture_output=True, text=True, check=True)
        return JSONResponse(content={"message": "Pipeline executed successfully.", "stdout": process.stdout, "stderr": process.stderr})
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Pipeline execution failed: {e}")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="One or more input files not found (this might be due to an issue with constructing the path).")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An error occurred while running the pipeline: {e}")
