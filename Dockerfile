# Use a minimal Debian-based image
FROM debian:bookworm-slim

# Install required dependencies
RUN apt-get update && apt-get install -y \
    wget \
    git \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Clone the bioinformatics web app repository
RUN git clone --branch development https://github.com/mikha-22/bioinformatics-webapp.git /app

# Copy the Conda environment file from the current directory
COPY conda_env.yml /app/conda_env.yml

# Install Miniforge (non-interactive)
RUN wget -O Miniforge3.sh "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-$(uname -m).sh" && \
    bash Miniforge3.sh -b -p /opt/conda && \
    rm Miniforge3.sh

# Initialize Conda & Mamba
RUN echo "source /opt/conda/etc/profile.d/conda.sh" >> ~/.bashrc && \
    echo "source /opt/conda/etc/profile.d/mamba.sh" >> ~/.bashrc

# Create the conda environment using Mamba
RUN /opt/conda/bin/mamba env create -f /app/conda_env.yml

# Set shell to use the conda environment
SHELL ["/bin/bash", "-c", "source /opt/conda/bin/activate bio-webapp && exec bash"]

# Set the working directory
WORKDIR /app

# Expose the application port
EXPOSE 8000

# Command to run the application
CMD ["python", "main.py"]

