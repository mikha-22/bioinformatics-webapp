// File: frontend_app/components/jobs/JobLogViewer.tsx
"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { Terminal, Wifi, WifiOff, Loader2, ServerCrash, History } from 'lucide-react';
import Convert from 'ansi-to-html';
import { useQuery } from "@tanstack/react-query";
import * as api from "@/lib/api"; // For getJobLogHistory

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from '@/lib/utils';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorDisplay from '@/components/common/ErrorDisplay'; // For displaying history fetch errors

interface LogLine {
    id: number;
    type: 'stdout' | 'stderr' | 'info' | 'error' | 'status' | 'control' | 'raw';
    line: string;
    timestamp: number; // Can be approximate for historical logs
}

interface JobLogViewerProps {
    jobId: string | null;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    jobDescription?: string | null;
    jobStatus?: string; // Status of the job
}

let messageIdCounter = 0;
const ansiConverter = new Convert({ newline: true, escapeXML: true });

const isTerminalStatus = (status?: string): boolean => {
    const lowerStatus = status?.toLowerCase();
    return ['finished', 'failed', 'stopped', 'canceled'].includes(lowerStatus || "");
};

export default function JobLogViewer({ jobId, isOpen, onOpenChange, jobDescription, jobStatus }: JobLogViewerProps) {
    const [logs, setLogs] = useState<LogLine[]>([]);
    const scrollAreaViewportRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const [websocketUrl, setWebsocketUrl] = useState<string | null>(null);
    const [showEOFMessage, setShowEOFMessage] = useState(false);
    const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
    const [initialHistoryLoaded, setInitialHistoryLoaded] = useState(false);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        bottomRef.current?.scrollIntoView({ behavior: behavior });
        if (behavior === 'auto') {
            setIsScrolledToBottom(true);
        }
    }, []);

    // Fetch historical logs when the dialog opens for ANY job type initially
    const {
        data: historicalLogStrings,
        isLoading: isLoadingHistory,
        isError: isErrorHistory,
        error: errorHistory,
        isSuccess: isHistorySuccess,
    } = useQuery<string[], Error>({
        queryKey: ['jobLogHistory', jobId, 'initial'], // Add 'initial' to differentiate if needed
        queryFn: () => {
            if (!jobId) throw new Error("Job ID is required for history");
            console.log(`[LogViewer ${jobId}] Fetching initial history via HTTP...`);
            return api.getJobLogHistory(jobId);
        },
        enabled: isOpen && !!jobId, // Fetch whenever the dialog is open with a valid job ID
        staleTime: 5 * 60 * 1000, // Cache for a bit, but refetch if dialog reopens after a while
        refetchOnWindowFocus: false,
        retry: 1,
    });

    // Effect to setup WebSocket URL and reset states based on job status (terminal or live)
    useEffect(() => {
        if (isOpen && jobId) {
            setLogs([]); // Clear previous logs immediately on open or job change
            messageIdCounter = 0;
            setShowEOFMessage(false);
            setIsScrolledToBottom(true);
            setInitialHistoryLoaded(false); // Reset history loaded flag

            if (isTerminalStatus(jobStatus)) {
                console.log(`[LogViewer ${jobId}] Terminal status. Historical view only.`);
                setWebsocketUrl(null); // No WebSocket for terminal jobs
            } else {
                console.log(`[LogViewer ${jobId}] Live status. Will attempt WebSocket after history.`);
                // WebSocket URL will be set after history is loaded/attempted
                setWebsocketUrl(null); // Clear initially, set later
            }
        } else { // Dialog closed or no jobId
            setWebsocketUrl(null);
            setLogs([]);
            setInitialHistoryLoaded(false);
        }
    }, [jobId, isOpen, jobStatus]);


    // Effect to process fetched historical logs
    useEffect(() => {
        if (isOpen && jobId && (isHistorySuccess || isErrorHistory) && !initialHistoryLoaded) {
            console.log(`[LogViewer ${jobId}] Processing historical logs. Success: ${isHistorySuccess}, Error: ${isErrorHistory}`);
            if (isHistorySuccess && historicalLogStrings) {
                const formattedHistoricalLogs: LogLine[] = historicalLogStrings.map((jsonString, index) => {
                    try {
                        const parsedItem = JSON.parse(jsonString);
                        return {
                            id: messageIdCounter++,
                            type: parsedItem.type || 'raw',
                            line: parsedItem.line || jsonString,
                            timestamp: Date.now() - (historicalLogStrings.length - index) * 1000
                        };
                    } catch (e) {
                        return { id: messageIdCounter++, type: 'raw', line: jsonString, timestamp: Date.now() - (historicalLogStrings.length - index) * 1000 };
                    }
                });
                setLogs(formattedHistoricalLogs);
                if (isTerminalStatus(jobStatus)) {
                    setShowEOFMessage(true); // For purely historical, show EOF after loading
                }
            }
            setInitialHistoryLoaded(true); // Mark history as processed (even if error)
            setTimeout(() => scrollToBottom('auto'), 50); // Scroll after setting logs
        }
    }, [isOpen, jobId, historicalLogStrings, isLoadingHistory, isHistorySuccess, isErrorHistory, initialHistoryLoaded, jobStatus, scrollToBottom]);

    // Effect to setup WebSocket URL for LIVE jobs AFTER initial history load attempt
    useEffect(() => {
        if (isOpen && jobId && initialHistoryLoaded && !isTerminalStatus(jobStatus) && !websocketUrl) {
            console.log(`[LogViewer ${jobId}] Initial history loaded, setting up WebSocket for live logs.`);
            const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
            const wsProtocol = apiUrl.startsWith('https://') ? 'wss://' : 'ws://';
            const domainAndPath = apiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
            const url = `${wsProtocol}${domainAndPath}/api/ws/logs/${jobId}`;
            setWebsocketUrl(url);
        }
    }, [isOpen, jobId, initialHistoryLoaded, jobStatus, websocketUrl]);


    // WebSocket Hook
    const { lastMessage, readyState } = useWebSocket(websocketUrl, {
        share: false,
        shouldReconnect: (closeEvent) => true,
        reconnectInterval: 3000,
        reconnectAttempts: 10,
        retryOnError: true,
        onOpen: () => console.log(`[LogViewer WS ${jobId}] WebSocket opened.`),
        onClose: (event) => console.log(`[LogViewer WS ${jobId}] WebSocket closed. Code: ${event.code}`),
        onError: (event) => console.error(`[LogViewer WS ${jobId}] WebSocket error:`, event),
        filter: (message: MessageEvent<any>): boolean => typeof message.data === 'string',
    }, !!websocketUrl); // Only connect if websocketUrl is not null


    // Handle incoming LIVE messages from WebSocket
    useEffect(() => {
        if (websocketUrl && lastMessage !== null) { // Only process if WebSocket is active
            let logEntry: LogLine | null = null;
            try {
                const jsonData = JSON.parse(lastMessage.data);
                const logData = jsonData as { type?: string; line?: any };
                const logType = logData.type || 'raw';
                const logLineContent = typeof logData.line === 'string' ? logData.line : JSON.stringify(logData.line ?? '');

                if (logType === 'control' && logLineContent === 'EOF') {
                    console.log(`[LogViewer WS ${jobId}] Received EOF via WebSocket.`);
                    setShowEOFMessage(true);
                    setWebsocketUrl(null); // Optionally close WS on EOF
                    return;
                }
                logEntry = { id: messageIdCounter++, type: logType as LogLine['type'], line: logLineContent, timestamp: Date.now() };
            } catch (e) {
                logEntry = { id: messageIdCounter++, type: 'raw', line: lastMessage.data, timestamp: Date.now() };
            }
            if (logEntry) {
                setLogs((prevLogs) => [...prevLogs, logEntry!]);
            }
        }
    }, [lastMessage, websocketUrl, jobId]);

    // Auto-Scroll Effect
    useEffect(() => {
        if (isScrolledToBottom) {
            scrollToBottom('auto');
        }
    }, [logs, isScrolledToBottom, scrollToBottom]);

    const handleScroll = useCallback(() => { /* ... as before ... */ }, [isScrolledToBottom]);
    const getLogLineColor = (type: LogLine['type']): string => { /* ... as before ... */ };
    const connectionStatusText = { /* ... as before ... */ }[readyState];
    const getStatusIndicator = () => { /* ... as before ... */ };

    const isActuallyLive = !isTerminalStatus(jobStatus) && initialHistoryLoaded;

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-5xl md:max-w-6xl lg:max-w-7xl h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="p-4 border-b flex-shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        {(isTerminalStatus(jobStatus) || !websocketUrl) && initialHistoryLoaded ? <History className="h-5 w-5 text-blue-500" /> : <Terminal className="h-5 w-5" />}
                        {(isTerminalStatus(jobStatus) || !websocketUrl) && initialHistoryLoaded ? "Log History: " : "Live Logs: "}
                        <span className="font-mono text-sm ml-1 truncate">{jobDescription || jobId}</span>
                    </DialogTitle>
                    <DialogDescription className="flex items-center justify-between text-xs pt-1">
                         <span>
                            {isLoadingHistory && "Loading history..."}
                            {isErrorHistory && "Error loading history."}
                            {isHistorySuccess && isTerminalStatus(jobStatus) && "Complete log history."}
                            {isHistorySuccess && !isTerminalStatus(jobStatus) && "Historical logs loaded, listening for live updates..."}
                         </span>
                         {isActuallyLive && ( // Only show WS status if it's supposed to be live
                             <Badge variant="outline" className="flex items-center gap-1.5 py-0.5 px-2 text-xs">
                                 {getStatusIndicator()}
                                 {connectionStatusText}
                             </Badge>
                         )}
                    </DialogDescription>
                </DialogHeader>

                <ScrollArea className="flex-grow bg-gray-950 dark:bg-black text-white font-mono text-[0.8rem] leading-relaxed overflow-y-auto" onScroll={handleScroll}>
                    <ScrollAreaPrimitive.Viewport ref={scrollAreaViewportRef} className="h-full w-full rounded-[inherit] p-4">
                        {isLoadingHistory && (
                            <div className="flex justify-center items-center h-full">
                                <LoadingSpinner label="Loading log history..." size="lg" />
                            </div>
                        )}
                        {isErrorHistory && !isLoadingHistory && (
                             <ErrorDisplay title="Failed to Load Log History" error={errorHistory} className="m-4" />
                        )}

                        {/* Render Logs (historical and/or live) */}
                        {logs.map((log) => {
                            const htmlLogLine = ansiConverter.toHtml(log.line);
                            return (
                               <div
                                    key={log.id}
                                    className={cn(getLogLineColor(log.type), "whitespace-pre-wrap break-words")}
                                    dangerouslySetInnerHTML={{ __html: htmlLogLine }}
                                />
                            );
                        })}

                        {/* EOF Message */}
                        {showEOFMessage && (
                            <p className="text-yellow-400 italic pt-2">
                                --- {isTerminalStatus(jobStatus) || !websocketUrl ? "End of historical log" : "End of log stream (Job finished or stopped)"} ---
                            </p>
                        )}
                        {/* Sentinel Element for scrolling */}
                        <div ref={bottomRef} style={{ height: '1px' }} />
                    </ScrollAreaPrimitive.Viewport>
                    <ScrollBar orientation="vertical" />
                    <ScrollBar orientation="horizontal" />
                </ScrollArea>

                 <DialogFooter className="p-3 border-t flex-shrink-0">
                    {isActuallyLive && ( // Only show pause/resume for live view
                         <Button type="button" variant="secondary" onClick={() => setIsScrolledToBottom(!isScrolledToBottom)} size="sm">
                           {isScrolledToBottom ? "Pause Auto-Scroll" : "Resume Auto-Scroll"}
                        </Button>
                    )}
                    <DialogClose asChild>
                        <Button type="button" variant="outline" size="sm">Close</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
