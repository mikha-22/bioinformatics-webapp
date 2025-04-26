// File: frontend_app/components/jobs/JobActions.tsx
"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    MoreHorizontal,
    Play,
    Square,
    RotateCcw,
    Trash2,
    Info,
    FolderGit2,
    Loader2,
    Terminal,
} from "lucide-react";
import { toast } from "sonner";

// UI Component Imports
import { Button, buttonVariants } from "@/components/ui/button";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Type and API Imports
import { Job, SampleInfo, JobMeta, InputFilenames, SarekParams, RunParameters } from "@/lib/types";
import * as api from "@/lib/api";
import { formatDuration } from "@/lib/utils";
import { formatDistanceToNow } from 'date-fns';
import JobLogViewer from "./JobLogViewer";

// --- Helper Functions (Unchanged) ---
function getStatusVariant(internalStatus: string | null | undefined): "default" | "destructive" | "secondary" | "outline" { const status = internalStatus?.toLowerCase(); switch (status) { case 'finished': return 'default'; case 'failed': return 'destructive'; case 'started': case 'running': return 'default'; case 'queued': case 'staged': return 'secondary'; case 'stopped': case 'canceled': return 'outline'; default: return 'secondary'; } }
function formatTimestamp(timestamp: number | null | undefined): string { if (!timestamp) return "N/A"; try { const date = new Date(timestamp * 1000); if (isNaN(date.getTime())) return "Invalid Date"; return date.toLocaleString(); } catch (e) { return "Invalid Date"; } }
function formatTimestampRelative(timestamp: number | null | undefined): string { if (!timestamp) return "N/A"; try { if (timestamp <= 0) return "N/A"; const date = new Date(timestamp * 1000); if (isNaN(date.getTime())) return "Invalid Date"; return formatDistanceToNow(date, { addSuffix: true }); } catch (e) { console.error("Error formatting relative timestamp:", timestamp, e); return "Invalid Date"; } }
const formatParamKey = (key: string): string => key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
const formatParamValue = (value: any): string => { if (value === true) return 'Yes'; if (value === false) return 'No'; if (value === null || value === undefined) return 'N/A'; if (typeof value === 'string' && value.trim() === '') return 'N/A'; if (Array.isArray(value)) { return value.length > 0 ? value.join(', ') : 'N/A'; } if (typeof value === 'object') { return JSON.stringify(value); } return String(value); }
// --- End Helper Functions ---

interface JobActionsProps {
  job: Job | undefined;
}

