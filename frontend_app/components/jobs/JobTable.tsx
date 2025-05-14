// File: frontend_app/components/jobs/JobTable.tsx
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Job } from "@/lib/types";
import { formatDistanceToNow } from 'date-fns';
import { formatDuration } from "@/lib/utils";
import JobActions from "./JobActions";
import React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import LiveDuration from "./LiveDuration";
import { Progress } from "@/components/ui/progress";

interface JobTableProps {
  jobs: Job[];
  selectedJobIds: string[];
  onSelectJob: (jobId: string, isSelected: boolean) => void;
  onSelectAllJobs: (isSelected: boolean) => void;
  isJobSelectable?: (job: Job) => boolean;
}

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
        case 'started': case 'running': return 'default';
        case 'queued': case 'staged': return 'secondary';
        case 'stopped': case 'canceled': return 'outline';
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

export default function JobTable({
  jobs,
  selectedJobIds,
  onSelectJob,
  onSelectAllJobs,
  isJobSelectable
}: JobTableProps) {

  const validJobs = jobs?.filter(job => job && typeof job.job_id === 'string') || [];

  if (!jobs || jobs.length === 0) {
    return <p className="text-center text-muted-foreground py-8">No jobs found.</p>;
  }
  if (validJobs.length === 0 && jobs.length > 0) {
      console.warn("JobTable: All jobs received were invalid or missing a job_id.", jobs);
      return <p className="text-center text-destructive py-8">Error: Received invalid job data.</p>;
  }

  const formatDisplayJobId = (fullJobId: string): string => {
    if (!fullJobId) return "N/A";
    const prefix = fullJobId.startsWith("staged_") ? "STG" :
                   fullJobId.startsWith("rqjob_") ? "RQ" : "ID";
    let mainIdPart = fullJobId;
    if (fullJobId.startsWith("staged_")) { mainIdPart = fullJobId.substring("staged_".length); }
    else if (fullJobId.startsWith("rqjob_")) { mainIdPart = fullJobId.substring("rqjob_".length); }
    return mainIdPart.length > 6 ? `${prefix}_...${mainIdPart.slice(-6)}` : `${prefix}_${mainIdPart}`;
  };

  const getProgressDisplayInfo = (job: Job): { text: string; percentage: number | null; taskCounts?: string } => {
    const status = job.status?.toLowerCase();
    const meta = job.meta;
    const currentTaskFromMeta = meta?.current_task;
    const configuredStep = meta?.sarek_params?.step;
    let text = "N/A";
    let percentage: number | null = null;
    let taskCounts: string | undefined = undefined;

    if (typeof meta?.completed_task_count === 'number' && typeof meta?.submitted_task_count === 'number' && meta.submitted_task_count > 0) {
        taskCounts = `[${meta.completed_task_count}/${meta.submitted_task_count}]`;
    }

    if (status === 'running' || status === 'started') {
        text = currentTaskFromMeta ? `Running: ${currentTaskFromMeta}` : (configuredStep ? `Starting: ${configuredStep}` : "Processing...");
        if (typeof meta?.overall_progress === 'number') {
            percentage = Math.max(0, Math.min(100, meta.overall_progress));
        }
    } else if (status === 'finished') {
        text = `Completed`;
        percentage = 100;
    } else if (status === 'failed') {
        text = `Failed: ${currentTaskFromMeta || (configuredStep ? `at ${configuredStep}` : 'Unknown step')}`;
        if (typeof meta?.overall_progress === 'number') {
            percentage = Math.max(0, Math.min(100, meta.overall_progress));
        }
    } else if (status === 'queued') {
        text = "Queued"; percentage = 0;
    } else if (status === 'staged') {
        text = "Staged"; percentage = 0;
    } else if (status === 'stopped' || status === 'canceled') {
        text = `Stopped: ${currentTaskFromMeta || 'User action'}`;
        if (typeof meta?.overall_progress === 'number') {
            percentage = Math.max(0, Math.min(100, meta.overall_progress));
        }
    } else {
        text = mapToUiStatus(job.status);
    }
    return { text, percentage, taskCounts };
  };

  const selectableJobsInView = validJobs.filter(job => isJobSelectable ? isJobSelectable(job) : true);
  const allSelectableInViewSelected = selectableJobsInView.length > 0 && selectableJobsInView.every(job => selectedJobIds.includes(job.job_id));
  const isIndeterminate = selectedJobIds.length > 0 && !allSelectableInViewSelected && selectableJobsInView.some(job => selectedJobIds.includes(job.job_id));

  return (
    <div className="border rounded-lg overflow-hidden overflow-x-auto">
      <Table>
        <TableCaption className="mt-4">A list of your pipeline jobs. Select jobs to perform batch actions.</TableCaption>
        <TableHeader>
          <TableRow>{/* Ensure no whitespace or comments directly inside TableRow or between TableHead elements */}
            <TableHead className="w-[60px] px-2 sm:px-4">
              <Checkbox
                checked={allSelectableInViewSelected}
                onCheckedChange={(checked) => { onSelectAllJobs(checked === true); }}
                aria-label="Select all jobs in current view"
                data-state={isIndeterminate ? "indeterminate" : (allSelectableInViewSelected ? "checked" : "unchecked")}
                disabled={selectableJobsInView.length === 0}
              />
            </TableHead>
            <TableHead className="w-[120px] hidden lg:table-cell">Job ID</TableHead>
            <TableHead className="min-w-[150px] max-w-[250px]">Run Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[250px] hidden md:table-cell">Progress</TableHead>
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
            const { text: progressText, percentage: progressPercentage, taskCounts } = getProgressDisplayInfo(job);
            const isSelected = selectedJobIds.includes(job.job_id);
            const selectable = isJobSelectable ? isJobSelectable(job) : true;
            const displayProgressText = taskCounts ? `${progressText} ${taskCounts}` : progressText;

            return (
              <TableRow key={job.job_id} data-state={isSelected ? "selected" : undefined}>{/* Ensure no whitespace or comments directly inside TableRow or between TableCell elements */}
                <TableCell className="px-2 sm:px-4">
                  <Checkbox checked={isSelected} onCheckedChange={(checked) => onSelectJob(job.job_id, checked === true)} aria-label={`Select job ${job.job_id}`} disabled={!selectable} />
                </TableCell>
                <TableCell className="font-mono text-xs hidden lg:table-cell" title={job.job_id}>{formatDisplayJobId(job.job_id)}</TableCell>
                <TableCell className="font-medium min-w-[150px] max-w-[250px] truncate" title={job.run_name ?? "N/A"}>
                  <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild><span className="block truncate">{job.run_name || <span className="italic text-muted-foreground">N/A</span>}</span></TooltipTrigger>{job.run_name && job.run_name.length > 30 && (<TooltipContent side="top" align="start"><p>{job.run_name}</p></TooltipContent>)}</Tooltip></TooltipProvider>
                  <div className="lg:hidden text-xs text-muted-foreground font-mono mt-0.5" title={job.job_id}>{formatDisplayJobId(job.job_id)}</div>
                </TableCell>
                <TableCell className="max-w-xs truncate" title={job.description ?? "No description"}>{job.description || <span className="italic text-muted-foreground">No description</span>}</TableCell>
                <TableCell className="text-sm text-muted-foreground hidden md:table-cell">
                  <div className="flex flex-col space-y-1 w-full">
                    {/* Conditionally render TooltipProvider only if displayProgressText is non-empty */}
                    {displayProgressText && displayProgressText.trim().length > 0 ? (
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            {/* Ensure this span is always a valid React element child */}
                            <span className="truncate text-xs block" style={{maxWidth: "200px"}} title={displayProgressText}>
                              {displayProgressText}
                            </span>
                          </TooltipTrigger>
                          {/* Only render TooltipContent if text is actually long enough to be truncated or warrants a tooltip */}
                          {displayProgressText.length > 35 && (
                            <TooltipContent side="top" align="start" className="max-w-xs break-words">
                              <p>{displayProgressText}</p>
                            </TooltipContent>
                          )}
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span className="truncate text-xs block" style={{maxWidth: "200px"}}>{progressText || "N/A"}</span>
                    )}
                    {(progressPercentage !== null && (internalStatus === 'running' || internalStatus === 'started' || internalStatus === 'finished' || internalStatus === 'failed' || internalStatus === 'stopped' || internalStatus === 'canceled' || internalStatus === 'queued' || internalStatus === 'staged')) && (
                      <Progress
                        value={progressPercentage}
                        className="h-2 w-full"
                        indicatorClassName={
                            internalStatus === 'failed' ? "bg-destructive" :
                            (internalStatus === 'finished' || progressPercentage === 100) ? "bg-green-500" :
                            (internalStatus === 'queued' || internalStatus === 'staged') ? "bg-muted-foreground/30" :
                            "bg-primary"
                        } />
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground hidden md:table-cell">
                  {isActiveJob && job.started_at ? ( <LiveDuration startedAt={job.started_at} status={job.status} /> ) : ( formatDuration(job.resources?.duration_seconds) )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground hidden sm:table-cell">{formatTimestamp(job.ended_at || job.started_at || job.enqueued_at || job.staged_at)}</TableCell>
                <TableCell><Badge variant={getStatusVariant(job.status)} className="text-xs px-1.5 py-0.5">{mapToUiStatus(job.status)}</Badge></TableCell>
                <TableCell className="text-right p-1"><JobActions job={job} /></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
