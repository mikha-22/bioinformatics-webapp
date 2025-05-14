// File: frontend_app/app/(pages)/jobs/page.tsx
"use client";

import React, { useState, useMemo, useCallback } from "react";
import { useJobsList } from "@/lib/hooks/useJobsList";
import { useMutation, useQueryClient } from "@tanstack/react-query"; // <<< ADDED useMutation, useQueryClient
import { toast } from "sonner"; // <<< ADDED toast
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
import {
  AlertDialog, // <<< ADDED AlertDialog components
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RefreshCw, Search, ArrowDownUp, ListFilter, Terminal, Loader2, Square, Trash2, X, AlertTriangle } from "lucide-react"; // Added AlertTriangle
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Job } from "@/lib/types";
import * as api from "@/lib/api"; // <<< ADDED api import

const JOB_STATUSES = ['all', 'staged', 'queued', 'running', 'finished', 'failed', 'stopped'];
type SortKey = 'updated_at' | 'status' | 'run_name';
type SortOrder = 'asc' | 'desc';

const isJobStoppable = (job: Job): boolean => {
    const status = job.status?.toLowerCase();
    return status === 'running' || status === 'started' || status === 'queued';
};

const isJobRemovable = (job: Job): boolean => {
    const status = job.status?.toLowerCase();
    return status === 'staged' || status === 'finished' || status === 'failed' || status === 'stopped' || status === 'canceled';
};


