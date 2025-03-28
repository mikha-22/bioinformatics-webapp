# Use Miniforge as the base image (Mamba is faster than Conda)
FROM condaforge/mambaforge

# Set working directory inside the container
WORKDIR /app

# Copy the compressed Conda environment into the container
COPY bio-webapp.tar.gz /tmp/

# Extract the environment into Conda's environment directory
RUN mkdir -p /opt/conda/envs/ && \
    tar -xzf /tmp/bio-webapp.tar.gz -C /opt/conda/envs/ && \
    rm /tmp/bio-webapp.tar.gz

# Set up Conda environment variables
ENV PATH="/opt/conda/envs/bio-webapp/bin:$PATH"
ENV CONDA_DEFAULT_ENV=bio-webapp

# Copy the application files into the container
COPY . /app

# Install File Browser dependencies (curl and bash) on top of Miniforge
RUN apt-get update && apt-get install -y curl bash

# Install File Browser using bash
RUN curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | bash

# Create necessary directories for File Browser
WORKDIR /data
RUN mkdir -p /config

# Copy the preconfigured File Browser database and settings
COPY filebrowser.db /config/filebrowser.db
COPY settings.json /config/settings.json

# Ensure correct permissions for File Browser config
RUN chmod 664 /config/filebrowser.db /config/settings.json

# Expose both application ports (8000 for your app, 8080 for File Browser)
EXPOSE 8000 8080

# Run both applications in a single container using a shell script
CMD ["sh", "-c", "python /app/main.py & filebrowser --database /config/filebrowser.db --config /config/settings.json --port 8080 --root /data"]

