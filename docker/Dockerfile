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

# Copy application files
COPY . /app

# Expose the application port
EXPOSE 8000

# Run the application
CMD ["python", "main.py"]