export default function JobsPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>('updated_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);

  // <<< --- ADDED State for confirmation dialogs --- >>>
  const [isBatchStopConfirmOpen, setIsBatchStopConfirmOpen] = useState(false);
  const [isBatchRemoveConfirmOpen, setIsBatchRemoveConfirmOpen] = useState(false);
  // <<< --- END ADDED State --- >>>

  const queryClient = useQueryClient(); // For invalidating queries

  const { data: jobs, isLoading, isError, error, refetch, isFetching } = useJobsList({
    refetchInterval: 5000,
  });

  const handleRefresh = () => {
    refetch();
    setSelectedJobIds([]);
  };

   const filteredAndSortedJobs = useMemo(() => {
    let filtered = jobs?.filter(job => job && typeof job.job_id === 'string') || [];
    if (searchTerm) {
        const lowerSearchTerm = searchTerm.toLowerCase();
        filtered = filtered.filter((job) => {
            const descriptionMatch = job.description?.toLowerCase().includes(lowerSearchTerm);
            const runNameMatch = job.run_name?.toLowerCase().includes(lowerSearchTerm);
            const jobIdMatch = job.job_id?.toLowerCase().includes(lowerSearchTerm);
            return descriptionMatch || runNameMatch || jobIdMatch;
        });
    }
    if (statusFilter !== 'all') {
        const effectiveStatus = statusFilter === 'running' ? ['running', 'started'] : [statusFilter];
        filtered = filtered.filter((job) => {
            const jobStatusLower = job.status?.toLowerCase();
            return jobStatusLower && effectiveStatus.includes(jobStatusLower);
        });
    }
    filtered.sort((a, b) => {
        let compareA: any = null; let compareB: any = null;
        if (sortKey === 'updated_at') { compareA = a.ended_at || a.started_at || a.enqueued_at || a.staged_at || 0; compareB = b.ended_at || b.started_at || b.enqueued_at || b.staged_at || 0; }
        else if (sortKey === 'status') { compareA = a.status || ''; compareB = b.status || ''; }
        else if (sortKey === 'run_name') { compareA = a.run_name?.toLowerCase() || ''; compareB = b.run_name?.toLowerCase() || ''; }
        const comparison = (compareA < compareB) ? -1 : (compareA > compareB) ? 1 : 0;
        return sortOrder === 'asc' ? comparison : -comparison;
    });
    return filtered;
  }, [jobs, searchTerm, statusFilter, sortKey, sortOrder]);

  const handleSort = (key: SortKey) => {
      if (key === sortKey) { setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }
      else { setSortKey(key); setSortOrder((key === 'run_name' || key === 'status') ? 'asc' : 'desc');}
  };

  const handleSelectJob = useCallback((jobId: string, isSelected: boolean) => {
    setSelectedJobIds(prevSelected => isSelected ? [...prevSelected, jobId] : prevSelected.filter(id => id !== jobId));
  }, []);

  const handleSelectAllJobs = useCallback((isSelected: boolean) => {
    if (isSelected) {
      const allVisibleSelectableIds = filteredAndSortedJobs
        .filter(job => isJobStoppable(job) || isJobRemovable(job)) // Consider only jobs that can have *some* batch action
        .map(job => job.job_id);
      setSelectedJobIds(allVisibleSelectableIds);
    } else {
      setSelectedJobIds([]);
    }
  }, [filteredAndSortedJobs]);

  const handleDeselectAll = () => { setSelectedJobIds([]); };

  const selectedStoppableJobs = useMemo(() => selectedJobIds.filter(id => {
    const job = jobs?.find(j => j.job_id === id); return job && isJobStoppable(job);
  }), [selectedJobIds, jobs]);

  const selectedRemovableJobs = useMemo(() => selectedJobIds.filter(id => {
    const job = jobs?.find(j => j.job_id === id); return job && isJobRemovable(job);
  }), [selectedJobIds, jobs]);


  // <<< --- ADDED Mutations for Batch Actions --- >>>
  const batchStopMutation = useMutation({
    mutationFn: api.batchStopJobs,
    onSuccess: (data) => {
      toast.success(`Batch stop: ${data.succeeded_count} job(s) processed for stopping/cancellation.`, {
        description: data.failed_count > 0 ? `${data.failed_count} job(s) could not be stopped or were already terminal.` : "All eligible jobs processed.",
      });
      queryClient.invalidateQueries({ queryKey: ['jobsList'] });
      setSelectedJobIds([]); // Clear selection
    },
    onError: (error: Error) => {
      toast.error(`Batch stop failed: ${error.message}`);
    },
    onSettled: () => {
      setIsBatchStopConfirmOpen(false);
    }
  });

  const batchRemoveMutation = useMutation({
    mutationFn: api.batchRemoveJobs,
    onSuccess: (data) => {
      toast.success(`Batch remove: ${data.succeeded_count} job(s) removed.`, {
        description: data.failed_count > 0 ? `${data.failed_count} job(s) could not be removed or were not found.` : "All eligible jobs removed.",
      });
      queryClient.invalidateQueries({ queryKey: ['jobsList'] });
      setSelectedJobIds([]); // Clear selection
    },
    onError: (error: Error) => {
      toast.error(`Batch remove failed: ${error.message}`);
    },
    onSettled: () => {
      setIsBatchRemoveConfirmOpen(false);
    }
  });
  // <<< --- END ADDED Mutations --- >>>


  // <<< --- MODIFIED Batch Action Handlers --- >>>
  const handleBatchStop = () => {
    if (selectedStoppableJobs.length > 0) {
      setIsBatchStopConfirmOpen(true); // Open confirmation dialog
    } else {
      toast.info("No selected jobs are currently in a stoppable state (queued, running, or started).");
    }
  };

  const confirmBatchStop = () => {
    if (selectedStoppableJobs.length > 0) {
        batchStopMutation.mutate(selectedStoppableJobs);
    }
  };

  const handleBatchRemove = () => {
     if (selectedRemovableJobs.length > 0) {
      setIsBatchRemoveConfirmOpen(true); // Open confirmation dialog
    } else {
      toast.info("No selected jobs are currently in a removable state (staged, finished, failed, or stopped).");
    }
  };

  const confirmBatchRemove = () => {
    if (selectedRemovableJobs.length > 0) {
        batchRemoveMutation.mutate(selectedRemovableJobs);
    }
  };
  // <<< --- END MODIFIED Batch Action Handlers --- >>>


  return (
    <div className="space-y-6">
      {/* Header and Refresh */}
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
        <h1 className="text-3xl font-bold ml-2">Jobs Dashboard</h1>
        <Button
            variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching || isLoading} // Disable if initial loading too
            className="cursor-pointer" >
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          {isFetching ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Filters and Search */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-grow">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search" placeholder="Search Run Name, Description, or ID..."
            value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 w-full" disabled={isLoading}
          />
        </div>
        <div className="flex items-center gap-2">
            <ListFilter className="h-4 w-4 text-muted-foreground" />
            <Select value={statusFilter} onValueChange={setStatusFilter} disabled={isLoading}>
                <SelectTrigger className="w-full sm:w-[180px]"> <SelectValue placeholder="Filter by status" /> </SelectTrigger>
                <SelectContent>
                    {JOB_STATUSES.map(status => (<SelectItem key={status} value={status} className="capitalize">{status}</SelectItem>))}
                </SelectContent>
            </Select>
        </div>
        <Button variant="outline" onClick={() => handleSort('updated_at')} disabled={isLoading} className="cursor-pointer w-full sm:w-auto">
            <ArrowDownUp className="mr-2 h-4 w-4" /> Sort by Date ({sortKey === 'updated_at' ? (sortOrder === 'asc' ? 'Oldest' : 'Newest') : 'Newest'} First)
        </Button>
        <Button variant="outline" onClick={() => handleSort('run_name')} disabled={isLoading} className="cursor-pointer w-full sm:w-auto">
            <ArrowDownUp className="mr-2 h-4 w-4" /> Sort by Run Name ({sortKey === 'run_name' ? (sortOrder === 'asc' ? 'A-Z' : 'Z-A') : 'A-Z'})
        </Button>
      </div>

      {/* Batch Action Bar */}
      {selectedJobIds.length > 0 && (
        <div className="p-3 my-4 bg-muted/50 border border-border rounded-lg shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{selectedJobIds.length} job(s) selected</span>
            <Button variant="ghost" size="icon" onClick={handleDeselectAll} className="h-7 w-7 text-muted-foreground hover:text-foreground" title="Deselect All">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline" size="sm" onClick={handleBatchStop}
              disabled={selectedStoppableJobs.length === 0 || batchStopMutation.isPending}
              className="cursor-pointer" >
              {batchStopMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
              Stop Selected ({selectedStoppableJobs.length})
            </Button>
            <Button
              variant="destructiveOutline" // Use your custom or a suitable destructive variant
              size="sm" onClick={handleBatchRemove}
              disabled={selectedRemovableJobs.length === 0 || batchRemoveMutation.isPending}
              className="cursor-pointer" >
              {batchRemoveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Remove Selected ({selectedRemovableJobs.length})
            </Button>
          </div>
        </div>
      )}

      {/* Loading and Error States */}
      {isLoading && ( <div className="flex flex-col items-center justify-center text-center py-10 gap-2"> <Loader2 className="h-12 w-12 animate-spin text-primary" /> <p className="text-muted-foreground">Loading jobs...</p> </div> )}
      {isError && !isLoading && ( <Alert variant="destructive" className="mt-4"> <Terminal className="h-4 w-4" /> <AlertTitle>Error Loading Jobs</AlertTitle> <AlertDescription> {error instanceof Error ? error.message : "An unknown error occurred."} <Button variant="link" size="sm" onClick={() => refetch()} className="ml-2 p-0 h-auto">Retry</Button> </AlertDescription> </Alert> )}

      {/* Job Table */}
      {!isLoading && !isError && jobs && (
           <JobTable
              jobs={filteredAndSortedJobs}
              selectedJobIds={selectedJobIds}
              onSelectJob={handleSelectJob}
              onSelectAllJobs={handleSelectAllJobs}
              isJobSelectable={(job) => isJobStoppable(job) || isJobRemovable(job)}
           />
      )}
      {!isLoading && !isError && jobs && filteredAndSortedJobs.length === 0 && (searchTerm || statusFilter !== 'all') && ( <p className="text-center text-muted-foreground py-8">No jobs match your current filters.</p> )}

      {/* --- ADDED Confirmation Dialogs --- */}
      <AlertDialog open={isBatchStopConfirmOpen} onOpenChange={setIsBatchStopConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Batch Stop/Cancel</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to attempt to stop/cancel {selectedStoppableJobs.length} selected job(s)?
              Running jobs will be signaled to stop, queued jobs will be canceled. This action cannot be undone for canceled jobs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={batchStopMutation.isPending}>Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmBatchStop}
              disabled={batchStopMutation.isPending}
              className="bg-yellow-500 hover:bg-yellow-600 text-white dark:bg-yellow-600 dark:hover:bg-yellow-700"
            >
              {batchStopMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Stop/Cancel Selected
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={isBatchRemoveConfirmOpen} onOpenChange={setIsBatchRemoveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Batch Remove</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove {selectedRemovableJobs.length} selected job(s)?
              This will remove their entries from the list. Results files (if any) will NOT be deleted from the server. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={batchRemoveMutation.isPending}>Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmBatchRemove}
              disabled={batchRemoveMutation.isPending}
              // Assuming you have a destructive variant for buttons or use cn()
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {batchRemoveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove Selected
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* --- END ADDED Confirmation Dialogs --- */}
    </div>
  );
}
