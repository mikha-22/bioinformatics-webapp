# backend/app/models/pipeline.py
from pydantic import BaseModel

class PipelineInput(BaseModel):
    forward_reads_file: str
    reverse_reads_file: str
    reference_genome_file: str
    target_regions_file: str
    known_variants_file: str | None = None # Optional, validated later
