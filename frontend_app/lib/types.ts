// File: frontend_app/lib/types.ts

export interface JobResourceInfo {
  peak_memory_mb?: number | null;
  average_cpu_percent?: number | null;
  duration_seconds?: number | null;
}

// Keep this specific to Sarek params we know
export interface SarekParams { // Already exported
  genome?: string;
  tools?: string; // Comma-separated string stored in meta
  step?: string; // Added step here for meta
  profile?: string;
  aligner?: string;
  joint_germline?: boolean;
  wes?: boolean;
  trim_fastq?: boolean;
  skip_qc?: boolean;
  skip_annotation?: boolean;
  skip_baserecalibrator?: boolean;
}

export interface InputFilenames { // Already exported
    intervals_file?: string | null;
    dbsnp?: string | null;
    known_indels?: string | null;
    pon?: string | null;
}

// Updated SampleInfo for different input types
export interface SampleInfo { // Already exported
    patient: string;
    sample: string;
    sex: string;
    status: number; // 0=Normal, 1=Tumor
    // Optional fields depending on input type
    lane?: string | null; // Only for FASTQ
    fastq_1?: string | null; // Only for FASTQ
    fastq_2?: string | null; // Only for FASTQ
    bam_cram?: string | null; // Only for BAM/CRAM
    index?: string | null; // For BAM/CRAM/VCF index
    vcf?: string | null; // Only for VCF
}


export interface JobMeta { // Already exported
  run_name?: string | null; // <<< ADDED: User-defined run name, stored in meta
  input_type?: string;
  input_params?: InputFilenames;
  sarek_params?: SarekParams;
  sample_info?: SampleInfo[];
  staged_job_id_origin?: string;
  error_message?: string;
  stderr_snippet?: string;
  progress?: number;
  current_task?: string;
  peak_memory_mb?: number | null;
  average_cpu_percent?: number | null;
  duration_seconds?: number | null;
  results_path?: string;
  warning_message?: string;
  input_csv_path_used?: string;
  is_rerun_execution?: boolean;
  original_job_id?: string;
}

export interface JobResultSuccess { // Already exported
    status: "success";
    results_path?: string;
    message?: string;
    resources: JobMeta;
}

export interface Job { // Already exported
  id: string;
  run_name?: string | null; // <<< ADDED: User-defined run name for direct access
  status: "staged" | "queued" | "started" | "running" | "finished" | "failed" | "stopped" | "canceled" | string;
  description: string | null; // This will hold the run_description
  enqueued_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  staged_at?: number | null;
  result: JobResultSuccess | null | any;
  error: string | null;
  meta: JobMeta; // run_name will also be here
  resources: JobResourceInfo | null;
}

export interface ResultRun { // Already exported
  name: string;
  is_dir: boolean;
  modified_time: number;
  size: number | null;
  extension: string | null;
  filebrowser_link: string | null;
  error?: string;
}

export interface ResultItem { // Already exported
    name: string;
    is_dir: boolean;
    modified_time: number;
    size: number | null;
    extension: string | null;
    filebrowser_link: string | null;
    error?: string;
    relative_path: string;
}

// JobStatusDetails will inherit run_name from Job via Omit if we use it that way,
// or we can explicitly add it if needed for clarity.
// For now, components using JobStatusDetails might need to check job.meta.run_name
// or we ensure the backend populates a top-level run_name for JobStatusDetails as well.
export interface JobStatusDetails extends Omit<Job, 'id' | 'staged_at' | 'run_name'> {
    job_id: string;
    run_name?: string | null; // Explicitly adding here for clarity if backend sends it
}


export interface DataFile { // Already exported
    name: string;
    type: 'file';
}

// Type for the API input payload
export interface PipelineInput {
  run_name: string; // <<< ADDED: Mandatory run name
  run_description?: string; // <<< ADDED: Optional run description
  input_type: 'fastq' | 'bam_cram' | 'vcf';
  samples: SampleInfo[];
  genome: string;
  step: string;
  intervals_file?: string;
  dbsnp?: string;
  known_indels?: string;
  pon?: string;
  tools?: string[];
  profile?: string;
  aligner?: string;
  joint_germline?: boolean;
  wes?: boolean;
  trim_fastq?: boolean;
  skip_qc?: boolean;
  skip_annotation?: boolean;
  skip_baserecalibrator?: boolean;
  description?: string; // This is Sarek's internal description, distinct from run_description
}

export interface RunParameters { // Already exported
  run_name?: string | null; // <<< ADDED: Include run_name if available in metadata
  run_description?: string | null; // <<< ADDED: Include run_description
  input_filenames?: InputFilenames | null;
  sarek_params?: SarekParams | null;
  sample_info?: SampleInfo[] | null;
}

// UPDATED ProfileData to include step
export interface ProfileData {
    genome: string;
    step: string;
    intervals_file?: string | null;
    dbsnp?: string | null;
    known_indels?: string | null;
    pon?: string | null;
    tools?: string[] | null;
    profile?: string | null;
    aligner?: string | null;
    joint_germline?: boolean | null;
    wes?: boolean | null;
    trim_fastq?: boolean | null;
    skip_qc?: boolean | null;
    skip_annotation?: boolean | null;
    skip_baserecalibrator?: boolean | null;
    description?: string | null; // Sarek's internal description for the profile
}
// --- <<< END NEW TYPE >>> ---
