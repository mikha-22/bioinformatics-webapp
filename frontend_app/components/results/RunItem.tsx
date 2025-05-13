// File: frontend_app/components/results/RunItem.tsx
"use client";

import React, { useState, useMemo, useEffect } from "react"; // Added useEffect
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

const formatParamValue = (value: string | number | boolean | null | undefined | any[] | Record<string, any>): string => { /* ... */ };
const formatParamKey = (key: string): string => { /* ... */ };

export default function RunItem({ run, isHighlighted, onExpandToggle, isExpanded }: RunItemProps) {
  const [isParamsOpen, setIsParamsOpen] = useState(false);
  const { openFileBrowser } = useFileBrowser();

  // <<< ADDED useEffect for initial mount log >>>
  useEffect(() => {
    console.log(`[RunItem ${run.name} MOUNT_DEBUG] Component mounted/updated. isExpanded: ${isExpanded}, run.name: ${run.name}`);
  }, [run.name, isExpanded]);

  const {
    data: runFiles,
    isLoading: isLoadingFiles,
    isError: isErrorFiles,
    error: errorFiles,
  } = useQuery<ResultItem[], Error>({
    queryKey: ["resultRunFiles", run.name],
    queryFn: () => api.getResultRunFiles(run.name),
    enabled: isExpanded,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: multiqcRelativePath, isLoading: isLoadingMultiQCPath, isError: isErrorMultiQCPath, error: errorMultiQCPath } = useQuery<string | null, Error>({
    queryKey: ["multiqcPath", run.name],
    queryFn: () => {
      console.log(`[RunItem ${run.name} QUERYFN_DEBUG] Calling api.getMultiQCReportPath for run: ${run.name}`);
      return api.getMultiQCReportPath(run.name);
    },
    enabled: true, // Should run on mount
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // <<< ADDED useEffect to log query results >>>
  useEffect(() => {
    if (isLoadingMultiQCPath) {
      console.log(`[RunItem ${run.name} MULTIQC_QUERY_STATUS] Loading MultiQC path...`);
    } else if (isErrorMultiQCPath) {
      console.error(`[RunItem ${run.name} MULTIQC_QUERY_STATUS] Error fetching MultiQC path:`, errorMultiQCPath);
    } else {
      console.log(`[RunItem ${run.name} MULTIQC_QUERY_STATUS] Fetched MultiQC path:`, multiqcRelativePath);
    }
  }, [run.name, multiqcRelativePath, isLoadingMultiQCPath, isErrorMultiQCPath, errorMultiQCPath]);


  const multiqcReportUrl = useMemo(() => {
    // console.log(`[RunItem ${run.name} MEMO_DEBUG] multiqcRelativePath from query:`, multiqcRelativePath);
    if (multiqcRelativePath) {
      const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "";
      // console.log(`[RunItem ${run.name} MEMO_DEBUG] NEXT_PUBLIC_API_BASE_URL:`, apiBaseUrl);
      if (!apiBaseUrl) {
        console.error(`[RunItem ${run.name} MEMO_ERROR] NEXT_PUBLIC_API_BASE_URL is not set! Cannot construct MultiQC URL.`);
        return null;
      }
      const encodedRelativePath = multiqcRelativePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
      const fullUrl = `${apiBaseUrl}/api/results/${encodeURIComponent(run.name)}/static/${encodedRelativePath}`;
      // console.log(`[RunItem ${run.name} MEMO_DEBUG] Constructed MultiQC URL:`, fullUrl);
      return fullUrl;
    }
    // console.log(`[RunItem ${run.name} MEMO_DEBUG] multiqcRelativePath is null/empty, so multiqcReportUrl will be null.`);
    return null;
  }, [multiqcRelativePath, run.name]);

  const {
    data: parameters,
    isLoading: isLoadingParams,
    // ... (rest of parameters query)
  } = useQuery<RunParameters, Error>({ /* ... */ });
  const downloadRunMutation = useMutation({ /* ... */ });
  const handleDownloadRun = () => { /* ... */ };
  const handleOpenParams = () => { /* ... */ };
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

              {/* --- MultiQC Button with Debugging --- */}
              {/* {console.log(`[RunItem ${run.name} RENDER_DEBUG] isLoadingMultiQCPath: ${isLoadingMultiQCPath}, multiqcReportUrl: ${multiqcReportUrl}`)} */}
              {isLoadingMultiQCPath ? (
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
                  <Loader2 className="h-4 w-4 animate-spin" />
                </Button>
              ) : multiqcReportUrl ? (
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
              ) : (
                 null // Not rendering a disabled button for cleaner UI if not found
              )}
              {/* --- End MultiQC Button --- */}


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
          <AccordionContent className={cn( /* ... */ )}>
             {/* ... */}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <Dialog open={isParamsOpen} onOpenChange={setIsParamsOpen}>
          {/* ... */}
      </Dialog>
    </>
  );
}
