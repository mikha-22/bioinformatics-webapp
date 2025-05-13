// File: frontend_app/lib/api.ts
import axios from "axios";
// Ensure all necessary types are imported
import { Job, PipelineInput, ResultRun, ResultItem, DataFile, JobStatusDetails, RunParameters, ProfileData } from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "";

// <<< DEBUG LOG for API_BASE_URL >>>
console.log("[API Init DEBUG] NEXT_PUBLIC_API_BASE_URL:", API_BASE_URL);
if (!API_BASE_URL && typeof window !== 'undefined') {
  console.error("CRITICAL: NEXT_PUBLIC_API_BASE_URL is not defined. API calls will likely fail.");
}

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

apiClient.interceptors.request.use(
  (config) => {
    return config;
  },
  (error) => {
    console.error("Request Error Interceptor:", error);
    return Promise.reject(error);
  }
);

apiClient.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    console.error("Response Error Interceptor:", error.response?.status, error.config?.url, error.message);
    const message = error.response?.data?.detail || error.message || "An unknown error occurred";
    const enhancedError = new Error(message);
    (enhancedError as any).originalError = error;
    (enhancedError as any).status = error.response?.status;
    return Promise.reject(enhancedError);
  }
);

// --- API Functions ---

// ========================
// Job Management Functions
// ========================
export const getJobsList = async (): Promise<Job[]> => {
  try {
    const response = await apiClient.get<Job[]>("/api/jobs_list");
    return response.data || [];
  } catch (error) {
    console.error("Failed to fetch jobs list:", error);
    throw error;
  }
};

export const getJobStatus = async (jobId: string): Promise<JobStatusDetails> => {
  if (!jobId) {
     throw new Error("Job ID cannot be empty for getJobStatus");
  }
  try {
    const response = await apiClient.get<JobStatusDetails>(`/api/job_status/${jobId}`);
    return response.data;
  } catch (error) {
     console.error(`Failed to fetch status for job ${jobId}:`, error);
    throw error;
  }
};

export const startJob = async (stagedJobId: string): Promise<{ message: string; job_id: string }> => {
    if (!stagedJobId || !stagedJobId.startsWith('staged_')) throw new Error("Invalid staged Job ID provided.");
    try {
        const response = await apiClient.post(`/api/start_job/${stagedJobId}`);
        return response.data;
    } catch (error) {
        console.error(`Failed to start job ${stagedJobId}:`, error);
        throw error;
    }
};

export const stopJob = async (jobId: string): Promise<{ message: string; job_id: string }> => {
    if (!jobId) throw new Error("Job ID is required to stop.");
     try {
        const response = await apiClient.post(`/api/stop_job/${jobId}`);
        return response.data;
    } catch (error) {
         console.error(`Failed to stop job ${jobId}:`, error);
        throw error;
    }
};

export const removeJob = async (jobId: string): Promise<{ message: string; removed_id: string }> => {
    if (!jobId) throw new Error("Job ID is required to remove.");
     try {
        const response = await apiClient.delete(`/api/remove_job/${jobId}`);
        return response.data;
    } catch (error) {
         console.error(`Failed to remove job ${jobId}:`, error);
        throw error;
    }
};

export const rerunJob = async (jobId: string): Promise<{ message: string; staged_job_id: string }> => {
     if (!jobId) throw new Error("Job ID is required to rerun.");
    try {
       const response = await apiClient.post(`/api/rerun_job/${jobId}`);
       return response.data;
    } catch (error) {
        console.error(`Failed to rerun job ${jobId}:`, error);
        throw error;
    }
};

// ========================
// Results Data Functions
// ========================
export const getResultsList = async (): Promise<ResultRun[]> => {
  try {
    const response = await apiClient.get<ResultRun[]>("/api/get_results");
    return response.data || [];
  } catch (error) {
    console.error("Error fetching results list:", error);
    throw error;
  }
};

export const getResultRunFiles = async (runDirName: string): Promise<ResultItem[]> => {
  if (!runDirName) throw new Error("Run directory name is required.");
  try {
    const response = await apiClient.get<ResultItem[]>(`/api/get_results/${encodeURIComponent(runDirName)}`);
    return response.data || [];
  } catch (error) {
    console.error(`Error fetching files for run ${runDirName}:`, error);
    throw error;
  }
};

export const getResultRunParameters = async (runDirName: string): Promise<RunParameters> => {
    if (!runDirName) throw new Error("Run directory name is required to fetch parameters.");
    try {
        const response = await apiClient.get<RunParameters>(`/api/results/${encodeURIComponent(runDirName)}/parameters`);
        return response.data || {};
    } catch (error) {
        console.error(`Error fetching parameters for run ${runDirName}:`, error);
        throw error;
    }
};

