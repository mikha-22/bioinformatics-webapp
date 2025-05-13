// File: frontend_app/components/results/RunItem.tsx
"use client";

import React, { useState, useMemo } from "react";
import Link from "next/link";
import { FolderGit2, Cog, Download, ExternalLink, Loader2, AlertCircle, Settings2, ChevronDown, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useFileBrowser } from "@/components/layout/FileBrowserContext";

import { ResultRun, ResultItem, RunParameters } from "@/lib/types";
import * as api from "@/lib/api";
import LoadingSpinner from "@/components/common/LoadingSpinner";
import ErrorDisplay from "@/components/common/ErrorDisplay";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from 'date-fns';
import FileList from "./FileList";

interface RunItemProps {
  run: ResultRun;
  isHighlighted: boolean;
  onExpandToggle: (runName: string, isOpening: boolean) => void;
  isExpanded: boolean;
}

// Helper function to format parameters for display
const formatParamValue = (value: string | number | boolean | null | undefined | any[] | Record<string, any>): string => {
    if (value === true) return 'Yes';
    if (value === false) return 'No';
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'string' && value.trim() === '') return 'N/A';
    if (Array.isArray(value)) { return value.length > 0 ? value.join(', ') : 'N/A'; }
    if (typeof value === 'object') { return JSON.stringify(value); }
    return String(value);
}

// Helper function to format keys (make more readable)
const formatParamKey = (key: string): string => {
    const keyMap: Record<string, string> = {
        'skip_baserecalibrator': 'Skip Base Recalibration',
        'skip_qc': 'Skip QC',
        'skip_annotation': 'Skip Annotation',
        'wes': 'WES Mode',
        'joint_germline': 'Joint Germline',
        'trim_fastq': 'Trim FASTQ',
    };
    return keyMap[key] || key
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
}


