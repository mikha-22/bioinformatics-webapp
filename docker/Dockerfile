# Use Miniforge as the base image (Mamba is faster than Conda)
FROM condaforge/mambaforge

# Set working directory *before* cloning, so clone happens into /app
WORKDIR /app

# Install Git, File Browser dependencies (curl and bash)
# Add 'cp' capability if not already present (it usually is, but good practice)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    bash \
    coreutils `# Provides cp command` \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Clone the application repository ---
ARG REPO_URL=https://github.com/mikha-22/bioinformatics-webapp.git
ARG BRANCH=development
RUN git clone --branch ${BRANCH} --depth 1 ${REPO_URL} /app \
    && rm -rf /app/.git  # Remove .git folder to reduce image size

# --- Setup Conda Environment from Cloned Repo ---
# Extract the environment from the tarball within the cloned repo
# Clean up the tarball afterwards
RUN mkdir -p /opt/conda/envs/ && \
    tar -xzf /app/docker/bio-webapp.tar.gz -C /opt/conda/envs/ && \
    rm /app/docker/bio-webapp.tar.gz

# Set up Conda environment variables
ENV PATH="/opt/conda/envs/bio-webapp/bin:$PATH"
ENV CONDA_DEFAULT_ENV=bio-webapp

# Install File Browser using bash
RUN curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | bash

# Create necessary directories for File Browser
# WORKDIR is still /app here, but use absolute paths for clarity
RUN mkdir -p /data /config

# Copy the preconfigured File Browser db and settings FROM THE CLONED REPO
RUN cp /app/docker/filebrowser.db /config/filebrowser.db && \
    cp /app/docker/settings.json /config/settings.json

# Ensure correct permissions for File Browser config
RUN chmod 664 /config/filebrowser.db /config/settings.json

# Expose both application ports (8000 for your app, 8080 for File Browser)
EXPOSE 8000 8080

# WORKDIR is already /app, which is appropriate for running main.py
# Run both applications in a single container using a shell script
CMD ["sh", "-c", "python /app/main.py & filebrowser --database /config/filebrowser.db --config /config/settings.json --port 8080 --root /data"]
