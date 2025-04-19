// File: frontend_app/lib/hooks/useJobsList.ts
import { useQuery } from "@tanstack/react-query";
import { getJobsList } from "@/lib/api"; // Import the API function
import { Job } from "@/lib/types"; // Import the Job type

// Define the query key
const jobsQueryKey = ["jobsList"];

export function useJobsList(options?: { refetchInterval?: number | false }) {
  return useQuery<Job[], Error>({ // Specify return type and error type
    queryKey: jobsQueryKey,
    queryFn: getJobsList, // Use the API function as the query function
    refetchInterval: options?.refetchInterval, // Pass through refetch interval if provided
    // Add other options like staleTime if needed, though defaults are in QueryProvider
    // staleTime: 1000 * 30, // e.g., 30 seconds
  });
}

// Function to invalidate the query cache (used after actions like start/stop/remove)
// We might move this to a more central place later if needed by many components
// For now, components can import queryClient and call invalidateQueries directly
// import { useQueryClient } from "@tanstack/react-query";
// export function useInvalidateJobsList() {
//   const queryClient = useQueryClient();
//   return () => queryClient.invalidateQueries({ queryKey: jobsQueryKey });
// }
