// File: frontend_app/lib/types.ts

export interface JobResourceInfo {
  peak_memory_mb?: number | null;
  average_cpu_percent?: number | null;
  duration_seconds?: number | null;
}

// SarekParams as understood by our application for storing in JobMeta.
// If Sarek pipeline itself has an internal description parameter it uses,
// it would be part of this generic dictionary if passed.
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
  // No explicit 'description' field here for Sarek's internal config,
  // as it's not a standard top-level Sarek CLI param we manage.
  // If Sarek uses one internally via other means, it would be part of this Any dict.
  [key: string]: any; // Allows for other Sarek params not explicitly listed
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
  run_name?: string | null; // User-defined run name
  // description field here is for the user's overall run_description,
  // which is also on JobStatusDetails.description and RQ Job.description
  description?: string | null;
  input_type?: string;
  input_params?: InputFilenames;
  sarek_params?: SarekParams;
  sample_info?: SampleInfo[];
  staged_job_id_origin?: string;
  error_message?: string;
  stderr_snippet?: string;
  progress?: number;
  current_task?: string;
  results_path?: string;
  warning_message?: string;
  input_csv_path_used?: string;
  is_rerun_execution?: boolean;
  original_job_id?: string;
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
  description: string | null; // This holds the user's run_description
  enqueued_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  staged_at?: number | null;
  result: JobResultSuccess | null | any;
  error: string | null;
  meta: JobMeta;
  resources: JobResourceInfo | null;
}

export interface JobStatusDetails {
    job_id: string;
    run_name?: string | null;
    status: string;
    description?: string | null; // This is the user's run_description
    staged_at?: number | null;
    enqueued_at?: number | null;
    started_at?: number | null;
    ended_at?: number | null;
    result?: any | null;
    error?: string | null;
    meta: JobMeta;
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

// Type for the API input payload to the backend
export interface PipelineInput {
  run_name: string;
  run_description?: string; // User's overall run description
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
  // The Sarek-specific internal config description field is removed
}

// Type for parameters displayed in the Results page dialog
export interface RunParameters {
  run_name?: string | null;
  run_description?: string | null; // User's overall run description
  input_filenames?: InputFilenames | null;
  sarek_params?: SarekParams | null; // This SarekParams might contain Sarek's own internal description if it was part of the run's meta
  sample_info?: SampleInfo[] | null;
  input_type?: string | null;
  staged_job_id_origin?: string | null;
  original_job_id?: string | null;
  is_rerun_execution?: boolean | null;
  input_csv_path_used?: string | null;
}

// Type for data saved/loaded as a configuration profile
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
    // The Sarek-specific internal config description field is removed
}
