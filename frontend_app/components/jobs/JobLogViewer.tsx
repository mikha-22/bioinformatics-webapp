// frontend_app/components/jobs/JobLogViewer.tsx
"use client";

import React, { useState, useEffect, useRef } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket'; // Use the correct library
import { Terminal, Wifi, WifiOff, Loader2, ServerCrash } from 'lucide-react';

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
import { cn } from '@/lib/utils';

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
    jobDescription?: string | null;
}

let messageIdCounter = 0; // Simple counter for unique log line keys

export default function JobLogViewer({ jobId, isOpen, onOpenChange, jobDescription }: JobLogViewerProps) {
    const [logs, setLogs] = useState<LogLine[]>([]);
    const logContainerRef = useRef<HTMLDivElement>(null); // Ref for the inner div of ScrollArea
    const [websocketUrl, setWebsocketUrl] = useState<string | null>(null);
    const [showEOFMessage, setShowEOFMessage] = useState(false);

    // Construct WebSocket URL only on the client when jobId changes or dialog opens
    useEffect(() => {
        if (isOpen && jobId && typeof window !== 'undefined') {
            const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
            const wsProtocol = apiUrl.startsWith('https://') ? 'wss://' : 'ws://';
            const domainAndPath = apiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
            // Use the prefix defined in the websockets router
            const url = `${wsProtocol}${domainAndPath}/api/ws/logs/${jobId}`;
            console.log("[JobLogViewer] Setting WebSocket URL:", url);
            setWebsocketUrl(url);
            setShowEOFMessage(false); // Reset EOF on open/job change
        } else {
            // Clear URL when dialog closes or no job ID
            setWebsocketUrl(null);
        }
    }, [jobId, isOpen]); // Depend on isOpen as well

    // Reset logs when dialog closes or jobId changes
    useEffect(() => {
        if (!isOpen) {
            console.log("[JobLogViewer] Dialog closed, resetting logs.");
            setLogs([]);
            messageIdCounter = 0; // Reset counter
            setShowEOFMessage(false);
        }
    }, [isOpen]);

    // Use react-use-websocket hook
    const {
        lastMessage, // The most recent message event
        readyState,  // Connection state enum
    } = useWebSocket(websocketUrl, {
        share: false, // Each instance should have its own connection
        shouldReconnect: (closeEvent) => true, // Attempt to reconnect on close
        reconnectInterval: 3000,
        reconnectAttempts: 10, // Increase attempts slightly
        retryOnError: true, // Retry connection on error
        onOpen: () => console.log(`[JobLogViewer] WebSocket opened for ${jobId}`),
        onClose: (event) => console.log(`[JobLogViewer] WebSocket closed for ${jobId}. Code: ${event.code}, Reason: ${event.reason}`),
        onError: (event) => console.error(`[JobLogViewer] WebSocket error for ${jobId}:`, event),
        // Filter out non-relevant messages if needed, though backend should only send strings
        filter: (message: MessageEvent<any>): boolean => {
            return typeof message.data === 'string'; // Only process string messages
        },
    }, !!websocketUrl); // Connect only if websocketUrl is not null

    // Handle incoming messages using lastMessage
    useEffect(() => {
        if (lastMessage !== null) {
            try {
                const jsonData = JSON.parse(lastMessage.data);
                const logData = jsonData as { type?: string; line?: any }; // Type assertion
                const logType = logData.type || 'raw';
                const logLineContent = typeof logData.line === 'string' ? logData.line : JSON.stringify(logData.line);

                // Check for EOF control message
                if (logType === 'control' && logLineContent === 'EOF') {
                    console.log(`[JobLogViewer] Received EOF for ${jobId}`);
                    setShowEOFMessage(true);
                    return; // Stop processing this message
                }

                const logEntry: LogLine = {
                    id: messageIdCounter++,
                    type: logType as LogLine['type'], // Assert type
                    line: logLineContent,
                    timestamp: Date.now()
                };
                // Add new log entry, potentially capping the total number of lines
                setLogs((prevLogs) => {
                     const newLogs = [...prevLogs, logEntry];
                    // Optional: Limit the number of log lines stored in state to prevent memory issues
                    // const MAX_LOG_LINES = 2000;
                    // if (newLogs.length > MAX_LOG_LINES) {
                    //     return newLogs.slice(newLogs.length - MAX_LOG_LINES);
                    // }
                    return newLogs;
                });

            } catch (e) {
                console.error("[JobLogViewer] Error processing WebSocket message:", e, lastMessage.data);
                 setLogs((prevLogs) => [...prevLogs, { id: messageIdCounter++, type: 'error', line: `Error processing message: ${lastMessage.data}`, timestamp: Date.now()}]);
            }
        }
    }, [lastMessage, jobId]); // Depend on lastMessage and jobId

    // Scroll to bottom effect
    useEffect(() => {
        if (logContainerRef.current) {
            // Slightly more robust scroll check
            const scrollThreshold = 100; // Pixels from bottom
            const isScrolledToBottom = logContainerRef.current.scrollHeight - logContainerRef.current.scrollTop - logContainerRef.current.clientHeight < scrollThreshold;

            if (isScrolledToBottom) {
                requestAnimationFrame(() => {
                     if (logContainerRef.current) {
                        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                     }
                });
            }
        }
    }, [logs]); // Trigger scroll on new logs

    // Connection status text and indicator
    const connectionStatusText = {
        [ReadyState.CONNECTING]: 'Connecting',
        [ReadyState.OPEN]: 'Connected',
        [ReadyState.CLOSING]: 'Closing',
        [ReadyState.CLOSED]: 'Disconnected',
        [ReadyState.UNINSTANTIATED]: 'Idle',
    }[readyState];

    const getStatusIndicator = () => {
         switch (readyState) {
             case ReadyState.CONNECTING: return <Loader2 className="h-3 w-3 animate-spin text-yellow-500"/>;
             case ReadyState.OPEN: return <Wifi className="h-3 w-3 text-green-500"/>;
             case ReadyState.CLOSED: return <WifiOff className="h-3 w-3 text-red-500"/>;
             case ReadyState.CLOSING: return <WifiOff className="h-3 w-3 text-yellow-500"/>;
             default: return <ServerCrash className="h-3 w-3 text-gray-500"/>;
         }
    };

    // Log line color
    const getLogLineColor = (type: LogLine['type']): string => {
        switch (type) {
            case 'stdout': return 'text-gray-300 dark:text-gray-300';
            case 'stderr': return 'text-red-500 dark:text-red-400';
            case 'error': return 'text-red-600 dark:text-red-500 font-semibold';
            case 'info': return 'text-blue-600 dark:text-blue-400';
            case 'status': return 'text-yellow-600 dark:text-yellow-400 italic';
            case 'control': return 'text-purple-600 dark:text-purple-400 italic'; // Should not be displayed now
            case 'raw':
            default: return 'text-gray-500 dark:text-gray-500';
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            {/* Increased max width and height */}
            <DialogContent className="sm:max-w-5xl md:max-w-6xl lg:max-w-7xl h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="p-4 border-b flex-shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        <Terminal className="h-5 w-5" /> Live Logs: <span className="font-mono text-sm ml-1">{jobDescription || jobId}</span>
                    </DialogTitle>
                    <DialogDescription className="flex items-center justify-between text-xs pt-1">
                         <span>Real-time output from the pipeline process.</span>
                         <Badge variant="outline" className="flex items-center gap-1.5 py-0.5 px-2 text-xs">
                             {getStatusIndicator()}
                             {connectionStatusText}
                         </Badge>
                    </DialogDescription>
                </DialogHeader>
                {/* Use ScrollArea for consistent scrollbars */}
                <ScrollArea className="flex-grow bg-gray-950 dark:bg-black text-white font-mono text-[0.8rem] leading-relaxed overflow-y-auto">
                     {/* The direct child of ScrollArea needs the ref */}
                     <div ref={logContainerRef} className="p-4 space-y-0.5 min-h-full">
                         {logs.length === 0 && readyState === ReadyState.OPEN && !showEOFMessage && (
                             <p className="text-gray-500 italic">Waiting for logs...</p>
                         )}
                         {logs.length === 0 && (readyState === ReadyState.CLOSED || readyState === ReadyState.UNINSTANTIATED) && !websocketUrl && jobId && (
                             <p className="text-gray-500 italic">Preparing connection...</p>
                         )}
                          {logs.length === 0 && readyState === ReadyState.CLOSED && websocketUrl && !showEOFMessage && (
                              <p className="text-red-500 italic">Connection closed unexpectedly. Logs might be incomplete. Attempting to reconnect...</p>
                         )}
                         {logs.length === 0 && readyState === ReadyState.CONNECTING && (
                              <p className="text-yellow-500 italic">Connecting to log stream...</p>
                         )}
                        {logs.map((log) => (
                           <p key={log.id} className={cn(getLogLineColor(log.type))}>
                                {log.line}
                           </p>
                        ))}
                        {showEOFMessage && (
                             <p className="text-yellow-400 italic pt-2">--- End of log stream (Job finished or stopped) ---</p>
                        )}
                    </div>
                    <ScrollBar orientation="vertical" />
                    <ScrollBar orientation="horizontal" /> {/* Added horizontal scrollbar */}
                </ScrollArea>
                 <DialogFooter className="p-3 border-t flex-shrink-0">
                    <DialogClose asChild>
                        <Button type="button" variant="outline">Close</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
