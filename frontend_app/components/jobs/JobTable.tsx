// File: frontend_app/components/jobs/JobTable.tsx
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"; // Using the reverted, known-good table.tsx
import { Badge } from "@/components/ui/badge";
import { Job } from "@/lib/types";
import { formatDistanceToNow } from 'date-fns';
import { formatDuration } from "@/lib/utils";
import JobActions from "./JobActions";
import React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import LiveDuration from "./LiveDuration";

interface JobTableProps {
  jobs: Job[];
}

// --- Helper Functions (mapToUiStatus, getStatusVariant, formatTimestamp) ---
// (These are assumed to be correct and are not the source of the hydration error)
function mapToUiStatus(internalStatus: string | null | undefined): string {
    const status = internalStatus?.toLowerCase();
    switch (status) {
        case 'staged': return 'Staged';
        case 'queued': return 'Queued';
        case 'started': return 'Running';
        case 'running': return 'Running';
        case 'finished': return 'Finished';
        case 'failed': return 'Failed';
        case 'canceled': return 'Stopped';
        case 'stopped': return 'Stopped';
        default: return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown';
    }
}

function getStatusVariant(internalStatus: string | null | undefined): "default" | "destructive" | "secondary" | "outline" {
    const status = internalStatus?.toLowerCase();
    switch (status) {
        case 'finished': return 'default';
        case 'failed': return 'destructive';
        case 'started':
        case 'running': return 'default';
        case 'queued':
        case 'staged': return 'secondary';
        case 'stopped':
        case 'canceled': return 'outline';
        default: return 'secondary';
    }
}

function formatTimestamp(timestamp: number | null | undefined): React.ReactElement | string {
  if (!timestamp) return "N/A";
  try {
    const date = new Date(timestamp * 1000);
    if (isNaN(date.getTime())) return "Invalid Date";
    const relative = formatDistanceToNow(date, { addSuffix: true });
    const absolute = date.toLocaleString();
    return <span title={absolute}>{relative}</span>;
  } catch (e) {
    console.error("Error formatting timestamp:", timestamp, e);
    return "Invalid Date";
  }
}
// --- End Helper Functions ---

export default function JobTable({ jobs }: JobTableProps) {

  const validJobs = jobs?.filter(job => job && typeof job.job_id === 'string') || [];

  if (!validJobs || validJobs.length === 0) {
    if (jobs && jobs.length > 0 && validJobs.length === 0) {
        console.warn("JobTable: All jobs received were invalid or missing a job_id.", jobs);
        return <p className="text-center text-destructive py-8">Error: Received invalid job data.</p>;
    }
    return <p className="text-center text-muted-foreground py-8">No jobs found.</p>;
  }

  const formatDisplayJobId = (fullJobId: string): string => {
    if (!fullJobId) return "N/A";
    const prefix = fullJobId.startsWith("staged_") ? "STG" :
                   fullJobId.startsWith("rqjob_") ? "RQ" : "ID";
    let mainIdPart = fullJobId;
    if (fullJobId.startsWith("staged_")) {
        mainIdPart = fullJobId.substring("staged_".length);
    } else if (fullJobId.startsWith("rqjob_")) {
        mainIdPart = fullJobId.substring("rqjob_".length);
    }
    if (mainIdPart.length > 6) {
      return `${prefix}_...${mainIdPart.slice(-6)}`;
    }
    return `${prefix}_${mainIdPart}`;
  };

  const getCurrentTaskDisplay = (job: Job): string => {
    const status = job.status?.toLowerCase();
    const currentTaskFromMeta = job.meta?.current_task;
    const configuredStep = job.meta?.sarek_params?.step;

    if (status === 'running' || status === 'started') {
      if (currentTaskFromMeta) {
        return `Running: ${currentTaskFromMeta}`;
      }
      return configuredStep ? `Starting: ${configuredStep}` : "Processing...";
    }
    if (status === 'finished') {
      return currentTaskFromMeta || (configuredStep ? `Completed: ${configuredStep}` : "Finished");
    }
    if (status === 'failed') {
      return currentTaskFromMeta || (configuredStep ? `Failed at: ${configuredStep}` : "Failed");
    }
    if (status === 'queued') return "Queued";
    if (status === 'staged') return "Staged";
    if (status === 'stopped' || status === 'canceled') {
        return currentTaskFromMeta || "Stopped";
    }
    return "N/A";
  };

  return (
    <div className="border rounded-lg overflow-hidden overflow-x-auto">
      <Table>
        <TableCaption className="mt-4">A list of your pipeline jobs.</TableCaption>
        <TableHeader>
          {/* Ensure no whitespace directly inside TableRow if it's the only child of TableHeader */}
          <TableRow>
            <TableHead className="w-[120px] hidden lg:table-cell">Job ID</TableHead>
            <TableHead className="min-w-[150px] max-w-[250px]">Run Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[180px] hidden md:table-cell">Progress</TableHead>
            <TableHead className="w-[120px] hidden md:table-cell">Duration</TableHead>
            <TableHead className="w-[150px] hidden sm:table-cell">Last Updated</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead className="text-center w-[60px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {validJobs.map((job) => {
            const internalStatus = job.status?.toLowerCase();
            const isActiveJob = internalStatus === 'running' || internalStatus === 'started';
            const currentTaskText = getCurrentTaskDisplay(job);

            // CRITICAL: Ensure no whitespace or comments are rendered directly between <TableRow> and <TableCell>
            // or between <TableCell> elements.
            return (
              <TableRow key={job.job_id} data-state={job.status === 'finished' ? 'completed' : job.status === 'failed' ? 'error' : undefined}>
                <TableCell className="font-mono text-xs hidden lg:table-cell" title={job.job_id}>{formatDisplayJobId(job.job_id)}</TableCell>
                <TableCell className="font-medium min-w-[150px] max-w-[250px] truncate" title={job.run_name ?? "N/A"}>
                  <TooltipProvider delayDuration={300}>
                      <Tooltip>
                          <TooltipTrigger asChild>
                               <span className="block truncate">{job.run_name || <span className="italic text-muted-foreground">N/A</span>}</span>
                          </TooltipTrigger>
                          {job.run_name && job.run_name.length > 30 && (
                              <TooltipContent side="top" align="start">
                                  <p>{job.run_name}</p>
                              </TooltipContent>
                          )}
                      </Tooltip>
                  </TooltipProvider>
                  <div className="lg:hidden text-xs text-muted-foreground font-mono mt-0.5" title={job.job_id}>
                      {formatDisplayJobId(job.job_id)}
                  </div>
                </TableCell>
                <TableCell className="max-w-xs truncate" title={job.description ?? "No description"}>{job.description || <span className="italic text-muted-foreground">No description</span>}</TableCell>
                <TableCell className="text-sm text-muted-foreground hidden md:table-cell truncate" title={currentTaskText}>{currentTaskText}</TableCell>
                <TableCell className="text-sm text-muted-foreground hidden md:table-cell">
                  {isActiveJob && job.started_at ? (
                    <LiveDuration startedAt={job.started_at} status={job.status} />
                  ) : (
                    formatDuration(job.resources?.duration_seconds)
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground hidden sm:table-cell">{formatTimestamp(job.ended_at || job.started_at || job.enqueued_at || job.staged_at)}</TableCell>
                <TableCell>
                  <Badge variant={getStatusVariant(job.status)} className="text-xs px-1.5 py-0.5">
                    {mapToUiStatus(job.status)}
                  </Badge>
                </TableCell>
                <TableCell className="text-right p-1"><JobActions job={job} /></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
