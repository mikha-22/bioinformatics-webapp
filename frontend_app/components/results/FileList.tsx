// File: frontend_app/components/results/FileList.tsx
"use client";

import React from "react";
import Link from 'next/link'; // Import Link
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Folder, FileText, FileCode2, BarChart3, AlignLeft, Download, ExternalLink, Loader2 } from "lucide-react"; // Added Loader2

import { ResultItem } from "@/lib/types";
import * as api from "@/lib/api"; // Import API functions
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils"; // Assuming a formatBytes utility exists

interface FileListProps {
  files: ResultItem[];
  runName: string; // Receive runName to construct download links
}

// Sarek-specific file recognition
const getFileIcon = (file: ResultItem) => {
    if (file.is_dir) return <Folder className="h-4 w-4 text-yellow-600 flex-shrink-0" />;

    const ext = file.extension?.toLowerCase();
    const name = file.name.toLowerCase();

    // Prioritize specific filenames/patterns
    if (name === 'multiqc_report.html') return <BarChart3 className="h-4 w-4 text-teal-500 flex-shrink-0" />;
    if (name.includes('fastqc.html')) return <BarChart3 className="h-4 w-4 text-orange-500 flex-shrink-0" />;
    if (name === 'job_metadata.json') return <FileCode2 className="h-4 w-4 text-indigo-500 flex-shrink-0" />;

    // General extensions
    switch (ext) {
        case ".bam":
        case ".cram":
            return <AlignLeft className="h-4 w-4 text-blue-600 flex-shrink-0" />;
        case ".bai":
        case ".crai":
            return <AlignLeft className="h-4 w-4 text-blue-400 flex-shrink-0" />; // Lighter for index
        case ".vcf":
        case ".bcf":
        case ".gz": // Often VCFs are gzipped
        case ".bgz":
        case ".csi":
        case ".tbi": // Index for VCF
            return <FileCode2 className="h-4 w-4 text-purple-600 flex-shrink-0" />;
        case ".html":
            return <BarChart3 className="h-4 w-4 text-green-600 flex-shrink-0" />;
        case ".log":
        case ".txt":
        case ".out":
        case ".err":
        case ".report":
        case ".metrics":
            return <FileText className="h-4 w-4 text-gray-600 flex-shrink-0" />;
        case ".csv":
        case ".tsv":
            return <FileText className="h-4 w-4 text-lime-600 flex-shrink-0" />; // Different color for tables
        case ".json":
        case ".yaml":
        case ".yml":
            return <FileCode2 className="h-4 w-4 text-pink-600 flex-shrink-0" />;
        case ".bed":
            return <FileCode2 className="h-4 w-4 text-rose-600 flex-shrink-0" />;
        case ".fa":
        case ".fasta":
            return <FileCode2 className="h-4 w-4 text-sky-600 flex-shrink-0" />;
        default:
            return <FileText className="h-4 w-4 text-gray-500 flex-shrink-0" />;
    }
};

const formatTimestamp = (timestamp: number | null | undefined): string => {
    if (!timestamp) return "N/A";
    try {
        return new Date(timestamp * 1000).toLocaleString();
    } catch (e) {
        return "Invalid Date";
    }
};

// Component for individual file actions (download/view)
interface FileActionsProps {
  file: ResultItem;
  runName: string;
}

