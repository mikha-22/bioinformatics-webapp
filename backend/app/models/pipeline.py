# backend/app/models/pipeline.py
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any

class SampleInfo(BaseModel):
    patient: str = Field(..., description="Patient identifier")
    sample: str = Field(..., description="Sample identifier")
    sex: str = Field(..., description="Sex (e.g., XX, XY)")
    status: int = Field(..., description="Status (0 for normal, 1 for tumor)")
    lane: Optional[str] = Field(None, description="Lane identifier (e.g., L001) - Required only for FASTQ input")
    fastq_1: Optional[str] = Field(None, description="Path to first FASTQ file relative to data dir")
    fastq_2: Optional[str] = Field(None, description="Path to second FASTQ file relative to data dir")
    bam_cram: Optional[str] = Field(None, description="Path to BAM or CRAM file relative to data dir")
    index: Optional[str] = Field(None, description="Path to index file (bai/crai/tbi) relative to data dir")
    vcf: Optional[str] = Field(None, description="Path to VCF file relative to data dir")


class PipelineInput(BaseModel):
    """ Main input model """
    run_name: str = Field(..., description="User-defined name for the pipeline run. Spaces will be converted to underscores.")
    run_description: Optional[str] = Field(None, description="Optional user-defined description for the pipeline run.")
    input_type: str = Field(..., description="Type of input data ('fastq', 'bam_cram', 'vcf')")
    samples: List[SampleInfo] = Field(..., description="List of sample information, structure depends on input_type")

    genome: str = Field(..., description="Genome build to use (e.g., GRCh38, GRCh37)")
    step: str = Field(..., description="Pipeline step to start from (e.g., mapping, variant_calling)")

    intervals_file: Optional[str] = Field(None, description="Path to BED file with target regions (relative to data dir)")
    dbsnp: Optional[str] = Field(None, description="Path to dbSNP VCF file (relative to data dir)")
    known_indels: Optional[str] = Field(None, description="Path to known indels VCF file (relative to data dir)")
    pon: Optional[str] = Field(None, description="Path to Panel of Normals (PoN) VCF file (relative to data dir)")

    tools: Optional[List[str]] = Field(None, description="List of tools (e.g., ['strelka', 'mutect2'])")
    profile: Optional[str] = Field(None, description="Nextflow profile (e.g., docker, singularity)")
    aligner: Optional[str] = Field(None, description="Aligner to use (e.g., bwa-mem, dragmap)")

    joint_germline: Optional[bool] = Field(False, description="Perform joint germline calling")
    wes: Optional[bool] = Field(False, description="Data is from Whole Exome Sequencing")
    trim_fastq: Optional[bool] = Field(False, description="Enable adapter trimming")
    skip_qc: Optional[bool] = Field(False, description="Skip QC steps")
    skip_annotation: Optional[bool] = Field(False, description="Skip annotation steps")
    skip_baserecalibrator: Optional[bool] = Field(False, description="Skip base quality score recalibration")

class JobResourceInfo(BaseModel):
    peak_memory_mb: Optional[float] = None
    average_cpu_percent: Optional[float] = None
    duration_seconds: Optional[float] = None

class JobMeta(BaseModel):
    run_name: Optional[str] = Field(None, description="User-defined name for the pipeline run.")
    input_type: Optional[str] = None
    input_params: Optional[Dict[str, Optional[str]]] = Field(default_factory=dict)
    sarek_params: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Sarek-specific parameters.")
    sample_info: Optional[List[Dict[str, Any]]] = Field(default_factory=list)
    staged_job_id_origin: Optional[str] = None
    error_message: Optional[str] = None
    stderr_snippet: Optional[str] = None
    # progress: Optional[int] = None # This was a generic progress, replaced by more specific ones
    current_task: Optional[str] = None
    results_path: Optional[str] = None
    warning_message: Optional[str] = None
    input_csv_path_used: Optional[str] = None
    is_rerun_execution: Optional[bool] = None
    original_job_id: Optional[str] = None

    # <<< --- ADDED Fields for Detailed Progress --- >>>
    overall_progress: Optional[float] = Field(None, description="Overall pipeline progress percentage based on Nextflow tasks (0-100)")
    submitted_task_count: Optional[int] = Field(None, description="Total unique tasks submitted/identified by Nextflow in the trace")
    completed_task_count: Optional[int] = Field(None, description="Total unique tasks marked as COMPLETED by Nextflow in the trace")
    # current_task_progress: Optional[float] = Field(None, description="Progress percentage of the current_task, if available from console parsing (future)") # Optional for future
    # <<< --- END ADDED Fields --- >>>


class JobStatusDetails(BaseModel):
    job_id: str = Field(..., description="The unique ID of the RQ job or Staged ID")
    run_name: Optional[str] = Field(None, description="User-defined name for the pipeline run.")
    status: str = Field(..., description="Current status of the job")
    description: Optional[str] = Field(None, description="User-defined run description for the pipeline run.")
    staged_at: Optional[float] = Field(None, description="Unix timestamp when the job was staged")
    enqueued_at: Optional[float] = Field(None, description="Unix timestamp when the job was enqueued")
    started_at: Optional[float] = Field(None, description="Unix timestamp when the job started execution")
    ended_at: Optional[float] = Field(None, description="Unix timestamp when the job finished or failed")
    result: Optional[Any] = Field(None, description="Result returned by the job if successful")
    error: Optional[str] = Field(None, description="Error message if the job failed")
    meta: JobMeta = Field(default_factory=JobMeta, description="Detailed metadata associated with the job")
    resources: Optional[JobResourceInfo] = Field(None, description="Resource usage statistics")

class ProfileData(BaseModel):
    """ Data stored for a configuration profile. """
    genome: str = Field(..., description="Genome build to use (e.g., GRCh38, GRCh37)")
    step: str = Field(..., description="Intended pipeline step to start from (e.g., mapping, variant_calling)")
    intervals_file: Optional[str] = Field(None, description="Path to BED file with target regions")
    dbsnp: Optional[str] = Field(None, description="Path to dbSNP VCF file")
    known_indels: Optional[str] = Field(None, description="Path to known indels VCF file")
    pon: Optional[str] = Field(None, description="Path to Panel of Normals (PoN) VCF file")
    tools: Optional[List[str]] = Field(None, description="List of tools")
    profile: Optional[str] = Field(None, description="Nextflow profile")
    aligner: Optional[str] = Field(None, description="Aligner to use")
    joint_germline: Optional[bool] = Field(False, description="Perform joint germline calling")
    wes: Optional[bool] = Field(False, description="Data is from Whole Exome Sequencing")
    trim_fastq: Optional[bool] = Field(False, description="Enable adapter trimming")
    skip_qc: Optional[bool] = Field(False, description="Skip QC steps")
    skip_annotation: Optional[bool] = Field(False, description="Skip annotation steps")
    skip_baserecalibrator: Optional[bool] = Field(False, description="Skip base quality score recalibration")

class SaveProfileRequest(BaseModel):
    name: str = Field(..., description="The name to save the profile under.")
    data: ProfileData = Field(..., description="The profile configuration data.")
