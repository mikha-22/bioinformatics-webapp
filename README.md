# 🧬 Bioinformatics Web Application 🧬

This project provides a web application for bioinformatics analysis, featuring a user interface and integrated file management through File Browser.

## 📋 Prerequisites

Before running the application, ensure you have the following installed:

*   **Mamba  🐍:** A faster, drop-in replacement for conda.  You can install it using `conda install -n base -c conda-forge mamba`.
*   **Docker 🐳:**  Required for containerized deployment.  Follow the instructions on [Docker's website](https://docs.docker.com/get-docker/) to install it for your operating system.

## Getting Started 🚀

### Running the Web Application (Without Docker) 

If you want to run the web application directly (without Docker), follow these steps:

1.  **Create and activate the Conda environment:**

    ```bash
    mamba env create -f conda_env.yml
    mamba activate bio-webapp  # Replace "bio-webapp" with the actual environment name if different
    ```

2.  **Run the application:**

    ```bash
    python main.py
    ```

    This will start the web application. Open your browser and navigate to `http://127.0.0.1:8000` to access it.

### Running the Web Application with Docker

This is the recommended method for deployment, as it packages the application and its dependencies into a container, ensuring consistent behavior across different environments.

1.  **Pull the Docker image:**

    ```bash
    docker pull ghcr.io/mikha-22/bioinformatics-webapp:latest
    ```

2.  **Run the Docker container:**

    ```bash
    docker run --rm -p 8000:8000 -p 8080:8080 -v /path/to/your/bioinformatics:/data ghcr.io/mikha-22/bioinformatics-webapp:latest
    ```

    **Parameters :**

    *   `--rm`:  Removes the container automatically after it exits.
    *   `-p 8000:8000`: Maps port 8000 on your host machine to port 8000 inside the container (for the Uvicorn web application).
    *   `-p 8080:8080`: Maps port 8080 on your host machine to port 8080 inside the container (for the File Browser).
    *   `-v /path/to/your/bioinformatics:/data`:  **Important:**  Maps a directory on your host machine to the `/data` directory inside the container.  **Replace `/path/to/your/bioinformatics` with the actual path to your `bioinformatics` directory** (containing `data`, `logs`, and `results` subdirectories) on your system. This allows the web application to access and store data persistently.
    *   `ghcr.io/mikha-22/bioinformatics-webapp:latest`: Specifies the Docker image to run.

3.  **Access the application:**

    Open your web browser and navigate to `http://127.0.0.1:8000` to access the web application.  You can access the File Browser at `http://127.0.0.1:8080`.

## Project Structure
```
├── backend
│   └── app
├── bioinformatics
│   ├── data
│   ├── logs
│   └── results
├── CHANGELOG.MD
├── conda_env.yml
├── docker
│   ├── Dockerfile
│   ├── Dockerfile.backup_stable
│   ├── filebrowser.db
│   └── settings.json
├── frontend
│   ├── static
│   └── templates
├── main.py
└── README.md
```
