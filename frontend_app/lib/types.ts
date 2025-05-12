// File: frontend_app/lib/types.ts

export interface JobResourceInfo {
  peak_memory_mb?: number | null;
  average_cpu_percent?: number | null;
  duration_seconds?: number | null;
}

export interface SarekParams {
  genome?: string;
  tools?: string;
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
  description?: string | null; // Holds run_description from staging
}

export interface JobResultSuccess {
    status: "success";
    results_path?: string;
    message?: string;
    resources: JobMeta; // resources within result might be a subset or all of JobMeta
}

export interface Job {
  job_id: string; // <<< CHANGED from id to job_id
  run_name?: string | null;
  status: "staged" | "queued" | "started" | "running" | "finished" | "failed" | "stopped" | "canceled" | string;
  description: string | null; // This will hold the run_description
  enqueued_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  staged_at?: number | null; // Present for staged jobs from backend logic
  result: JobResultSuccess | null | any; // 'any' for flexibility if backend result varies
  error: string | null;
  meta: JobMeta;
  resources: JobResourceInfo | null;
}

// This type should align with what the /api/jobs_list and /api/job_status/{job_id} endpoints return.
// The backend uses JobStatusDetails Pydantic model for this.
export interface JobStatusDetails {
    job_id: string;
    run_name?: string | null;
    status: string;
    description?: string | null; // This is the run_description
    enqueued_at?: number | null;
    started_at?: number | null;
    ended_at?: number | null;
    result?: any | null;
    error?: string | null;
    meta: JobMeta;
    resources?: JobResourceInfo | null;
    // If staged_at needs to be on this specific type, add it.
    // For now, assuming it's handled by the broader `Job` type if needed after transformation.
    // However, if getJobsList directly returns objects that should have staged_at,
    // and we are casting to Job[], then Job should have it.
    // The backend's JobStatusDetails model does not have staged_at.
    // The `all_jobs_list_model.append(JobStatusDetails(...))` in jobs.py uses the Pydantic model.
    // Let's ensure the frontend Job type is the one primarily used after fetching.
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
  description?: string; // Sarek's internal config description
}

export interface RunParameters {
  run_name?: string | null;
  run_description?: string | null;
  input_filenames?: InputFilenames | null;
  sarek_params?: SarekParams | null;
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
    description?: string | null; // Sarek's internal config description for the profile
}
