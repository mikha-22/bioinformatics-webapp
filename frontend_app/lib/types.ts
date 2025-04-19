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
  step?: string;
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

export interface SampleInfo { // Already exported
    patient: string;
    sample: string;
    sex: string;
    status: number; // 0=Normal, 1=Tumor
    // *** ADD lane field ***
    lane: string;
    // ********************
    fastq_1: string;
    fastq_2: string;
}

export interface JobMeta { // Already exported
  input_params?: InputFilenames;
  sarek_params?: SarekParams;
  sample_info?: SampleInfo[]; // Will now include lane
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
  samples: SampleInfo[]; // Uses SampleInfo which now includes lane
  genome: string;
  intervals_file?: string;
  dbsnp?: string;
  known_indels?: string;
  pon?: string;
  tools?: string[]; // Frontend sends list of strings
  step?: string;
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
  sarek_params?: SarekParams | null;
  sample_info?: SampleInfo[] | null; // Includes lane
}