export const downloadResultRun = async (runDirName: string): Promise<Blob> => {
    if (!runDirName) throw new Error("Run directory name is required for download.");
    try {
        const response = await apiClient.get(`/api/download_result/${encodeURIComponent(runDirName)}`, {
            responseType: 'blob',
        });
        if (!(response.data instanceof Blob)) {
             throw new Error("Invalid response received from server during download.");
        }
        return response.data;
    } catch (error) {
        console.error(`Error downloading result run ${runDirName}:`, error);
        throw error;
    }
};

export const downloadResultFile = async (runDirName: string, filePath: string): Promise<Blob> => {
    if (!runDirName || !filePath) throw new Error("Run directory and file path are required for download.");
    try {
        const encodedFilePath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        const response = await apiClient.get(`/api/download_file/${encodeURIComponent(runDirName)}/${encodedFilePath}`, {
            responseType: 'blob',
        });
         if (!(response.data instanceof Blob)) {
             throw new Error("Invalid response received from server during file download.");
        }
        return response.data;
    } catch (error) {
        console.error(`Error downloading file ${filePath} from ${runDirName}:`, error);
        throw error;
    }
};

// --- MultiQC Path API FUNCTION ---
export const getMultiQCReportPath = async (runDirName: string): Promise<string | null> => {
  console.log(`[API getMultiQCReportPath DEBUG] Function called with runDirName: '${runDirName}'`); // <<< DEBUG LOG
  if (!runDirName) {
    console.warn("[API getMultiQCReportPath DEBUG] runDirName is empty, returning null."); // <<< DEBUG LOG
    return null;
  }
  try {
    console.log(`[API getMultiQCReportPath DEBUG] Attempting apiClient.get for /api/results/${encodeURIComponent(runDirName)}/multiqc_path`); // <<< DEBUG LOG
    const response = await apiClient.get<string | null>(`/api/results/${encodeURIComponent(runDirName)}/multiqc_path`);
    console.log(`[API getMultiQCReportPath DEBUG] for ${runDirName} - Response Status: ${response.status}, Data:`, response.data); // <<< DEBUG LOG
    return response.data;
  } catch (error) {
    const axiosError = error as any;
    if (axiosError.isAxiosError && axiosError.response && axiosError.response.status === 404) {
      console.log(`[API getMultiQCReportPath DEBUG] MultiQC report path not found for run ${runDirName} (API returned 404).`); // <<< DEBUG LOG
      return null;
    }
    console.error(`[API getMultiQCReportPath DEBUG] Error fetching MultiQC path for run ${runDirName}:`, error); // <<< DEBUG LOG
    throw error;
  }
};
// --- END MultiQC Path API FUNCTION ---

// ========================
// Pipeline Staging Function
// ========================
export const stagePipelineJob = async (values: PipelineInput): Promise<{ message: string; staged_job_id: string }> => {
  const apiPayload: PipelineInput = values;
  try {
    console.log("Staging Job with API Payload:", apiPayload);
    const response = await apiClient.post('/api/run_pipeline', apiPayload);
    return response.data;
  } catch (error) {
    console.error("Error staging pipeline job:", error);
    throw error;
  }
};

// ========================
// Data File Listing
// ========================
export const getDataFiles = async (type?: string, extensions?: string[]): Promise<DataFile[]> => {
  try {
    const response = await apiClient.get<DataFile[]>("/api/get_data");
    let files = response.data || [];
    if (extensions && extensions.length > 0) {
        files = files.filter(file =>
            extensions.some(ext => file.name.toLowerCase().endsWith(ext.toLowerCase()))
        );
    }
    return files;
  } catch (error) {
    console.error(`Error fetching data files (type: ${type}):`, error);
    throw error;
  }
};

// ========================
// Profile Management Functions
// ========================
export const listProfileNames = async (): Promise<string[]> => {
    try {
        const response = await apiClient.get<string[]>("/api/profiles");
        return response.data || [];
    } catch (error) {
        console.error("Failed to fetch profile names:", error);
        throw error;
    }
};

export const getProfileData = async (profileName: string): Promise<ProfileData> => {
    if (!profileName) throw new Error("Profile name is required.");
    try {
        const response = await apiClient.get<ProfileData>(`/api/profiles/${encodeURIComponent(profileName)}`);
        return response.data || {};
    } catch (error) {
         console.error(`Failed to fetch profile data for ${profileName}:`, error);
        throw error;
    }
};

export const saveProfile = async (profileName: string, data: ProfileData): Promise<{ message: string; profile_name: string }> => {
    if (!profileName) throw new Error("Profile name is required to save.");
    try {
        const payload = { name: profileName, data: data };
        const response = await apiClient.post("/api/profiles", payload);
        return response.data;
    } catch (error) {
         console.error(`Failed to save profile ${profileName}:`, error);
        throw error;
    }
};

export const deleteProfile = async (profileName: string): Promise<{ message: string; profile_name: string }> => {
     if (!profileName) throw new Error("Profile name is required to delete.");
    try {
        const response = await apiClient.delete(`/api/profiles/${encodeURIComponent(profileName)}`);
        return response.data;
    } catch (error) {
         console.error(`Failed to delete profile ${profileName}:`, error);
        throw error;
    }
};
