// File: frontend_app/components/jobs/JobLogViewer.tsx
"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { Terminal, Wifi, WifiOff, Loader2, ServerCrash, History } from 'lucide-react'; // Keep existing icons
import Convert from 'ansi-to-html';
import { useQuery } from "@tanstack/react-query";
import * as api from "@/lib/api";

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogClose
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from '@/lib/utils';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorDisplay from '@/components/common/ErrorDisplay';

interface LogLine {
    id: number;
    type: 'stdout' | 'stderr' | 'info' | 'error' | 'status' | 'control' | 'raw';
    line: string;
    timestamp: number;
}

interface JobLogViewerProps {
    jobId: string | null;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    jobRunName?: string | null;
    jobDescription?: string | null;
    jobStatus?: string;
}

let messageIdCounter = 0;
const ansiConverter = new Convert({ 
    newline: true, 
    escapeXML: true,
});

const isTerminalStatus = (status?: string): boolean => {
    const lowerStatus = status?.toLowerCase();
    return ['finished', 'failed', 'stopped', 'canceled'].includes(lowerStatus || "");
};

const nfProcessRegex = /^\[([a-f0-9]{2}\/[a-f0-9]{6})\]\s+(Submitted process|process|COMPLETED|FAILED|CACHED)\s+>\s+([^ \n(]+)(?:\s+\(([^)]*)\))?(?:\s+\[\s*([^\]%]+%)\s*\])?/i;
const wrapperLogRegex = /^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\[PID:\d+\])/;


