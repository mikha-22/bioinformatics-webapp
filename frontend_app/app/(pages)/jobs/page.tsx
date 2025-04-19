// File: frontend_app/app/(pages)/jobs/page.tsx
"use client";

import React, { useState, useMemo } from "react";
import { useJobsList } from "@/lib/hooks/useJobsList";
import JobTable from "@/components/jobs/JobTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input"; // For search/filter
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"; // For status filter
import { RefreshCw, Search, ArrowDownUp, ListFilter, Terminal, Loader2 } from "lucide-react"; // Import icons, added Terminal, Loader2
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import ErrorDisplay from '@/components/common/ErrorDisplay'; // Import ErrorDisplay (already present)
import { Job } from "@/lib/types"; // Import Job type

const JOB_STATUSES = ['all', 'staged', 'queued', 'running', 'finished', 'failed', 'stopped'];
type SortKey = 'updated_at' | 'status'; // Add more if needed
type SortOrder = 'asc' | 'desc';

export default function JobsPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>('updated_at'); // Default sort
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc"); // Default sort order

  // Fetch jobs list, enable polling every 5 seconds
  const { data: jobs, isLoading, isError, error, refetch, isFetching } = useJobsList({
    refetchInterval: 5000, // Poll every 5000ms (5 seconds)
  });

  // --- ADD LOGGING HERE ---
  console.log("JobsPage - Raw data from useJobsList:", jobs);
  // ------------------------

  const handleRefresh = () => {
    refetch(); // Manually trigger a refetch
  };

   // --- Client-side Filtering and Sorting (Still calculated, but not used for rendering JobTable in this version) ---
   const filteredAndSortedJobs = useMemo(() => {
    let filtered = jobs ?? []; // Start with fetched jobs or empty array

    // --- ADD LOGGING ---
    console.log("JobsPage - Before filtering/sorting:", filtered);
    // -----------------

    // Filter by search term (case-insensitive on description or ID)
    if (searchTerm) {
        const lowerSearchTerm = searchTerm.toLowerCase();
        filtered = filtered.filter((job) =>
            job.description?.toLowerCase().includes(lowerSearchTerm) ||
            job.id.toLowerCase().includes(lowerSearchTerm)
        );
    }

    // Filter by status
    if (statusFilter !== 'all') {
        const effectiveStatus = statusFilter === 'running' ? ['running', 'started'] : [statusFilter];
        filtered = filtered.filter((job) => effectiveStatus.includes(job.status?.toLowerCase()));
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
        }

        const comparison = (compareA < compareB) ? -1 : (compareA > compareB) ? 1 : 0;
        return sortOrder === 'asc' ? comparison : -comparison; // Apply order
    });

    // --- ADD LOGGING ---
    console.log("JobsPage - After filtering/sorting (calculated but maybe not used):", filtered);
    // -----------------

    return filtered;
  }, [jobs, searchTerm, statusFilter, sortKey, sortOrder]);

  // Toggle sort order for the current key
  const handleSort = (key: SortKey) => {
      if (key === sortKey) {
          setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
      } else {
          setSortKey(key);
          setSortOrder('desc'); // Default to descending for new key
      }
  };


  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
        <h1 className="text-3xl font-bold ml-2">Jobs Dashboard</h1>
        <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isFetching}
            className="cursor-pointer" // Keep cursor
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          {isFetching ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Filter and Sort Controls */}
      <div className="flex flex-col sm:flex-row gap-4">
         {/* Search */}
        <div className="relative flex-grow">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search description or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 w-full"
            disabled={isLoading} // Disable controls while initial loading
          />
        </div>
         {/* Status Filter */}
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
         {/* Sort Button */}
        <Button
            variant="outline"
            onClick={() => handleSort('updated_at')}
            disabled={isLoading}
            className="cursor-pointer" // Keep cursor
        >
            <ArrowDownUp className="mr-2 h-4 w-4" />
            Sort by Date ({sortOrder === 'asc' ? 'Oldest' : 'Newest'} First)
        </Button>
      </div>


      {/* Loading State */}
      {isLoading && (
        <div className="flex flex-col items-center justify-center text-center py-10 gap-2">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <p className="text-muted-foreground">Loading jobs...</p>
        </div>
      )}


      {/* Display Error State */}
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

      {/* Display Job Table when data is loaded successfully */}
      {!isLoading && !isError && jobs && (
           <JobTable jobs={filteredAndSortedJobs} />
      )}

       {/* Display message if filters result in no jobs */}
       {!isLoading && !isError && jobs && filteredAndSortedJobs.length === 0 && (searchTerm || statusFilter !== 'all') && (
           <p className="text-center text-muted-foreground py-8">No jobs match your current filters.</p>
       )}
       {/* Display message if the original list was empty */}
       {!isLoading && !isError && jobs && jobs.length === 0 && !(searchTerm || statusFilter !== 'all') && (
           <p className="text-center text-muted-foreground py-8">No jobs available yet.</p>
       )}

    </div>
  );
}