export default function JobActions({ job }: JobActionsProps) {
    // --- State Management (Unchanged) ---
    const queryClient = useQueryClient();
    const [isDetailsOpen, setIsDetailsOpen] = useState(false);
    const [isStopConfirmOpen, setIsStopConfirmOpen] = useState(false);
    const [isRemoveConfirmOpen, setIsRemoveConfirmOpen] = useState(false);
    const [isRerunConfirmOpen, setIsRerunConfirmOpen] = useState(false);
    const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);
    const [logViewerJobId, setLogViewerJobId] = useState<string | null>(null);
    const jobsQueryKey = ['jobsList'];
    // --- End State Management ---

    // --- Mutations (Unchanged) ---
    const startMutation = useMutation({ mutationFn: api.startJob, onSuccess: (data) => { toast.success(`Job ${data.job_id} started successfully.`); queryClient.invalidateQueries({ queryKey: jobsQueryKey }); }, onError: (error: Error) => { toast.error(`Failed to start job: ${error.message}`); } });
    const stopMutation = useMutation({ mutationFn: api.stopJob, onSuccess: (data) => { toast.info(`${data.message}`); queryClient.invalidateQueries({ queryKey: jobsQueryKey }); }, onError: (error: Error) => { toast.error(`Failed to stop/cancel job: ${error.message}`); }, onSettled: () => setIsStopConfirmOpen(false), });
    const removeMutation = useMutation({ mutationFn: api.removeJob, onSuccess: (data) => { toast.success(`Job ${data.removed_id} removed.`); queryClient.invalidateQueries({ queryKey: jobsQueryKey }); }, onError: (error: Error) => { toast.error(`Failed to remove job: ${error.message}`); queryClient.invalidateQueries({ queryKey: jobsQueryKey }); }, onSettled: () => setIsRemoveConfirmOpen(false), });
    const rerunMutation = useMutation({ mutationFn: api.rerunJob, onSuccess: (data) => { toast.success(`Job ${job?.id} re-staged as ${data.staged_job_id}.`); queryClient.invalidateQueries({ queryKey: jobsQueryKey }); }, onError: (error: Error) => { toast.error(`Failed to re-stage job: ${error.message}`); }, onSettled: () => setIsRerunConfirmOpen(false), });
    // --- End Mutations ---

    // --- Handlers (Unchanged) ---
    const handleStart = () => { if (!job) return; startMutation.mutate(job.id); };
    const handleStop = () => { if (!job) return; stopMutation.mutate(job.id); };
    const handleRemove = () => { if (!job) return; removeMutation.mutate(job.id); };
    const handleRerun = () => { if (!job) return; rerunMutation.mutate(job.id); };
    const handleViewLogs = () => { if (job && !job.id.startsWith("staged_")) { setLogViewerJobId(job.id); setIsLogViewerOpen(true); } };
    // --- End Handlers ---

    // --- Base Check (Unchanged) ---
    if (!job) {
        console.warn("JobActions rendered with undefined job prop");
        return <div className="flex items-center justify-end gap-1 h-9 w-[100px]"></div>;
    }
    // --- End Base Check ---

    // --- Conditional Logic (Unchanged) ---
    const internalStatus = job.status?.toLowerCase();
    const canStart = internalStatus === 'staged';
    const canStop = internalStatus === 'running' || internalStatus === 'started' || internalStatus === 'queued';
    const canRerun = internalStatus === 'finished' || internalStatus === 'failed' || internalStatus === 'stopped' || internalStatus === 'canceled';
    const canRemove = internalStatus === 'staged' || internalStatus === 'finished' || internalStatus === 'failed' || internalStatus === 'stopped' || internalStatus === 'canceled';
    const canViewLogs = internalStatus !== 'staged';

    const meta = job.meta as JobMeta | null | undefined;
    const inputParams = meta?.input_params;
    const sarekParams = meta?.sarek_params;
    const hasParameters = !!(inputParams && Object.keys(inputParams).length > 0) || !!(sarekParams && Object.keys(sarekParams).length > 0);
    // --- End Conditional Logic ---

    return (
        <>
            {/* --- Parent FLEX Container with justify-between --- */}
            <div className="flex items-center justify-between gap-1 w-full">

                {/* --- Group 1: Left-aligned Buttons --- */}
                <div className="flex items-center gap-1">

                    {/* --- Logs Button Rendered FIRST (Always, but maybe disabled) --- */}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleViewLogs}
                        disabled={!canViewLogs} // Disable based on condition
                        className={cn(
                            "h-9 w-9 p-2 flex items-center justify-center hover:bg-accent hover:text-accent-foreground transition-colors",
                            !canViewLogs ? "opacity-50 cursor-not-allowed" : "cursor-pointer" // Style when disabled
                        )}
                        title={canViewLogs ? "View Live Logs" : "Logs not available for staged jobs"}
                    >
                        <Terminal className="h-5 w-5" />
                        <span className="sr-only">View Logs</span>
                    </Button>

                    {/* --- Start Button Rendered SECOND if applicable --- */}
                    {canStart && (
                        <Button variant="ghost" size="icon" onClick={handleStart} disabled={startMutation.isPending} className="h-9 w-9 p-2 flex items-center justify-center hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors" title="Start Job">
                            {startMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-[24px] w-[24px]" />}
                            <span className="sr-only">Start Job</span>
                        </Button>
                    )}

                    {/* Stop Button */}
                    {canStop && (
                        <Button variant="ghost" size="icon" onClick={() => setIsStopConfirmOpen(true)} disabled={stopMutation.isPending} className="h-9 w-9 p-2 flex items-center justify-center hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors" title="Stop/Cancel Job">
                            {stopMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Square className="h-5 w-5" />}
                            <span className="sr-only">Stop/Cancel Job</span>
                        </Button>
                    )}
                    {/* Re-stage Button */}
                     {canRerun && (
                       <Button variant="ghost" size="icon" onClick={() => setIsRerunConfirmOpen(true)} disabled={rerunMutation.isPending} className="h-9 w-9 p-2 flex items-center justify-center hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors" title="Re-stage Job">
                           {rerunMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <RotateCcw className="h-5 w-5" />}
                           <span className="sr-only">Re-stage Job</span>
                       </Button>
                    )}
                </div>
                {/* --- End Group 1 --- */}


                {/* --- Group 2: Right-aligned Buttons (More Actions) --- */}
                <div className="flex items-center gap-1">
                    {/* More Actions Dropdown */}
                    <DropdownMenuPrimitive.Root>
                        <DropdownMenuPrimitive.Trigger asChild>
                            <Button variant="ghost" size="icon" className="h-9 w-9 p-2 flex items-center justify-center hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors flex-shrink-0">
                                <MoreHorizontal className="h-5 w-5" /> <span className="sr-only">Job Actions</span>
                            </Button>
                        </DropdownMenuPrimitive.Trigger>
                        <DropdownMenuPrimitive.Portal>
                            <DropdownMenuPrimitive.Content
                                align="end"
                                sideOffset={4}
                                className="min-w-[12rem] z-50 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"
                            >
                                {/* Dropdown Items remain the same */}
                                <DropdownMenuPrimitive.Item
                                    onSelect={(e) => { e.preventDefault(); setIsDetailsOpen(true); }}
                                    className="relative flex cursor-pointer select-none items-center rounded-sm px-3 py-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                                >
                                    <span className="flex items-center gap-2"><Info className="h-4 w-4" /> View Details</span>
                                </DropdownMenuPrimitive.Item>
                                {job.status === 'finished' && job.result?.results_path && (
                                    <DropdownMenuPrimitive.Item asChild className="relative flex cursor-pointer select-none items-center rounded-sm px-3 py-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground">
                                        <Link href={`/results?highlight=${encodeURIComponent(job.result.results_path.split('/').filter(Boolean).pop() || '')}`} className="flex items-center gap-2">
                                            <FolderGit2 className="h-4 w-4" /> View Results
                                        </Link>
                                    </DropdownMenuPrimitive.Item>
                                )}
                                {canRemove && (
                                    <>
                                        <DropdownMenuPrimitive.Separator className="my-1 h-px bg-muted -mx-1" />
                                        <DropdownMenuPrimitive.Item
                                            onSelect={(e) => { e.preventDefault(); setIsRemoveConfirmOpen(true); }}
                                            disabled={removeMutation.isPending}
                                            className="relative flex cursor-pointer select-none items-center rounded-sm px-3 py-2 text-sm outline-none transition-colors hover:bg-destructive/10 hover:text-destructive text-destructive data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:hover:bg-destructive/20"
                                        >
                                            <span className="flex items-center gap-2">
                                                {removeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remove Job
                                            </span>
                                        </DropdownMenuPrimitive.Item>
                                    </>
                                )}
                            </DropdownMenuPrimitive.Content>
                        </DropdownMenuPrimitive.Portal>
                    </DropdownMenuPrimitive.Root>
                </div>
                {/* --- End Group 2 --- */}

            </div> {/* --- End Parent Flex Container --- */}

            {/* --- Dialogs (Remain the same) --- */}
            <Dialog open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader> <DialogTitle>Job Details: {job.id}</DialogTitle> <DialogDescription>{job.description || "No description provided."}</DialogDescription> </DialogHeader>
                    <div className="mt-4 max-h-[65vh] overflow-y-auto space-y-4 pr-2">
                         {/* Status & Timestamps */}
                         <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                            <div><span className="font-medium text-muted-foreground">Status:</span> <Badge variant={getStatusVariant(job.status)} className="capitalize ml-1">{job.status || 'Unknown'}</Badge></div> <div></div> {/* Spacer */}
                            <div className="font-medium text-muted-foreground">Staged:</div> <div>{formatTimestamp(job.staged_at)} ({formatTimestampRelative(job.staged_at)})</div>
                            <div className="font-medium text-muted-foreground">Enqueued:</div> <div>{formatTimestamp(job.enqueued_at)} ({formatTimestampRelative(job.enqueued_at)})</div>
                            <div className="font-medium text-muted-foreground">Started:</div> <div>{formatTimestamp(job.started_at)} ({formatTimestampRelative(job.started_at)})</div>
                            <div className="font-medium text-muted-foreground">Ended:</div> <div>{formatTimestamp(job.ended_at)} ({formatTimestampRelative(job.ended_at)})</div>
                            <div className="font-medium text-muted-foreground">Duration:</div> <div>{formatDuration(job.resources?.duration_seconds)}</div>
                        </div>
                        {/* Resources */}
                        {job.resources && (job.resources.peak_memory_mb || job.resources.average_cpu_percent) && ( <div> <h4 className="font-semibold mb-1">Resources Used:</h4> <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm pl-4"> <div className="font-medium text-muted-foreground">Peak Memory:</div> <div>{job.resources.peak_memory_mb ? `${job.resources.peak_memory_mb.toFixed(1)} MB` : 'N/A'}</div> <div className="font-medium text-muted-foreground">Average CPU:</div> <div>{job.resources.average_cpu_percent ? `${job.resources.average_cpu_percent.toFixed(1)} %` : 'N/A'}</div> </div> </div> )}
                        {/* Parameters */}
                        {hasParameters && ( <div> <h4 className="font-semibold mb-1">Parameters:</h4> <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm pl-4"> {inputParams && Object.entries(inputParams).map(([key, value]) => ( <React.Fragment key={`input-${key}`}> <div className="font-medium text-muted-foreground truncate" title={key}>{formatParamKey(key)}:</div> <div className="font-mono text-xs break-words" title={String(value ?? '')}>{formatParamValue(value)}</div> </React.Fragment> ))} {sarekParams && Object.entries(sarekParams).map(([key, value]) => ( <React.Fragment key={`sarek-${key}`}> <div className="font-medium text-muted-foreground truncate" title={key}>{formatParamKey(key)}:</div> <div className="font-mono text-xs break-words" title={String(value ?? '')}>{formatParamValue(value)}</div> </React.Fragment> ))} </div> </div> )}
                         {/* Sample Info */}
                         {meta?.sample_info && meta.sample_info.length > 0 && ( <div> <h4 className="font-semibold mb-1">Samples Processed:</h4> <ul className="text-sm pl-4 space-y-1 list-disc list-inside"> {meta.sample_info.map((sample: SampleInfo, index: number) => ( <li key={index}> {sample.patient} / {sample.sample} (Sex: {sample.sex}, Status: {sample.status === 1 ? 'Tumor' : 'Normal'}) {sample.fastq_1 && <span className="block text-xs text-muted-foreground pl-4 truncate" title={`${sample.fastq_1}, ${sample.fastq_2}`}>FASTQs: {sample.fastq_1}, {sample.fastq_2}</span>} {sample.bam_cram && <span className="block text-xs text-muted-foreground pl-4 truncate" title={`${sample.bam_cram}`}>BAM/CRAM: {sample.bam_cram}</span>} {sample.vcf && <span className="block text-xs text-muted-foreground pl-4 truncate" title={`${sample.vcf}`}>VCF: {sample.vcf}</span>} </li> ))} </ul> </div> )}
                        {/* Error Info */}
                        {job.status === 'failed' && ( <div> <h4 className="font-semibold mb-1 text-destructive">Error Details:</h4> <div className="space-y-1 text-sm pl-4"> <p className="font-medium">{job.error || "Job failed"}</p> {meta?.stderr_snippet && ( <pre className="mt-2 text-xs bg-destructive/10 p-2 rounded font-mono whitespace-pre-wrap max-h-40 overflow-y-auto"> <code>{meta.stderr_snippet}</code> </pre> )} </div> </div> )}
                         {/* Result Path */}
                        {job.status === 'finished' && job.result?.results_path && ( <div> <h4 className="font-semibold mb-1">Results Path:</h4> <p className="text-sm pl-4 font-mono break-all">{job.result.results_path}</p> </div> )}
                    </div>
                    <DialogFooter className="mt-4">
                         <DialogClose asChild><Button type="button" variant="outline">Close</Button></DialogClose>
                     </DialogFooter>
                </DialogContent>
             </Dialog>

            <AlertDialog open={isStopConfirmOpen} onOpenChange={setIsStopConfirmOpen}> <AlertDialogContent> <AlertDialogHeader> <AlertDialogTitle>Confirm Stop/Cancel Job</AlertDialogTitle> <AlertDialogDescription> Are you sure you want to stop job <span className="font-mono font-semibold">{job.id}</span>? If it's running, a stop signal will be sent. If it's queued, it will be canceled. </AlertDialogDescription> </AlertDialogHeader> <AlertDialogFooter> <AlertDialogCancel disabled={stopMutation.isPending}>Cancel</AlertDialogCancel> <AlertDialogAction onClick={handleStop} disabled={stopMutation.isPending} className="bg-yellow-500 hover:bg-yellow-600 text-white dark:bg-yellow-600 dark:hover:bg-yellow-700"> {stopMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Stop/Cancel Job </AlertDialogAction> </AlertDialogFooter> </AlertDialogContent> </AlertDialog>
            <AlertDialog open={isRemoveConfirmOpen} onOpenChange={setIsRemoveConfirmOpen}> <AlertDialogContent> <AlertDialogHeader> <AlertDialogTitle>Confirm Remove Job</AlertDialogTitle> <AlertDialogDescription> Are you sure you want to remove job <span className="font-mono font-semibold">{job.id}</span>? This will remove its entry from the list. Results files (if any) will not be deleted. This action cannot be undone. </AlertDialogDescription> </AlertDialogHeader> <AlertDialogFooter> <AlertDialogCancel disabled={removeMutation.isPending}>Cancel</AlertDialogCancel> <AlertDialogAction onClick={handleRemove} disabled={removeMutation.isPending} className={buttonVariants({ variant: "destructive" })}> {removeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Remove Job </AlertDialogAction> </AlertDialogFooter> </AlertDialogContent> </AlertDialog>
            <AlertDialog open={isRerunConfirmOpen} onOpenChange={setIsRerunConfirmOpen}> <AlertDialogContent> <AlertDialogHeader> <AlertDialogTitle>Confirm Re-stage Job</AlertDialogTitle> <AlertDialogDescription> Are you sure you want to re-stage job <span className="font-mono font-semibold">{job.id}</span>? This will create a new 'staged' job entry using the same parameters. </AlertDialogDescription> </AlertDialogHeader> <AlertDialogFooter> <AlertDialogCancel disabled={rerunMutation.isPending}>Cancel</AlertDialogCancel> <AlertDialogAction onClick={handleRerun} disabled={rerunMutation.isPending}> {rerunMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Re-stage Job </AlertDialogAction> </AlertDialogFooter> </AlertDialogContent> </AlertDialog>

             {/* Log Viewer Dialog */}
             {job && (
                  <JobLogViewer
                      jobId={logViewerJobId}
                      isOpen={isLogViewerOpen}
                      onOpenChange={setIsLogViewerOpen}
                      jobDescription={job.description}
                  />
              )}
             {/* --- END DIALOGS --- */}
        </>
    );
}