export default function RunItem({ run, isHighlighted, onExpandToggle, isExpanded }: RunItemProps) {
  const [isParamsOpen, setIsParamsOpen] = useState(false);
  const { openFileBrowser } = useFileBrowser();

  const {
    data: runFiles,
    isLoading: isLoadingFiles,
    isError: isErrorFiles,
    error: errorFiles,
  } = useQuery<ResultItem[], Error>({
    queryKey: ["resultRun", run.name],
    queryFn: () => api.getResultRunFiles(run.name),
    enabled: isExpanded,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const multiqcReportInfo = useMemo(() => {
    if (!runFiles) return null;
    const multiqcFile = runFiles.find(
      (file) => file.name === 'multiqc_report.html' && !file.is_dir
    );
    if (multiqcFile) {
      const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "";
      // Use relative_path which includes subdirectories like "multiqc/" or "Reports/MultiQC/"
      const filePathForUrl = multiqcFile.relative_path || multiqcFile.name;

      return {
        url: `${apiBaseUrl}/api/results/${encodeURIComponent(run.name)}/static/${filePathForUrl.split('/').map(segment => encodeURIComponent(segment)).join('/')}`,
        filebrowserLink: multiqcFile.filebrowser_link // Keep for other potential uses
      };
    }
    return null;
  }, [runFiles, run.name]);

  const {
    data: parameters,
    isLoading: isLoadingParams,
    isError: isErrorParams,
    error: errorParams,
  } = useQuery<RunParameters, Error>({
    queryKey: ["resultParams", run.name],
    queryFn: () => api.getResultRunParameters(run.name),
    enabled: isParamsOpen,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const downloadRunMutation = useMutation({
     mutationFn: (runName: string) => api.downloadResultRun(runName),
     onSuccess: (blob, runName) => {
        try {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${runName}.zip`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            toast.success(`Started download for ${runName}.zip`);
        } catch (e) {
             console.error("Error creating download link:", e);
             toast.error("Failed to initiate download.");
        }
     },
     onError: (error: Error, runName) => {
        console.error(`Error downloading ${runName}:`, error);
        toast.error(`Download failed: ${error.message}`);
     }
  });

  const handleDownloadRun = () => {
    downloadRunMutation.mutate(run.name);
  };

  const handleOpenParams = () => {
      setIsParamsOpen(true);
  };

  const handleOpenFileBrowser = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (run.filebrowser_link) {
      openFileBrowser(run.filebrowser_link);
    }
  };

  const formatTimestamp = (timestamp: number | null | undefined): string => {
    if (!timestamp) return "N/A";
    try {
        if (timestamp <= 0) return "Invalid Date";
        const date = new Date(timestamp * 1000);
        if (isNaN(date.getTime())) return "Invalid Date";
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString()} (${formatDistanceToNow(date, { addSuffix: true })})`;
    } catch (e) {
        console.error("Error formatting timestamp:", timestamp, e);
        return "Invalid Date";
    }
  };

  return (
    <>
      <Accordion type="single" collapsible value={isExpanded ? run.name : ""} onValueChange={(value) => onExpandToggle(run.name, !!value)} className="[&>*]:border-b">
        <AccordionItem value={run.name} className={cn(
          "rounded-lg mb-4 overflow-hidden group/item",
          "border border-border bg-card",
          "shadow-sm last:border-b-1",
          "transition-all duration-200 hover:bg-muted/50",
          isHighlighted && "ring-4 ring-blue-500/30 ring-offset-2"
        )}>
          <div
            className="flex items-center justify-between px-4 cursor-pointer"
            onClick={() => onExpandToggle(run.name, !isExpanded)}
          >
            <div className="flex items-center gap-3 min-w-0 py-3">
              <FolderGit2 className="h-5 w-5 text-primary flex-shrink-0" />
              <div className="text-left min-w-0">
                <span className="font-semibold text-foreground block truncate" title={run.name}>{run.name}</span>
                <p className="text-xs text-muted-foreground block truncate">
                  Modified: {formatTimestamp(run.modified_time)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 py-3" onClick={e => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleOpenParams}
                title="View Parameters"
                className="h-7 w-7 cursor-pointer hover:bg-muted/80"
              >
                {isLoadingParams ? <Loader2 className="h-4 w-4 animate-spin"/> : <Settings2 className="h-4 w-4" />}
                <span className="sr-only">View Parameters</span>
              </Button>

              {multiqcReportInfo && multiqcReportInfo.url && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="Open MultiQC Report"
                  className="h-7 w-7 cursor-pointer hover:bg-muted/80"
                  asChild
                >
                  <Link href={multiqcReportInfo.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                    <BarChart3 className="h-4 w-4" />
                    <span className="sr-only">Open MultiQC Report</span>
                  </Link>
                </Button>
              )}

              {run.filebrowser_link && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="Open in File Browser"
                  className="h-7 w-7 cursor-pointer hover:bg-muted/80"
                  onClick={handleOpenFileBrowser}
                >
                  <ExternalLink className="h-4 w-4" />
                  <span className="sr-only">Open in File Browser</span>
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={handleDownloadRun}
                title="Download Run (.zip)"
                disabled={downloadRunMutation.isPending}
                className="h-7 w-7 cursor-pointer hover:bg-muted/80"
              >
                {downloadRunMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin"/> : <Download className="h-4 w-4" />}
                <span className="sr-only">Download Run</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  onExpandToggle(run.name, !isExpanded);
                }}
                className="h-7 w-7 cursor-pointer hover:bg-muted/80"
                title={isExpanded ? "Collapse" : "Expand"}
              >
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                    isExpanded && "rotate-180"
                  )}
                />
                <span className="sr-only">{isExpanded ? "Collapse" : "Expand"}</span>
              </Button>
            </div>
          </div>
          <AccordionContent className={cn(
            "bg-card",
            "border-t border-border",
            "overflow-hidden",
            "!border-b !border-b-border" // Ensure bottom border is applied correctly
          )}>
             <div className="p-4">
               {isLoadingFiles && <div className="text-center p-4"><LoadingSpinner label="Loading files..." /></div>}
               {isErrorFiles && <ErrorDisplay error={errorFiles} title="Error Loading Files" />}
               {!isLoadingFiles && !isErrorFiles && runFiles && (
                 <FileList files={runFiles} runName={run.name} />
               )}
               {!isLoadingFiles && !isErrorFiles && (!runFiles || runFiles.length === 0) && (
                   <p className="text-center text-muted-foreground p-4">No files found in this run.</p>
               )}
             </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <Dialog open={isParamsOpen} onOpenChange={setIsParamsOpen}>
          <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                  <DialogTitle>Parameters for Run: {run.name}</DialogTitle>
                  <DialogDescription>
                     Configuration used for this pipeline run.
                  </DialogDescription>
              </DialogHeader>
               {isLoadingParams && <div className="py-8 flex justify-center"><LoadingSpinner label="Loading parameters..." /></div>}
               {isErrorParams && (
                  <div className="flex items-center gap-2 text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/30">
                    <AlertCircle className="h-5 w-5 mt-1 self-start flex-shrink-0"/>
                    <div>
                       <p className="font-medium">Error Loading Parameters</p>
                       <p className="text-sm">{errorParams instanceof Error ? errorParams.message : String(errorParams)}</p>
                    </div>
                 </div>
               )}
               {!isLoadingParams && !isErrorParams && parameters && (Object.keys(parameters.input_filenames || {}).length > 0 || Object.keys(parameters.sarek_params || {}).length > 0) && (
                 <div className="mt-4 max-h-[60vh] overflow-y-auto rounded-md border bg-muted/30 p-4 text-sm space-y-2">
                   {parameters.input_filenames && Object.entries(parameters.input_filenames).map(([key, value]) => (
                       <div key={`input-${key}`} className="grid grid-cols-3 gap-x-2 items-center">
                           <div className="font-medium text-muted-foreground capitalize truncate" title={key}>{formatParamKey(key)}:</div>
                           <div className="col-span-2 font-mono text-xs break-words" title={String(value ?? '')}>
                               {formatParamValue(value)}
                           </div>
                       </div>
                   ))}
                   {parameters.sarek_params && Object.entries(parameters.sarek_params).map(([key, value]) => (
                       <div key={`sarek-${key}`} className="grid grid-cols-3 gap-x-2 items-center">
                           <div className="font-medium text-muted-foreground capitalize truncate" title={key}>{formatParamKey(key)}:</div>
                           <div className="col-span-2 font-mono text-xs break-words" title={String(value ?? '')}>
                               {formatParamValue(value)}
                           </div>
                       </div>
                   ))}
                </div>
               )}
               {!isLoadingParams && !isErrorParams && (!parameters || (Object.keys(parameters.input_filenames || {}).length === 0 && Object.keys(parameters.sarek_params || {}).length === 0)) && (
                   <p className="text-muted-foreground text-sm text-center py-4">No parameter information found for this run.</p>
               )}
              <DialogFooter className="mt-4">
                  <DialogClose asChild>
                      <Button type="button" variant="outline">Close</Button>
                  </DialogClose>
              </DialogFooter>
          </DialogContent>
      </Dialog>
    </>
  );
}

