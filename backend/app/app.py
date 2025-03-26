import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import List, Dict
import subprocess
from pydantic import BaseModel

app = FastAPI()

# Project root directory (adjust based on `main.py` location)
PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_APP_DIR = Path(__file__).parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"

# Ensure Jinja2Templates points to the correct path (still needed for /run_pipeline)
TEMPLATES_DIR = FRONTEND_DIR / "templates"
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
app.mount("/frontend", StaticFiles(directory=str(FRONTEND_DIR)), name="frontend_static")

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

@app.get("/", response_class=RedirectResponse)
async def main_page():
    """Redirects the root path to the frontend's index.html."""
    return RedirectResponse("/frontend/pages/index/index.html")

@app.get("/run_pipeline", response_class=HTMLResponse)
async def run_pipeline_page(request: Request):
    """Serves the Run Pipeline HTML page."""
    html_path = FRONTEND_DIR / "templates" / "pages" / "run_pipeline" / "run_pipeline.html"
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

connected_clients = set()
pipeline_process = None
pipeline_status = {"status": "idle", "current_file": "N/A", "progress": 0}

async def send_pipeline_status(status: Dict):
    for client in list(connected_clients):
        try:
            await client.send_json(status)
        except Exception:
            connected_clients.discard(client)

@app.websocket("/ws/pipeline_status")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    try:
        await send_pipeline_status(pipeline_status) # Send initial status on connection
        while True:
            await websocket.receive_text() # Keep connection alive
            # You might want to handle messages from the client here in the future
    except WebSocketDisconnect:
        connected_clients.remove(websocket)

async def run_pipeline_async(command: List[str]):
    global pipeline_process
    global pipeline_status
    pipeline_status["status"] = "running"
    pipeline_status["current_file"] = "Starting..."
    pipeline_status["progress"] = 0
    await send_pipeline_status(pipeline_status)
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    pipeline_process = process
    while True:
        if process.stdout.at_eof():
            break
        line = await process.stdout.readline()
        if line:
            print(f"Pipeline Output: {line.strip()}")
            if line.startswith("status::"):
                pipeline_status["current_file"] = line[len("status::"):].strip()
                await send_pipeline_status(pipeline_status)
            elif line.startswith("progress::"):
                try:
                    pipeline_status["progress"] = int(line[len("progress::"):].strip())
                    await send_pipeline_status(pipeline_status)
                except ValueError:
                    pass
        await asyncio.sleep(0.1)

    stdout, stderr = await process.communicate()
    if process.returncode == 0:
        pipeline_status["status"] = "idle"
        pipeline_status["current_file"] = "Finished"
        pipeline_status["progress"] = 100
    else:
        pipeline_status["status"] = "error"
        pipeline_status["current_file"] = "Error"
        print(f"Pipeline Error:\n{stderr}")
    await send_pipeline_status(pipeline_status)
    pipeline_process = None

@app.post("/run_pipeline")
async def trigger_pipeline(input_data: PipelineInput):
    global pipeline_process
    if pipeline_process is not None and pipeline_process.returncode is None:
        raise HTTPException(status_code=400, detail="Pipeline is already running.")

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

    asyncio.create_task(run_pipeline_async(command))
    return JSONResponse(content={"message": "Pipeline started in the background."})
