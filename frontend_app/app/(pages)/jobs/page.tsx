// File: frontend_app/app/(pages)/jobs/page.tsx
"use client";

import React, { useState, useMemo } from "react";
import { useJobsList } from "@/lib/hooks/useJobsList";
import JobTable from "@/components/jobs/JobTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw, Search, ArrowDownUp, ListFilter, Terminal, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import ErrorDisplay from '@/components/common/ErrorDisplay';
import { Job } from "@/lib/types"; // Job type now uses job_id

const JOB_STATUSES = ['all', 'staged', 'queued', 'running', 'finished', 'failed', 'stopped'];
type SortKey = 'updated_at' | 'status' | 'run_name'; // Added run_name for sorting
type SortOrder = 'asc' | 'desc';

export default function JobsPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>('updated_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  const { data: jobs, isLoading, isError, error, refetch, isFetching } = useJobsList({
    refetchInterval: 5000,
  });

  console.log("JobsPage - Raw data from useJobsList:", jobs);

  const handleRefresh = () => {
    refetch();
  };

   const filteredAndSortedJobs = useMemo(() => {
    let filtered = jobs?.filter(job => job && typeof job.job_id === 'string') || []; // Ensure job_id exists

    console.log("JobsPage - Before filtering/sorting (after initial validation):", filtered);

    // Filter by search term (case-insensitive on description, run_name, or job_id)
    if (searchTerm) {
        const lowerSearchTerm = searchTerm.toLowerCase();
        filtered = filtered.filter((job) => {
            const descriptionMatch = job.description?.toLowerCase().includes(lowerSearchTerm);
            const runNameMatch = job.run_name?.toLowerCase().includes(lowerSearchTerm);
            // Ensure job.job_id is accessed safely, though filter above should guarantee it
            const jobIdMatch = job.job_id?.toLowerCase().includes(lowerSearchTerm); // <<< CHANGED job.id to job.job_id
            return descriptionMatch || runNameMatch || jobIdMatch;
        });
    }

    // Filter by status
    if (statusFilter !== 'all') {
        const effectiveStatus = statusFilter === 'running' ? ['running', 'started'] : [statusFilter];
        filtered = filtered.filter((job) => {
            const jobStatusLower = job.status?.toLowerCase();
            return jobStatusLower && effectiveStatus.includes(jobStatusLower);
        });
    }

    // Sort
    filtered.sort((a, b) => {
        let compareA: any = null;
        let compareB: any = null;

        if (sortKey === 'updated_at') {
            compareA = a.ended_at || a.started_at || a.enqueued_at || a.staged_at || 0;
            compareB = b.ended_at || b.started_at || b.enqueued_at || b.staged_at || 0;
        } else if (sortKey === 'status') {
            compareA = a.status || '';
            compareB = b.status || '';
        } else if (sortKey === 'run_name') { // <<< ADDED Sorting by Run Name
            compareA = a.run_name?.toLowerCase() || '';
            compareB = b.run_name?.toLowerCase() || '';
        }


        const comparison = (compareA < compareB) ? -1 : (compareA > compareB) ? 1 : 0;
        return sortOrder === 'asc' ? comparison : -comparison;
    });

    console.log("JobsPage - After filtering/sorting:", filtered);
    return filtered;
  }, [jobs, searchTerm, statusFilter, sortKey, sortOrder]);

  const handleSort = (key: SortKey) => {
      if (key === sortKey) {
          setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
      } else {
          setSortKey(key);
          setSortOrder('desc'); // Default to descending for new key (or 'asc' for names)
          if (key === 'run_name' || key === 'status') {
            setSortOrder('asc');
          }
      }
  };


  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
        <h1 className="text-3xl font-bold ml-2">Jobs Dashboard</h1>
        <Button
            variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching}
            className="cursor-pointer" >
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          {isFetching ? 'Refresh' : 'Refresh'}
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-grow">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search Run Name, Description, or ID..." // Updated placeholder
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 w-full"
            disabled={isLoading}
          />
        </div>
        <div className="flex items-center gap-2">
            <ListFilter className="h-4 w-4 text-muted-foreground" />
            <Select value={statusFilter} onValueChange={setStatusFilter} disabled={isLoading}>
                <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                    {JOB_STATUSES.map(status => (
                         <SelectItem key={status} value={status} className="capitalize">{status}</SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
        {/* Sort Buttons - Example for multiple sort keys */}
        <Button variant="outline" onClick={() => handleSort('updated_at')} disabled={isLoading} className="cursor-pointer">
            <ArrowDownUp className="mr-2 h-4 w-4" />
            Sort by Date ({sortKey === 'updated_at' ? (sortOrder === 'asc' ? 'Oldest' : 'Newest') : 'Newest'} First)
        </Button>
        <Button variant="outline" onClick={() => handleSort('run_name')} disabled={isLoading} className="cursor-pointer">
            <ArrowDownUp className="mr-2 h-4 w-4" />
            Sort by Run Name ({sortKey === 'run_name' ? (sortOrder === 'asc' ? 'A-Z' : 'Z-A') : 'A-Z'})
        </Button>
      </div>

      {isLoading && (
        <div className="flex flex-col items-center justify-center text-center py-10 gap-2">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <p className="text-muted-foreground">Loading jobs...</p>
        </div>
      )}

      {isError && !isLoading && (
        <Alert variant="destructive" className="mt-4">
          <Terminal className="h-4 w-4" />
          <AlertTitle>Error Loading Jobs</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : "An unknown error occurred."}
             <Button variant="link" size="sm" onClick={() => refetch()} className="ml-2 p-0 h-auto">Retry</Button>
          </AlertDescription>
        </Alert>
      )}

      {!isLoading && !isError && jobs && (
           <JobTable jobs={filteredAndSortedJobs} />
      )}

       {!isLoading && !isError && jobs && filteredAndSortedJobs.length === 0 && (searchTerm || statusFilter !== 'all') && (
           <p className="text-center text-muted-foreground py-8">No jobs match your current filters.</p>
       )}
       {!isLoading && !isError && jobs && jobs.length === 0 && !(searchTerm || statusFilter !== 'all') && (
           <p className="text-center text-muted-foreground py-8">No jobs available yet.</p>
       )}
    </div>
  );
}