export default function JobLogViewer({ 
    jobId, 
    isOpen, 
    onOpenChange, 
    jobRunName,
    jobDescription, 
    jobStatus 
}: JobLogViewerProps) {
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

    const {
        data: historicalLogStrings,
        isLoading: isLoadingHistory,
        isError: isErrorHistory,
        error: errorHistory,
        isSuccess: isHistorySuccess,
    } = useQuery<string[], Error>({
        queryKey: ['jobLogHistory', jobId, 'initial'],
        queryFn: () => {
            if (!jobId) throw new Error("Job ID is required for history");
            return api.getJobLogHistory(jobId);
        },
        enabled: isOpen && !!jobId,
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
    });

    useEffect(() => {
        if (isOpen && jobId) {
            setLogs([]);
            messageIdCounter = 0;
            setShowEOFMessage(false);
            setIsScrolledToBottom(true);
            setInitialHistoryLoaded(false);
            if (isTerminalStatus(jobStatus)) {
                setWebsocketUrl(null);
            } else {
                setWebsocketUrl(null); 
            }
        } else {
            setWebsocketUrl(null);
            setLogs([]);
            setInitialHistoryLoaded(false);
        }
    }, [jobId, isOpen, jobStatus]);

    useEffect(() => {
        if (isOpen && jobId && (isHistorySuccess || isErrorHistory) && !initialHistoryLoaded) {
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
                    setShowEOFMessage(true);
                }
            }
            setInitialHistoryLoaded(true);
            setTimeout(() => scrollToBottom('auto'), 50);
        }
    }, [isOpen, jobId, historicalLogStrings, isLoadingHistory, isHistorySuccess, isErrorHistory, initialHistoryLoaded, jobStatus, scrollToBottom]);

    useEffect(() => {
        if (isOpen && jobId && initialHistoryLoaded && !isTerminalStatus(jobStatus) && !websocketUrl) {
            const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
            const wsProtocol = apiUrl.startsWith('https://') ? 'wss://' : 'ws://';
            const domainAndPath = apiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
            const url = `${wsProtocol}${domainAndPath}/api/ws/logs/${jobId}`;
            setWebsocketUrl(url);
        }
    }, [isOpen, jobId, initialHistoryLoaded, jobStatus, websocketUrl]);

    const { lastMessage, readyState } = useWebSocket(websocketUrl, {
        share: false,
        shouldReconnect: (closeEvent) => true,
        reconnectInterval: 3000,
        reconnectAttempts: 10,
        retryOnError: true,
        onOpen: () => console.log(`[LogViewer WS ${jobId}] WebSocket opened.`),
        onClose: (event) => console.log(`[LogViewer WS ${jobId}] WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`),
        // --- MODIFIED onError ---
        onError: (event) => {
            if (event instanceof Event && !('message' in event) && !('code' in event) && Object.keys(event).length === 0) {
                // This checks if it's a generic Event object that is also empty (like the {} reported)
                console.info(`[LogViewer WS ${jobId}] WebSocket connection event (likely a standard closure or abrupt termination after job end, type: ${event.type}). Event object:`, event);
            } else if (event instanceof Event && !('message' in event)) {
                 console.warn(`[LogViewer WS ${jobId}] WebSocket event (type: ${event.type}) with no specific error message. Event:`, event);
            }
            else {
                console.error(`[LogViewer WS ${jobId}] WebSocket error:`, event);
            }
        },
        // --- END MODIFIED onError ---
        filter: (message: MessageEvent<any>): boolean => typeof message.data === 'string',
    }, !!websocketUrl);

    useEffect(() => {
        if (websocketUrl && lastMessage !== null) {
            let logEntry: LogLine | null = null;
            try {
                const jsonData = JSON.parse(lastMessage.data);
                const logData = jsonData as { type?: string; line?: any };
                const logType = logData.type || 'raw';
                const logLineContent = typeof logData.line === 'string' ? logData.line : JSON.stringify(logData.line ?? '');

                if (logType === 'control' && logLineContent === 'EOF') {
                    setShowEOFMessage(true);
                    setWebsocketUrl(null); // This will trigger the WebSocket to close
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

    useEffect(() => {
        if (isScrolledToBottom) {
            scrollToBottom('auto');
        }
    }, [logs, isScrolledToBottom, scrollToBottom]);

    const handleScroll = useCallback(() => {
        const viewport = scrollAreaViewportRef.current;
        if (viewport) {
            const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 10;
            if (atBottom !== isScrolledToBottom) {
                setIsScrolledToBottom(atBottom);
            }
        }
    }, [isScrolledToBottom]);
    
    const getEnhancedLogDetails = (log: LogLine): { content: React.ReactNode, lineClasses: string } => {
        let baseClasses = "whitespace-pre-wrap break-words";
        let lineContent = log.line;
        let isStructured = false;
        let structuredElements: React.ReactNode = null;

        switch (log.type) {
            case 'stderr': baseClasses = cn(baseClasses, 'text-red-400 dark:text-red-500'); break;
            case 'error': baseClasses = cn(baseClasses, 'text-red-500 dark:text-red-600 font-semibold'); break;
            case 'info': baseClasses = cn(baseClasses, 'text-blue-400 dark:text-blue-500'); break;
            case 'status': baseClasses = cn(baseClasses, 'text-yellow-400 dark:text-yellow-500 italic'); break;
            case 'control': baseClasses = cn(baseClasses, 'text-purple-400 dark:text-purple-500'); break;
            case 'stdout':
            case 'raw':
            default: baseClasses = cn(baseClasses, 'text-gray-300 dark:text-gray-400'); break;
        }

        if (wrapperLogRegex.test(log.line)) {
            baseClasses = cn(baseClasses, 'text-sky-400 dark:text-sky-500');
        }

        const nfMatch = log.line.match(nfProcessRegex);
        if (nfMatch) {
            isStructured = true;
            const [, nfHash, nfActionStatus, nfProcessNameFull, nfInput, nfProgress] = nfMatch;
            const nfProcessNameShort = nfProcessNameFull.split(':').pop() || nfProcessNameFull;
            
            let actionColor = "text-purple-400 dark:text-purple-500";
            if (nfActionStatus.toUpperCase() === "COMPLETED") actionColor = "text-green-400 dark:text-green-500";
            else if (nfActionStatus.toUpperCase() === "FAILED") actionColor = "text-red-400 dark:text-red-500";
            else if (nfActionStatus.toUpperCase() === "CACHED") actionColor = "text-teal-400 dark:text-teal-500";

            structuredElements = (
                <>
                    <span className="text-gray-500 dark:text-gray-600 mr-1">[{nfHash}]</span>
                    <span className={cn("font-semibold mr-1", actionColor)}>{nfProcessNameShort}</span>
                    {nfInput && <span className="text-blue-400 dark:text-blue-500 mr-1">({nfInput.trim()})</span>}
                    {nfProgress && <span className="text-yellow-400 dark:text-yellow-500 mr-1">[{nfProgress}]</span>}
                    {nfActionStatus.toUpperCase() !== "PROCESS" && nfActionStatus.toUpperCase() !== "SUBMITTED PROCESS" && 
                     !nfProgress && <span className={cn("font-medium",actionColor)}>{nfActionStatus.toUpperCase()}</span>}
                </>
            );
        }

        if (!isStructured) {
            if (log.line.includes("Pipeline completed successfully")) {
                baseClasses = cn(baseClasses, "text-green-400 dark:text-green-300 font-bold bg-green-900/40 dark:bg-green-500/20 p-0.5 rounded-sm");
            } else if (log.line.includes("Pipeline failed")) {
                baseClasses = cn(baseClasses, "text-red-400 dark:text-red-300 font-bold bg-red-900/40 dark:bg-red-500/20 p-0.5 rounded-sm");
            } else if (log.type !== 'stderr' && log.line.toUpperCase().includes("ERROR:")) {
                baseClasses = cn(baseClasses, "text-red-400 dark:text-red-300 font-semibold");
            } else if (log.type !== 'stderr' && (log.line.toUpperCase().includes("WARN:") || log.line.toUpperCase().includes("WARNING:"))) {
                baseClasses = cn(baseClasses, "text-yellow-400 dark:text-yellow-300");
            }
        }
        
        const content = isStructured ? structuredElements : <span dangerouslySetInnerHTML={{ __html: ansiConverter.toHtml(lineContent) }} />;
        return { content, lineClasses: baseClasses };
    };
    
    const connectionStatusText = {
        [ReadyState.CONNECTING]: 'Connecting...',
        [ReadyState.OPEN]: 'Connected (Live)',
        [ReadyState.CLOSING]: 'Closing...',
        [ReadyState.CLOSED]: 'Disconnected',
        [ReadyState.UNINSTANTIATED]: 'Idle',
    }[readyState];

    const getStatusIndicator = () => {
        switch (readyState) {
            case ReadyState.CONNECTING: return <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />;
            case ReadyState.OPEN: return <Wifi className="h-3 w-3 text-green-500" />;
            case ReadyState.CLOSED: return <WifiOff className="h-3 w-3 text-red-500" />;
            case ReadyState.CLOSING: return <Loader2 className="h-3 w-3 animate-spin text-orange-500" />;
            default: return <ServerCrash className="h-3 w-3 text-gray-500" />;
        }
    };

    const isActuallyLive = !isTerminalStatus(jobStatus) && initialHistoryLoaded;
    const logTypePrefix = (isTerminalStatus(jobStatus) || !websocketUrl) && initialHistoryLoaded ? "Log History: " : "Live Logs: ";
    const displayRunNameInTitle = jobRunName || (jobId ? `Job ${jobId.split('_').pop()?.slice(0,8)}...` : "Log Viewer");
    const titleText = `${logTypePrefix}${displayRunNameInTitle}`;

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-5xl md:max-w-6xl lg:max-w-7xl h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="p-4 border-b flex-shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        {(isTerminalStatus(jobStatus) || !websocketUrl) && initialHistoryLoaded 
                            ? <History className="h-5 w-5 text-blue-500" /> 
                            : <Terminal className="h-5 w-5 text-green-500" />}
                        <span className="truncate" title={jobRunName || jobId || "Log Viewer"}>
                            {titleText}
                        </span>
                    </DialogTitle>
                    <div className="text-muted-foreground text-xs pt-1 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                        <div className="flex-grow space-y-0.5">
                            {jobId && (
                                <p className="truncate">
                                    <span className="font-semibold">Job ID:</span>
                                    <span 
                                        className="font-mono text-xs ml-1.5 bg-muted/50 dark:bg-black/30 px-1.5 py-0.5 rounded-sm"
                                        title={jobId}
                                    >
                                        {jobId}
                                    </span>
                                </p>
                            )}
                            {jobDescription && (
                                <p className="truncate" title={jobDescription}>
                                    <span className="font-semibold">Description:</span>
                                    <span className="ml-1.5">{jobDescription}</span>
                                </p>
                            )}
                            <p className="text-muted-foreground/80 pt-0.5">
                                {isLoadingHistory && "Loading history..."}
                                {isErrorHistory && !isLoadingHistory && "Error loading history."}
                                {isHistorySuccess && isTerminalStatus(jobStatus) && "Displaying complete log history."}
                                {isHistorySuccess && !isTerminalStatus(jobStatus) && "Historical logs loaded. Listening for live updates..."}
                            </p>
                        </div>
                        {isActuallyLive && (
                             <Badge variant="outline" className="flex items-center gap-1.5 py-0.5 px-2 text-xs mt-1 sm:mt-0 self-start sm:self-center flex-shrink-0">
                                 {getStatusIndicator()}
                                 {connectionStatusText}
                             </Badge>
                         )}
                    </div>
                </DialogHeader>

                <ScrollArea className="flex-grow bg-gray-950 dark:bg-black text-white font-mono text-[0.8rem] leading-relaxed overflow-y-auto" onScroll={handleScroll}>
                    <ScrollAreaPrimitive.Viewport ref={scrollAreaViewportRef} className="h-full w-full rounded-[inherit] p-4">
                        {isLoadingHistory && (
                            <div className="flex justify-center items-center h-full">
                                <LoadingSpinner label="Loading log history..." size="lg" className="text-gray-400" />
                            </div>
                        )}
                        {isErrorHistory && !isLoadingHistory && (
                             <ErrorDisplay title="Failed to Load Log History" error={errorHistory} className="m-4 bg-gray-800 text-red-400 border-red-600" />
                        )}

                        {logs.map((log) => {
                            const { content, lineClasses } = getEnhancedLogDetails(log);
                            return (
                               <div key={log.id} className={lineClasses}>
                                    {content}
                               </div>
                            );
                        })}

                        {showEOFMessage && (
                            <p className="text-yellow-400 dark:text-yellow-500 italic pt-2">
                                --- {isTerminalStatus(jobStatus) || !websocketUrl ? "End of historical log" : "End of log stream (Job finished or stopped)"} ---
                            </p>
                        )}
                        <div ref={bottomRef} style={{ height: '1px' }} />
                    </ScrollAreaPrimitive.Viewport>
                    <ScrollBar orientation="vertical" />
                    <ScrollBar orientation="horizontal" />
                </ScrollArea>

                 <DialogFooter className="p-3 border-t flex-shrink-0">
                    {isActuallyLive && (
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
