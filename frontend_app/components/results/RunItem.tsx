// File: frontend_app/components/results/RunItem.tsx
"use client";

import React, { useState, useMemo, useEffect } from "react";
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

const formatParamValue = (value: string | number | boolean | null | undefined | any[] | Record<string, any>): string => { /* ... (keep existing) ... */ };
const formatParamKey = (key: string): string => { /* ... (keep existing) ... */ };

export default function RunItem({ run, isHighlighted, onExpandToggle, isExpanded }: RunItemProps) {
  const [isParamsOpen, setIsParamsOpen] = useState(false);
  const { openFileBrowser } = useFileBrowser();

  // ... (useEffect for MOUNT_DEBUG - keep if useful) ...

  const {
    data: runFiles,
    isLoading: isLoadingFiles,
    // ... (rest of runFiles query)
  } = useQuery<ResultItem[], Error>({ /* ... */ });

  const { data: multiqcRelativePath, isLoading: isLoadingMultiQCPath, isError: isErrorMultiQCPath, error: errorMultiQCPath } = useQuery<string | null, Error>({
    queryKey: ["multiqcPath", run.name],
    queryFn: () => api.getMultiQCReportPath(run.name),
    enabled: true,
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // ... (useEffect for MULTIQC_QUERY_STATUS - keep if useful) ...

  const multiqcReportUrl = useMemo(() => {
    // ... (keep existing logic for constructing multiqcReportUrl) ...
    if (multiqcRelativePath) {
      const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "";
      if (!apiBaseUrl) {
        console.error(`[RunItem ${run.name} MEMO_ERROR] NEXT_PUBLIC_API_BASE_URL is not set! Cannot construct MultiQC URL.`);
        return null;
      }
      const encodedRelativePath = multiqcRelativePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
      return `${apiBaseUrl}/api/results/${encodeURIComponent(run.name)}/static/${encodedRelativePath}`;
    }
    return null;
  }, [multiqcRelativePath, run.name]);


  const {
    data: parameters,
    isLoading: isLoadingParams,
    // ... (rest of parameters query, ensure queryFn is correct)
  } = useQuery<RunParameters, Error>({
    queryKey: ["resultParams", run.name],
    queryFn: () => api.getResultRunParameters(run.name),
    enabled: isParamsOpen,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const downloadRunMutation = useMutation({ /* ... */ });
  const handleDownloadRun = () => { /* ... */ };
  const handleOpenParams = () => { setIsParamsOpen(true); };
  const handleOpenFileBrowser = (e: React.MouseEvent) => { /* ... */ };
  const formatTimestamp = (timestamp: number | null | undefined): string => { /* ... */ };

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
            {/* Left side: Icon and Run Name/Timestamp */}
            <div className="flex items-center gap-3 min-w-0 py-3">
              <FolderGit2 className="h-5 w-5 text-primary flex-shrink-0" />
              <div className="text-left min-w-0">
                <span className="font-semibold text-foreground block truncate" title={run.name}>{run.name}</span>
                <p className="text-xs text-muted-foreground block truncate">
                  Modified: {formatTimestamp(run.modified_time)}
                </p>
              </div>
            </div>

            {/* Right side: Action Buttons Container */}
            <div className="flex items-center gap-1 py-3" onClick={e => e.stopPropagation()}>

              {/* --- START: MODIFIED MultiQC Button --- */}
              {isLoadingMultiQCPath ? (
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
                  <Loader2 className="h-4 w-4 animate-spin" />
                </Button>
              ) : multiqcReportUrl ? ( // If URL exists, it's clickable
                <Button
                  variant="ghost"
                  size="icon"
                  title="Open MultiQC Report"
                  className="h-7 w-7 cursor-pointer hover:bg-muted/80"
                  asChild
                >
                  <Link href={multiqcReportUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                    <BarChart3 className="h-4 w-4" />
                    <span className="sr-only">Open MultiQC Report</span>
                  </Link>
                </Button>
              ) : ( // If no URL (and not loading), it's disabled/unclickable
                <Button
                  variant="ghost"
                  size="icon"
                  title="MultiQC Report not found"
                  className="h-7 w-7 opacity-50 cursor-not-allowed"
                  disabled // Explicitly disable
                >
                  <BarChart3 className="h-4 w-4" />
                  <span className="sr-only">MultiQC Report not found</span>
                </Button>
              )}
              {/* --- END: MODIFIED MultiQC Button --- */}

              {/* View Parameters Button (Now after MultiQC) */}
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

              {/* Open in FileBrowser Button */}
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

              {/* Download Run Button */}
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

              {/* Expand/Collapse Chevron Button */}
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
            "!border-b !border-b-border"
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

      {/* Parameters Dialog (unchanged) */}
      <Dialog open={isParamsOpen} onOpenChange={setIsParamsOpen}>
          {/* ... existing dialog content ... */}
      </Dialog>
    </>
  );
}
