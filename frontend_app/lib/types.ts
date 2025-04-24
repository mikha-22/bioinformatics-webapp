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
  input_type?: string; // Added input_type
  input_params?: InputFilenames;
  sarek_params?: SarekParams; // Now includes step
  sample_info?: SampleInfo[]; // Structure depends on input_type
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
  input_csv_path_used?: string; // Added in jobs.py for rerun debugging
  is_rerun_execution?: boolean; // Added in jobs.py
  original_job_id?: string; // Added in jobs.py for rerun reference
}

export interface JobResultSuccess { // Already exported
    status: "success";
    results_path?: string;
    message?: string;
    resources: JobMeta;
}

export interface Job { // Already exported
  id: string;
  status: "staged" | "queued" | "started" | "running" | "finished" | "failed" | "stopped" | "canceled" | string;
  description: string | null;
  enqueued_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  staged_at?: number | null;
  result: JobResultSuccess | null | any;
  error: string | null;
  meta: JobMeta; // Meta now potentially includes more fields
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

export interface JobStatusDetails extends Omit<Job, 'id' | 'staged_at'> { // Already exported
    job_id: string;
}

export interface DataFile { // Already exported
    name: string;
    type: 'file';
}

// Type for the API input payload
export interface PipelineInput {
  input_type: 'fastq' | 'bam_cram' | 'vcf'; // Type is required
  samples: SampleInfo[]; // Uses updated SampleInfo
  genome: string;
  step: string; // Step is required
  intervals_file?: string;
  dbsnp?: string;
  known_indels?: string;
  pon?: string;
  tools?: string[]; // Frontend sends list of strings
  profile?: string;
  aligner?: string;
  joint_germline?: boolean;
  wes?: boolean;
  trim_fastq?: boolean;
  skip_qc?: boolean;
  skip_annotation?: boolean;
  skip_baserecalibrator?: boolean;
  description?: string;
}

export interface RunParameters { // Already exported
  input_filenames?: InputFilenames | null;
  sarek_params?: SarekParams | null; // Includes step
  sample_info?: SampleInfo[] | null; // Includes optional fields
}

// UPDATED ProfileData to include step
export interface ProfileData {
    genome: string;
    step: string; // Step is now part of the profile
    intervals_file?: string | null;
    dbsnp?: string | null;
    known_indels?: string | null;
    pon?: string | null;
    tools?: string[] | null; // Expect string array from backend
    profile?: string | null;
    aligner?: string | null;
    joint_germline?: boolean | null;
    wes?: boolean | null;
    trim_fastq?: boolean | null;
    skip_qc?: boolean | null;
    skip_annotation?: boolean | null;
    skip_baserecalibrator?: boolean | null;
    description?: string | null;
}
// --- <<< END NEW TYPE >>> ---
