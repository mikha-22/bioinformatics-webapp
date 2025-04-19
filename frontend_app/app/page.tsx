// File: frontend_app/app/page.tsx
"use client";

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { FolderKanban, PlayCircle, BarChart3, HardDriveDownload, Hourglass, Activity, CheckCircle2, XCircle, LayoutDashboard, ListTree, FolderGit2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import * as api from '@/lib/api'; // Import API functions
import { Job, ResultRun } from '@/lib/types'; // Import types
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorDisplay from '@/components/common/ErrorDisplay';
import { formatDistanceToNow } from 'date-fns'; // For relative time formatting
import { Skeleton } from '@/components/ui/skeleton'; // For loading state
import { useFileBrowser } from '@/components/layout/FileBrowserContext';

// Helper function for relative time (copied from JobTable for consistency)
// TODO: Move to lib/utils.ts
function formatTimestampRelative(timestamp: number | null | undefined): string {
  if (!timestamp) return "N/A";
  try {
    // Add a check for potentially invalid timestamps (e.g., 0 or negative)
    if (timestamp <= 0) return "N/A";
    return formatDistanceToNow(new Date(timestamp * 1000), { addSuffix: true });
  } catch (e) {
    console.error("Error formatting timestamp:", timestamp, e);
    return "Invalid Date";
  }
}
// Helper for status badge variants (copied from JobTable for consistency)
// TODO: Move to lib/utils.ts
function getStatusVariant(status: string): "default" | "destructive" | "secondary" | "outline" {
     switch (status?.toLowerCase()) {
        case 'finished': return 'default'; // Greenish success -> Use primary for now
        case 'failed': return 'destructive'; // Red
        case 'running':
        case 'started': return 'default'; // Blueish -> Primary
        case 'queued':
        case 'staged': return 'secondary'; // Gray
        case 'stopped':
        case 'canceled': return 'outline'; // Muted/outline
        default: return 'secondary';
    }
}


export default function HomePage() {
  const MAX_RECENT_ITEMS = 5;
  const { openFileBrowser } = useFileBrowser();

  // Fetch Jobs List
  const { data: jobs, isLoading: isLoadingJobs, isError: isErrorJobs, error: errorJobs } = useQuery<Job[], Error>({
    queryKey: ['jobsList'],
    queryFn: api.getJobsList,
    staleTime: 60 * 1000, // Cache for 1 minute
    refetchOnWindowFocus: false,
  });

  // Fetch Results List
  const { data: results, isLoading: isLoadingResults, isError: isErrorResults, error: errorResults } = useQuery<ResultRun[], Error>({
    queryKey: ['resultsList'],
    queryFn: api.getResultsList,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    refetchOnWindowFocus: false,
  });

  // Get recent items (slice only after data is available)
  const recentJobs = jobs?.slice(0, MAX_RECENT_ITEMS) ?? [];
  const recentResults = results?.slice(0, MAX_RECENT_ITEMS) ?? [];

  // --- Job Stats Calculation ---
  const jobStats = React.useMemo(() => {
    if (!jobs || isLoadingJobs) return { running: 0, queued: 0, completed: 0, failed: 0, staged: 0, total: 0 }; // Include staged and total
    return jobs.reduce((acc, job) => {
        const status = job.status?.toLowerCase();
        if (status === 'running' || status === 'started') acc.running++;
        else if (status === 'queued') acc.queued++;
        else if (status === 'finished') acc.completed++;
        else if (status === 'failed' || status === 'stopped') acc.failed++; // Combine failed and stopped
        else if (status === 'staged') acc.staged++; // Count staged jobs
        acc.total++; // Increment total for every job
        return acc;
    }, { running: 0, queued: 0, completed: 0, failed: 0, staged: 0, total: 0 });
  }, [jobs, isLoadingJobs]); // Depend on isLoadingJobs too


  return (
    <div className="space-y-8">
       {/* Welcome Banner */}
      <Card className="bg-gradient-to-r from-primary/10 to-secondary/10 border-primary/20">
        <CardHeader>
          <CardTitle className="text-3xl font-bold text-primary">Sarek Pipeline Dashboard</CardTitle>
          <CardDescription className="text-lg">
            Stage, run, and manage your nf-core/sarek bioinformatics analysis pipelines.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p>Use this interface to process sequencing data, monitor job progress, and browse results efficiently. Start by staging a new run or view existing jobs and results.</p>
        </CardContent>
         {/* *** MODIFIED: Changed justify-end to justify-start *** */}
         <CardFooter className="justify-start">
            <Button asChild size="lg">
              <Link href="/input"><PlayCircle className="mr-2 h-5 w-5" /> Stage New Sarek Run</Link>
            </Button>
        </CardFooter>
      </Card>

       {/* Job Stats */}
        <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
             <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Jobs</CardTitle>
                    <ListTree className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{isLoadingJobs ? <Skeleton className="h-7 w-12" /> : jobStats.total}</div>
                </CardContent>
            </Card>
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Staged</CardTitle>
                    <Hourglass className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                     <div className="text-2xl font-bold">{isLoadingJobs ? <Skeleton className="h-7 w-12" /> : jobStats.staged}</div>
                </CardContent>
            </Card>
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Queued/Running</CardTitle>
                    <Activity className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{isLoadingJobs ? <Skeleton className="h-7 w-12" /> : jobStats.queued + jobStats.running}</div>
                </CardContent>
            </Card>
             <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Completed</CardTitle>
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{isLoadingJobs ? <Skeleton className="h-7 w-12" /> : jobStats.completed}</div>
                </CardContent>
            </Card>
             <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Failed/Stopped</CardTitle>
                    <XCircle className="h-4 w-4 text-destructive" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{isLoadingJobs ? <Skeleton className="h-7 w-12" /> : jobStats.failed}</div>
                </CardContent>
            </Card>
        </div>


      {/* Dashboard Grid: Quick Actions / Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Quick Actions */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Navigate to key sections</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col space-y-2">
            <Button asChild variant="outline">
              <Link href="/input"><PlayCircle className="mr-2 h-4 w-4" /> Stage New Run</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/jobs"><LayoutDashboard className="mr-2 h-4 w-4" /> View Jobs Dashboard</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/results"><FolderGit2 className="mr-2 h-4 w-4" /> Browse Results</Link>
            </Button>
             <Button variant="outline" className="cursor-pointer" onClick={() => openFileBrowser('/filebrowser/files')}>
               <FolderKanban className="mr-2 h-4 w-4"/> Manage Data Files
             </Button>
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Recent Jobs */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Jobs</CardTitle>
              <CardDescription>Last {MAX_RECENT_ITEMS} updated jobs</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingJobs && <LoadingSpinner label="Loading jobs..." />}
              {isErrorJobs && <ErrorDisplay error={errorJobs} title="Could not load jobs" />}
              {!isLoadingJobs && !isErrorJobs && recentJobs.length === 0 && <p className="text-sm text-muted-foreground">No recent jobs found.</p>}
              {!isLoadingJobs && !isErrorJobs && recentJobs.length > 0 && (
                <ul className="space-y-3">
                  {recentJobs.map((job) => (
                    <li key={job.id} className="flex items-center justify-between text-sm border-b pb-2 last:border-0 last:pb-0">
                      <Link href="/jobs" className="hover:underline truncate mr-2 group flex-grow min-w-0">
                        <span className="font-medium block truncate group-hover:text-primary" title={job.id}>
                             {job.id.startsWith("staged_") ? "STG_" : "RQ_"}
                             {job.id.substring(job.id.indexOf('_') + 1, job.id.indexOf('_') + 9)}...
                             </span>
                        <span className="text-xs text-muted-foreground block truncate">{job.description || "No description"}</span>
                      </Link>
                       <div className="text-right flex-shrink-0 ml-2">
                            <Badge variant={getStatusVariant(job.status)} className="capitalize mb-1 text-xs px-1.5 py-0.5">{job.status}</Badge>
                            <p className="text-xs text-muted-foreground">{formatTimestampRelative(job.ended_at || job.started_at || job.enqueued_at || job.staged_at)}</p>
                       </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
             <CardFooter>
                <Button variant="link" size="sm" className="mx-auto text-muted-foreground hover:text-primary" asChild>
                    <Link href="/jobs">View All Jobs</Link>
                </Button>
             </CardFooter>
          </Card>

          {/* Recent Results */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Results</CardTitle>
               <CardDescription>Last {MAX_RECENT_ITEMS} completed runs</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingResults && <LoadingSpinner label="Loading results..." />}
              {isErrorResults && <ErrorDisplay error={errorResults} title="Could not load results" />}
              {!isLoadingResults && !isErrorResults && recentResults.length === 0 && <p className="text-sm text-muted-foreground">No recent results found.</p>}
              {!isLoadingResults && !isErrorResults && recentResults.length > 0 && (
                 <ul className="space-y-3">
                  {recentResults.map((run) => (
                    <li key={run.name} className="flex items-center justify-between text-sm border-b pb-2 last:border-0 last:pb-0">
                      <Link href={`/results?highlight=${encodeURIComponent(run.name)}`} className="hover:underline truncate mr-2 group flex-grow min-w-0">
                        <span className="font-medium block truncate group-hover:text-primary" title={run.name}>{run.name}</span>
                      </Link>
                      <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">{formatTimestampRelative(run.modified_time)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
             <CardFooter>
                <Button variant="link" size="sm" className="mx-auto text-muted-foreground hover:text-primary" asChild>
                    <Link href="/results">View All Results</Link>
                </Button>
             </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
