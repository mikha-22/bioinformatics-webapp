# backend/app/models/pipeline.py
from pydantic import BaseModel, Field

from typing import Optional, List

class SampleInfo(BaseModel):
    patient: str = Field(..., description="Patient identifier")
    sample: str = Field(..., description="Sample identifier")
    sex: str = Field(..., description="Sex (XX, XY)")
    status: int = Field(..., description="0 for normal, 1 for tumor")
    fastq_1: str = Field(..., description="Path to first FASTQ file")
    fastq_2: str = Field(..., description="Path to second FASTQ file")

class PipelineInput(BaseModel):
    # Sample information (replaces input_csv_file)
    samples: List[SampleInfo] = Field(..., description="List of sample information")
    
    # Required parameters
    reference_genome_file: str = Field(..., description="Path to the reference genome file")
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