function FileActions({ file, runName }: FileActionsProps) {
    const downloadFileMutation = useMutation({
        mutationFn: () => api.downloadResultFile(runName, file.relative_path || file.name), // Use relative path if available
        onSuccess: (blob) => {
            try {
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = file.name; // Use the actual filename
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                toast.success(`Started download for ${file.name}`);
            } catch (e) {
                 console.error("Error creating file download link:", e);
                 toast.error("Failed to initiate file download.");
            }
        },
        onError: (error: Error) => {
             console.error(`Error downloading file ${file.name}:`, error);
            toast.error(`Download failed for ${file.name}: ${error.message}`);
        }
    });

    const handleDownload = (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent triggering parent elements if nested
        downloadFileMutation.mutate();
    };

    return (
        <div className="flex items-center gap-1">
            {/* Download Button */}
            {!file.is_dir && (
                 <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    title={`Download ${file.name}`}
                    onClick={handleDownload}
                    disabled={downloadFileMutation.isPending}
                >
                    {downloadFileMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin"/> : <Download className="h-3 w-3" />}
                    <span className="sr-only">Download</span>
                 </Button>
            )}
             {/* View in FileBrowser Button */}
            {file.filebrowser_link && (
                <Button variant="ghost" size="icon" className="h-6 w-6" title="Open in File Browser" asChild>
                    <Link href={file.filebrowser_link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                        <ExternalLink className="h-3 w-3" />
                         <span className="sr-only">Open in File Browser</span>
                    </Link>
                </Button>
            )}
        </div>
    );
}


export default function FileList({ files, runName }: FileListProps) {

  // Sarek-specific categorization logic
  const categorizedFiles = React.useMemo(() => {
      const categories = {
          qcReports: [] as ResultItem[],
          variants: [] as ResultItem[],
          alignment: [] as ResultItem[],
          annotation: [] as ResultItem[],
          logsInfo: [] as ResultItem[],
          otherFiles: [] as ResultItem[],
          directories: [] as ResultItem[],
      };

      files.forEach(file => {
          if (file.is_dir) {
              // Group common Sarek output directories
              if (['VariantCalling', 'Annotation', 'Preprocessing', 'QC', 'pipeline_info', 'Reports'].includes(file.name)) {
                   categories.directories.push(file);
              } else {
                   categories.otherFiles.push(file); // Treat unknown dirs as 'other' for now
              }
              return;
          }

          const name = file.name.toLowerCase();
          const ext = file.extension?.toLowerCase();
          const path = file.relative_path?.toLowerCase() || name; // Use path if available

          // Prioritize specific files
          if (name === 'multiqc_report.html' || path.includes('multiqc/')) {
              categories.qcReports.push(file);
          } else if (name.endsWith('fastqc.html') || path.includes('fastqc/')) {
              categories.qcReports.push(file);
          } else if (ext === '.vcf' || name.endsWith('.vcf.gz') || ext === '.bcf' || ext === '.tbi' || ext === '.csi' || path.includes('variantcalling/') || path.includes('variants/')) {
              categories.variants.push(file);
          } else if (ext === '.bam' || ext === '.cram' || ext === '.bai' || ext === '.crai' || path.includes('preprocessing/')) {
              categories.alignment.push(file);
          } else if (path.includes('annotation/')) {
               categories.annotation.push(file);
          } else if (ext === '.log' || name.endsWith('.out') || name.endsWith('.err') || path.includes('pipeline_info/')) {
              categories.logsInfo.push(file);
          }
          // Removed QC file extensions from logsInfo check to avoid duplication with qcReports
          else if (!path.includes('multiqc/') && !path.includes('fastqc/') && (ext === '.html' || ext === '.qc' || ext === '.metrics' || ext === '.report' || ext === '.json')) {
              categories.qcReports.push(file);
          }
           else {
              // Only add if not already categorized
               const alreadyCategorized = Object.values(categories).flat().some(f => f.name === file.name && f.relative_path === file.relative_path);
               if (!alreadyCategorized) {
                    categories.otherFiles.push(file);
               }
          }
      });

      // Sort directories alphabetically
      categories.directories.sort((a, b) => a.name.localeCompare(b.name));

      return categories;
  }, [files]);


  const renderFileItem = (file: ResultItem) => (
     <div key={file.relative_path || file.name} className="flex items-center justify-between p-2 hover:bg-accent/50 rounded-md text-sm group">
        <div className="flex items-center gap-2 truncate mr-2 flex-grow min-w-0">
            {getFileIcon(file)}
            <span className="truncate" title={file.name}>{file.name}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 text-xs text-muted-foreground ml-2">
             {!file.is_dir && <span>{formatBytes(file.size ?? 0)}</span>}
             <span className="hidden sm:inline">{formatTimestamp(file.modified_time)}</span>
             {/* Add Download/View actions here */}
             <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                 <FileActions file={file} runName={runName} />
             </div>
        </div>
    </div>
  );

  const renderCategory = (title: string, items: ResultItem[]) => {
      if (items.length === 0) return null;
      return (
          <div>
              <h4 className="font-semibold mb-1 text-muted-foreground px-2">{title}</h4>
              <div className="space-y-1 border rounded-md p-1 bg-muted/20">
                  {items.map(renderFileItem)}
              </div>
          </div>
      );
  };

  return (
    <div className="space-y-4">
        {renderCategory("QC Reports", categorizedFiles.qcReports)}
        {renderCategory("Variant Calling", categorizedFiles.variants)}
        {renderCategory("Alignment", categorizedFiles.alignment)}
        {renderCategory("Annotation", categorizedFiles.annotation)}
        {renderCategory("Directories", categorizedFiles.directories)}
        {renderCategory("Logs & Info", categorizedFiles.logsInfo)}
        {renderCategory("Other Files", categorizedFiles.otherFiles)}
    </div>
  );
}
