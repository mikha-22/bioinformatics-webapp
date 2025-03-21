from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from pathlib import Path
from typing import List, Dict

# Initialize FastAPI app
app = FastAPI()

# Ensure Jinja2Templates points to the correct path
TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Project root directory (adjust based on `main.py` location)
PROJECT_ROOT = Path(__file__).resolve().parents[2]

def get_directory_contents(directory: Path) -> List[Dict[str, str]]:
    """Retrieves a list of files and directories from the specified directory."""
    if not directory.exists():
        return []  # Return an empty list if the directory doesn't exist

    return [{"name": item.name, "type": "directory" if item.is_dir() else "file"} for item in directory.iterdir()]

@app.get("/", response_class=HTMLResponse)
async def main_page(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

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
