#-------------------------------------------------------------------
# Stage 1: Builder Stage
#-------------------------------------------------------------------
# Use Miniforge as the base image for building
FROM condaforge/mambaforge AS builder

# Set working directory
WORKDIR /build

# Install build-time dependencies (Git, Curl, Bash, Coreutils)
# Tar is no longer strictly needed for env creation, but kept for general utility
# Clean up apt cache in the same layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tar \
    curl \
    bash \
    coreutils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Clone the application repository ---
# Use ARGs for repo and branch, default branch set to 'main' as per workflow
ARG REPO_URL=https://github.com/mikha-22/bioinformatics-webapp.git
ARG BRANCH=main
RUN git clone --branch ${BRANCH} --depth 1 ${REPO_URL} /build/app \
    && rm -rf /build/app/.git # Remove .git folder immediately

# --- Create and Clean Conda Environment from YAML ---
# Uses mamba for faster environment creation from the YML file in the cloned repo
# Cleans the Conda cache afterwards to reduce layer size
# Assumes your conda_env.yml specifies 'name: bio-webapp'
RUN echo "Creating Conda environment 'bio-webapp' from YAML..." && \
    /opt/conda/bin/mamba env create -f /build/app/conda_env.yml && \
    echo "Cleaning Conda cache..." && \
    /opt/conda/bin/conda clean --all -y
    # No source tarball to remove

# --- Install File Browser ---
# Install File Browser using bash - it usually installs to /usr/local/bin
RUN echo "Installing File Browser..." && \
    curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | bash

# --- Prepare File Browser Config ---
# Create a temporary config directory and copy files from the repo
RUN mkdir -p /build/config_staging && \
    cp /build/app/docker/filebrowser.db /build/config_staging/filebrowser.db && \
    cp /build/app/docker/settings.json /build/config_staging/settings.json

#-------------------------------------------------------------------
# Stage 2: Final Stage
#-------------------------------------------------------------------
# Use the same base image for consistency
FROM condaforge/mambaforge

# Set required Conda environment variables
# Ensure the name here matches the 'name:' field in your conda_env.yml
ENV PATH="/opt/conda/envs/bio-webapp/bin:$PATH"
ENV CONDA_DEFAULT_ENV=bio-webapp

# Create necessary runtime directories (/app, /data, /config)
RUN mkdir -p /app /data /config

# Copy essential artifacts from the builder stage:
# 1. The created/cleaned Conda environment
# 2. The application code
# 3. The File Browser binary
# 4. The File Browser configuration
COPY --from=builder /opt/conda/envs/bio-webapp /opt/conda/envs/bio-webapp
COPY --from=builder /build/app /app
COPY --from=builder /usr/local/bin/filebrowser /usr/local/bin/filebrowser
COPY --from=builder /build/config_staging /config

# Ensure correct permissions for File Browser config
RUN chmod 664 /config/filebrowser.db /config/settings.json

# Set working directory for the application
WORKDIR /app

# Expose both application ports
EXPOSE 8000 8080

# Run both applications using the shell script
# Using absolute paths for robustness
CMD ["sh", "-c", "/opt/conda/envs/bio-webapp/bin/python /app/main.py & /usr/local/bin/filebrowser --database /config/filebrowser.db --config /config/settings.json --port 8080 --root /data"]
