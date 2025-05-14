// File: frontend_app/lib/types.ts

export interface JobResourceInfo {
  peak_memory_mb?: number | null;
  average_cpu_percent?: number | null;
  duration_seconds?: number | null;
}

export interface SarekParams {
  genome?: string;
  tools?: string; // Comma-separated string when stored in backend meta
  step?: string;
  profile?: string;
  aligner?: string;
  joint_germline?: boolean;
  wes?: boolean;
  trim_fastq?: boolean;
  skip_qc?: boolean;
  skip_annotation?: boolean;
  skip_baserecalibrator?: boolean;
  [key: string]: any;
}

export interface InputFilenames {
    intervals_file?: string | null;
    dbsnp?: string | null;
    known_indels?: string | null;
    pon?: string | null;
}

export interface SampleInfo {
    patient: string;
    sample: string;
    sex: string;
    status: number;
    lane?: string | null;
    fastq_1?: string | null;
    fastq_2?: string | null;
    bam_cram?: string | null;
    index?: string | null;
    vcf?: string | null;
}

export interface JobMeta {
  run_name?: string | null;
  description?: string | null; // User's overall run description
  input_type?: string;
  input_params?: InputFilenames;
  sarek_params?: SarekParams;
  sample_info?: SampleInfo[];
  staged_job_id_origin?: string;
  error_message?: string;
  stderr_snippet?: string;
  current_task?: string | null;
  results_path?: string;
  warning_message?: string;
  input_csv_path_used?: string;
  is_rerun_execution?: boolean | null;
  original_job_id?: string | null;

  // <<< --- MODIFIED/ADDED Fields for Detailed Progress --- >>>
  overall_progress?: number | null;       // Percentage (0-100), can be from NF log or trace
  submitted_task_count?: number | null;   // Total tasks Nextflow knows about (from NF log or trace)
  completed_task_count?: number | null;   // Tasks marked COMPLETED (primarily from trace)
  // <<< --- END MODIFIED/ADDED Fields --- >>>
}

export interface JobResultSuccess {
    status: "success";
    results_path?: string;
    message?: string;
    resources: JobMeta;
}

export interface Job {
  job_id: string;
  run_name?: string | null;
  status: "staged" | "queued" | "started" | "running" | "finished" | "failed" | "stopped" | "canceled" | string;
  description: string | null;
  enqueued_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  staged_at?: number | null;
  result: JobResultSuccess | null | any;
  error: string | null;
  meta: JobMeta; // This will now include the new progress fields
  resources: JobResourceInfo | null;
}

export interface JobStatusDetails {
    job_id: string;
    run_name?: string | null;
    status: string;
    description?: string | null;
    staged_at?: number | null;
    enqueued_at?: number | null;
    started_at?: number | null;
    ended_at?: number | null;
    result?: any | null;
    error?: string | null;
    meta: JobMeta; // This will now include the new progress fields
    resources?: JobResourceInfo | null;
}

export interface ResultRun {
  name: string;
  is_dir: boolean;
  modified_time: number;
  size: number | null;
  extension: string | null;
  filebrowser_link: string | null;
  error?: string;
}

export interface ResultItem {
    name: string;
    is_dir: boolean;
    modified_time: number;
    size: number | null;
    extension: string | null;
    filebrowser_link: string | null;
    error?: string;
    relative_path: string;
}

export interface DataFile {
    name: string;
    type: 'file';
}

export interface PipelineInput {
  run_name: string;
  run_description?: string;
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
}

export interface RunParameters {
  run_name?: string | null;
  run_description?: string | null;
  input_filenames?: InputFilenames | null;
  sarek_params?: Sarek_params | null;
  sample_info?: SampleInfo[] | null;
  input_type?: string | null;
  staged_job_id_origin?: string | null;
  original_job_id?: string | null;
  is_rerun_execution?: boolean | null;
  input_csv_path_used?: string | null;
}

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
}

export interface BatchActionDetail {
  job_id: string;
  status: string;
  message?: string;
}

export interface BatchActionResponse {
  succeeded_count: number;
  failed_count: number;
  details: BatchActionDetail[];
}
