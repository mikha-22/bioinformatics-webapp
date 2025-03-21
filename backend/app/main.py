from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os
from typing import List, Dict

app = FastAPI()

# CORS middleware to allow cross-origin requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allows all methods
    allow_headers=["*"],  # Allows all headers
)

@app.get("/files", response_model=List[Dict[str, str]])
async def get_files():
    """
    Retrieves a list of files and directories from the 'bioinformatics/data' directory.
    """
    current_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(current_dir, "../../"))
    data_dir = os.path.join(project_root, "bioinformatics/data")

    try:
        items = os.listdir(data_dir)
        result = []
        for item in items:
            item_path = os.path.join(data_dir, item)
            if os.path.isfile(item_path):
                item_type = "file"
            elif os.path.isdir(item_path):
                item_type = "directory"
            else:
                item_type = "unknown"  # Handle other cases if needed

            result.append({"name": item, "type": item_type})
        return result
    except FileNotFoundError:
        return []  # Return an empty list if the directory doesn't exist

@app.get("/results", response_model=List[Dict[str, str]])
async def get_results():
    """
    Retrieves a list of files and directories from the 'bioinformatics/results' directory.
    """
    current_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(current_dir, "../../"))
    results_dir = os.path.join(project_root, "bioinformatics/results")

    try:
        items = os.listdir(results_dir)
        result = []
        for item in items:
            item_path = os.path.join(results_dir, item)
            if os.path.isfile(item_path):
                item_type = "file"
            elif os.path.isdir(item_path):
                item_type = "directory"
            else:
                item_type = "unknown"  # Handle other cases if needed

            result.append({"name": item, "type": item_type})
        return result
    except FileNotFoundError:
        return []  # Return an empty list if the directory doesn't exist
