# backend/app/models/pipeline.py
from pydantic import BaseModel, Field
from typing import Optional

class PipelineInput(BaseModel):
    # Required files
    input_csv_file: str = Field(..., description="Path to the input CSV file containing sample information")
    reference_genome_file: str = Field(..., description="Path to the reference genome file")
    
    # Required parameters
    genome: str = Field(..., description="Genome build to use (e.g., GRCh38)")
    
    # Optional files
    intervals_file: Optional[str] = Field(None, description="Path to BED file with target regions")
    known_variants_file: Optional[str] = Field(None, description="Path to VCF file with known variants")
    
    # Optional parameters
    tools: Optional[str] = Field(None, description="Comma-separated list of tools to use (e.g., strelka,mutect2)")
    step: Optional[str] = Field(None, description="Pipeline step to start from (e.g., mapping, variant_calling)")
    profile: Optional[str] = Field(None, description="Nextflow profile to use (e.g., docker, singularity)")
    joint_germline: Optional[bool] = Field(False, description="Whether to perform joint germline calling")
    wes: Optional[bool] = Field(False, description="Whether the data is from whole exome sequencing")
    
    # Optional metadata
    description: Optional[str] = Field(None, description="Optional description of the pipeline run")
