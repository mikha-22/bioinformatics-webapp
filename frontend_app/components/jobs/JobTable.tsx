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
import { Job } from "@/lib/types";
import { formatDistanceToNow } from 'date-fns';
import { formatDuration } from "@/lib/utils";
import JobActions from "./JobActions"; // Using the version with <span> wrappers
import React from 'react';

interface JobTableProps {
  jobs: Job[];
}

// Helper functions (keep as they are)
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

function getStatusVariant(status: string | null | undefined): "default" | "destructive" | "secondary" | "outline" {
    switch (status?.toLowerCase()) {
        case 'finished': return 'default';
        case 'failed': return 'destructive';
        case 'running': case 'started': return 'default';
        case 'queued': case 'staged': return 'secondary';
        case 'stopped': case 'canceled': return 'outline';
        default: return 'secondary';
    }
}

export default function JobTable({ jobs }: JobTableProps) {
  // console.log("JobTable component received jobs prop:", jobs); // Keep logs if needed

  if (!jobs || jobs.length === 0) {
    // console.log("JobTable rendering 'No jobs found.' message");
    return <p className="text-center text-muted-foreground py-8">No jobs found.</p>;
  }

  // console.log("JobTable rendering the actual table with jobs:", jobs);

  return (
    <div className="border rounded-lg overflow-hidden overflow-x-auto">
      <Table>
        <TableCaption className="mt-4">A list of your pipeline jobs.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px] hidden lg:table-cell">Job ID</TableHead>
            <TableHead>Description / ID</TableHead>
            <TableHead className="w-[100px] hidden xl:table-cell">Step</TableHead>
            <TableHead className="w-[100px] hidden xl:table-cell">Genome</TableHead>
            <TableHead className="w-[120px] hidden md:table-cell">Duration</TableHead>
            <TableHead className="w-[150px] hidden sm:table-cell">Last Updated</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead className="text-right w-[60px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id} data-state={job.status === 'finished' ? 'completed' : job.status === 'failed' ? 'error' : undefined}>
              <TableCell className="font-mono text-xs hidden lg:table-cell" title={job.id}>
                {job.id.startsWith("staged_") ? "STAGED" : "RQ"}
                <span className="text-muted-foreground">_</span>
                {job.id.substring(job.id.indexOf('_') + 1, job.id.indexOf('_') + 9)}...
              </TableCell>
              <TableCell className="max-w-xs truncate" title={job.description ?? job.id}>
                <span className="lg:hidden font-mono text-xs mr-1">
                  {job.id.startsWith("staged_") ? "STG" : "RQ"}
                  <span className="text-muted-foreground">_</span>
                  {job.id.substring(job.id.indexOf('_') + 1, job.id.indexOf('_') + 9)}...
                </span>
                <span className="lg:hidden mr-1">|</span>
                {job.description || <span className="italic text-muted-foreground">{job.id.startsWith("staged_") ? 'Staged Job' : 'Pipeline Job'}</span>}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground hidden xl:table-cell">
                {job.meta?.sarek_params?.step || 'all'}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground hidden xl:table-cell">
                {job.meta?.sarek_params?.genome || 'N/A'}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground hidden md:table-cell">
                {formatDuration(job.resources?.duration_seconds)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground hidden sm:table-cell">
                {formatTimestamp(job.ended_at || job.started_at || job.enqueued_at || job.staged_at)}
              </TableCell>
              <TableCell>
                <Badge variant={getStatusVariant(job.status)} className="capitalize text-xs px-1.5 py-0.5">
                  {job.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right p-1">
                <JobActions job={job} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
