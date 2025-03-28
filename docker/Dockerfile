#-------------------------------------------------------------------
# Stage 1: Builder Stage
#-------------------------------------------------------------------
# Use Miniforge as the base image for building
FROM condaforge/mambaforge as builder

# Set working directory
WORKDIR /build

# Install build-time dependencies (Git, Tar, Curl, Coreutils)
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

# --- Setup and Clean Conda Environment ---
# Extract the environment from the tarball within the cloned repo
# IMPORTANT: Clean the Conda environment afterwards to remove caches/tarballs
# Clean up the source tarball as well
RUN mkdir -p /opt/conda/envs/ && \
    tar -xzf /build/app/docker/bio-webapp.tar.gz -C /opt/conda/envs/ && \
    echo "Running Conda clean..." && \
    /opt/conda/envs/bio-webapp/bin/conda clean --all -y && \
    # Alternative clean if the above path fails: /opt/conda/bin/conda clean --all -y
    echo "Removing source tarball..." && \
    rm /build/app/docker/bio-webapp.tar.gz

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
# Use the same base image or potentially a smaller one if compatible (e.g., miniforge3)
# Using mambaforge for consistency, but only copying essentials.
FROM condaforge/mambaforge

# Set required Conda environment variables
ENV PATH="/opt/conda/envs/bio-webapp/bin:$PATH"
ENV CONDA_DEFAULT_ENV=bio-webapp

# Create necessary runtime directories (/app, /data, /config)
# Create non-root user/group (Optional but good practice) - Skipping for simplicity now
RUN mkdir -p /app /data /config

# Copy essential artifacts from the builder stage
COPY --from=builder /opt/conda/envs/bio-webapp /opt/conda/envs/bio-webapp
COPY --from=builder /build/app /app
COPY --from=builder /usr/local/bin/filebrowser /usr/local/bin/filebrowser
COPY --from=builder /build/config_staging /config

# Install only essential RUNTIME system dependencies (bash is likely needed for CMD)
# mambaforge base likely includes bash, but explicit install is safer if switching base
# RUN apt-get update && apt-get install -y --no-install-recommends bash && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ensure correct permissions for File Browser config
RUN chmod 664 /config/filebrowser.db /config/settings.json

# Set working directory for the application
WORKDIR /app

# Expose both application ports
EXPOSE 8000 8080

# Run both applications using the shell script
# Using absolute paths for robustness
CMD ["sh", "-c", "/opt/conda/envs/bio-webapp/bin/python /app/main.py & /usr/local/bin/filebrowser --database /config/filebrowser.db --config /config/settings.json --port 8080 --root /data"]
