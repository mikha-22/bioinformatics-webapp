# backend/app/models/pipeline.py
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any # Make sure Any is imported

# --- Existing Models ---
class SampleInfo(BaseModel):
    patient: str = Field(..., description="Patient identifier")
    sample: str = Field(..., description="Sample identifier")
    sex: str = Field(..., description="Sex (e.g., XX, XY)")
    status: int = Field(..., description="Status (0 for normal, 1 for tumor)")
    # *** ADD lane field ***
    lane: str = Field(..., description="Lane identifier (e.g., L001)")
    # ********************
    fastq_1: str = Field(..., description="Path to first FASTQ file relative to data dir")
    fastq_2: str = Field(..., description="Path to second FASTQ file relative to data dir")

class PipelineInput(BaseModel):
    # Sample information (from frontend form)
    samples: List[SampleInfo] = Field(..., description="List of sample information")

    # Required parameters (from Sarek docs / frontend form)
    genome: str = Field(..., description="Genome build to use (e.g., GRCh38, GRCh37)")

    # Optional files (from Sarek docs / frontend form)
    intervals_file: Optional[str] = Field(None, description="Path to BED file with target regions (relative to data dir)")
    dbsnp: Optional[str] = Field(None, description="Path to dbSNP VCF file (relative to data dir)")
    known_indels: Optional[str] = Field(None, description="Path to known indels VCF file (relative to data dir)")
    pon: Optional[str] = Field(None, description="Path to Panel of Normals (PoN) VCF file (relative to data dir)")

    # Optional parameters (from Sarek docs / frontend form)
    # *** UPDATED: Accept list of strings for tools from frontend ***
    tools: Optional[List[str]] = Field(None, description="List of tools (e.g., ['strelka', 'mutect2'])")
    # ***************************************************************
    step: Optional[str] = Field(None, description="Pipeline step to start from (e.g., mapping, variant_calling)")
    profile: Optional[str] = Field(None, description="Nextflow profile (e.g., docker, singularity)")
    aligner: Optional[str] = Field(None, description="Aligner to use (e.g., bwa-mem, dragmap)")

    # Boolean flags (from Sarek docs / frontend form)
    joint_germline: Optional[bool] = Field(False, description="Perform joint germline calling")
    wes: Optional[bool] = Field(False, description="Data is from Whole Exome Sequencing")
    trim_fastq: Optional[bool] = Field(False, description="Enable adapter trimming")
    skip_qc: Optional[bool] = Field(False, description="Skip QC steps")
    skip_annotation: Optional[bool] = Field(False, description="Skip annotation steps")
    skip_baserecalibrator: Optional[bool] = Field(False, description="Skip base quality score recalibration")

    # Optional metadata (from frontend form)
    description: Optional[str] = Field(None, description="Optional description of the pipeline run")

# --- Existing Models ---
class JobResourceInfo(BaseModel):
    peak_memory_mb: Optional[float] = None
    average_cpu_percent: Optional[float] = None
    duration_seconds: Optional[float] = None

class JobStatusDetails(BaseModel):
    job_id: str = Field(..., description="The unique ID of the RQ job")
    status: str = Field(..., description="Current status of the job (e.g., queued, started, finished, failed)")
    description: Optional[str] = Field(None, description="Job description")
    enqueued_at: Optional[float] = Field(None, description="Unix timestamp when the job was enqueued")
    started_at: Optional[float] = Field(None, description="Unix timestamp when the job started execution")
    ended_at: Optional[float] = Field(None, description="Unix timestamp when the job finished or failed")
    result: Optional[Any] = Field(None, description="Result returned by the job if successful")
    error: Optional[str] = Field(None, description="Error message if the job failed")
    meta: Dict[str, Any] = Field({}, description="Metadata associated with the job")
    resources: Optional[JobResourceInfo] = Field(None, description="Resource usage statistics")
# --- END Existing Models ---

# --- <<< NEW MODELS FOR PROFILES >>> ---
class ProfileData(BaseModel):
    """
    Represents the data stored for a configuration profile.
    Essentially PipelineInput minus the 'samples' field.
    """
    # Required parameters
    genome: str = Field(..., description="Genome build to use (e.g., GRCh38, GRCh37)")

    # Optional files
    intervals_file: Optional[str] = Field(None, description="Path to BED file with target regions")
    dbsnp: Optional[str] = Field(None, description="Path to dbSNP VCF file")
    known_indels: Optional[str] = Field(None, description="Path to known indels VCF file")
    pon: Optional[str] = Field(None, description="Path to Panel of Normals (PoN) VCF file")

    # Optional parameters
    tools: Optional[List[str]] = Field(None, description="List of tools")
    step: Optional[str] = Field(None, description="Pipeline step to start from")
    profile: Optional[str] = Field(None, description="Nextflow profile")
    aligner: Optional[str] = Field(None, description="Aligner to use")

    # Boolean flags
    joint_germline: Optional[bool] = Field(False, description="Perform joint germline calling")
    wes: Optional[bool] = Field(False, description="Data is from Whole Exome Sequencing")
    trim_fastq: Optional[bool] = Field(False, description="Enable adapter trimming")
    skip_qc: Optional[bool] = Field(False, description="Skip QC steps")
    skip_annotation: Optional[bool] = Field(False, description="Skip annotation steps")
    skip_baserecalibrator: Optional[bool] = Field(False, description="Skip base quality score recalibration")

    # Optional metadata
    description: Optional[str] = Field(None, description="Optional description of the profile itself")

class SaveProfileRequest(BaseModel):
    """ Request body for saving a profile. """
    name: str = Field(..., description="The name to save the profile under.")
    data: ProfileData = Field(..., description="The profile configuration data.")
# --- <<< END NEW MODELS FOR PROFILES >>> ---
