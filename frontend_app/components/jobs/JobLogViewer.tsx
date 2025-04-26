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
    type: 'stdout' | 'stderr' | 'info' | 'error' | 'status' | 'control' | 'raw'; // Added 'control' type
    line: string;
    timestamp: number;
}

interface JobLogViewerProps {
    jobId: string | null; // ID of the job to view logs for
    isOpen: boolean; // Whether the dialog is open
    onOpenChange: (open: boolean) => void; // Function to control dialog state
    jobDescription?: string | null; // Optional description for the dialog title
}

let messageIdCounter = 0; // Simple counter for unique log line keys

export default function JobLogViewer({ jobId, isOpen, onOpenChange, jobDescription }: JobLogViewerProps) {
    const [logs, setLogs] = useState<LogLine[]>([]);
    const scrollAreaViewportRef = useRef<HTMLDivElement>(null); // Ref for the ScrollArea Viewport
    const [websocketUrl, setWebsocketUrl] = useState<string | null>(null);
    const [showEOFMessage, setShowEOFMessage] = useState(false);
    const [isScrolledToBottom, setIsScrolledToBottom] = useState(true); // Track if user is at the bottom

    // Construct WebSocket URL only on the client when jobId changes or dialog opens
    useEffect(() => {
        if (isOpen && jobId && typeof window !== 'undefined') {
            const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
            // Ensure correct protocol (ws/wss) based on API URL
            const wsProtocol = apiUrl.startsWith('https://') ? 'wss://' : 'ws://';
            // Remove http(s):// prefix and trailing slash if present
            const domainAndPath = apiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
            // Construct the URL using the prefix defined in the websockets router
            const url = `${wsProtocol}${domainAndPath}/api/ws/logs/${jobId}`;
            console.log("[JobLogViewer] Setting WebSocket URL:", url);
            setWebsocketUrl(url);
            setShowEOFMessage(false); // Reset EOF on open/job change
            setLogs([]); // Clear previous logs when opening for a new job
            messageIdCounter = 0; // Reset message counter
            setIsScrolledToBottom(true); // Default to auto-scroll when opening
        } else {
            // Clear URL when dialog closes or no job ID
            setWebsocketUrl(null);
        }
    }, [jobId, isOpen]);

    // Reset logs and EOF when dialog closes
    useEffect(() => {
        if (!isOpen) {
            // console.log("[JobLogViewer] Dialog closed, resetting state.");
            setLogs([]);
            messageIdCounter = 0;
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
        reconnectAttempts: 10,
        retryOnError: true,
        onOpen: () => console.log(`[JobLogViewer] WebSocket opened for ${jobId}`),
        onClose: (event) => console.log(`[JobLogViewer] WebSocket closed for ${jobId}. Code: ${event.code}, Reason: ${event.reason}`),
        onError: (event) => console.error(`[JobLogViewer] WebSocket error for ${jobId}:`, event),
        filter: (message: MessageEvent<any>): boolean => typeof message.data === 'string',
    }, !!websocketUrl); // Connect only if websocketUrl is not null

    // Handle incoming messages using lastMessage
    useEffect(() => {
        if (lastMessage !== null) {
            try {
                // Attempt to parse the message data as JSON
                const jsonData = JSON.parse(lastMessage.data);
                const logData = jsonData as { type?: string; line?: any };
                const logType = logData.type || 'raw';
                const logLineContent = typeof logData.line === 'string' ? logData.line : JSON.stringify(logData.line ?? '');

                // Check for EOF control message
                if (logType === 'control' && logLineContent === 'EOF') {
                    console.log(`[JobLogViewer] Received EOF for ${jobId}`);
                    setShowEOFMessage(true);
                    return; // Stop processing this message, don't add it to visible logs
                }

                // Create the log entry (only for non-control messages)
                const logEntry: LogLine = {
                    id: messageIdCounter++,
                    type: logType as LogLine['type'], // Assert type
                    line: logLineContent,
                    timestamp: Date.now()
                };

                // Add new log entry
                setLogs((prevLogs) => [...prevLogs, logEntry]);

            } catch (e) {
                // If parsing fails, treat it as a raw line (could be direct output)
                console.warn("[JobLogViewer] Message not valid JSON, treating as raw:", lastMessage.data);
                const logEntry: LogLine = {
                    id: messageIdCounter++,
                    type: 'raw',
                    line: lastMessage.data,
                    timestamp: Date.now()
                };
                setLogs((prevLogs) => [...prevLogs, logEntry]);
            }
        }
    }, [lastMessage, jobId]); // Depend on lastMessage and jobId

    // Scroll to bottom effect
    useEffect(() => {
        if (isScrolledToBottom && scrollAreaViewportRef.current) {
            // Use requestAnimationFrame for smoother scrolling after render
            requestAnimationFrame(() => {
                if (scrollAreaViewportRef.current) {
                    scrollAreaViewportRef.current.scrollTop = scrollAreaViewportRef.current.scrollHeight;
                }
            });
        }
    }, [logs, isScrolledToBottom]); // Trigger scroll on new logs only if already at bottom

    // Handle manual scrolling
    const handleScroll = () => {
        if (scrollAreaViewportRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollAreaViewportRef.current;
            // Check if scrolled near the bottom (within a small threshold)
            const atBottom = scrollHeight - scrollTop - clientHeight < 10;
            if (atBottom !== isScrolledToBottom) {
                setIsScrolledToBottom(atBottom);
            }
        }
    };


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
            case 'info': return 'text-blue-500 dark:text-blue-400';
            case 'status': return 'text-yellow-600 dark:text-yellow-400 italic';
            case 'control': return 'hidden'; // Control messages shouldn't be displayed
            case 'raw':
            default: return 'text-gray-500 dark:text-gray-500'; // Default for raw/unknown
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-5xl md:max-w-6xl lg:max-w-7xl h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="p-4 border-b flex-shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        <Terminal className="h-5 w-5" /> Live Logs: <span className="font-mono text-sm ml-1 truncate">{jobDescription || jobId}</span>
                    </DialogTitle>
                    <DialogDescription className="flex items-center justify-between text-xs pt-1">
                         <span>Real-time output & history from the pipeline process.</span>
                         <Badge variant="outline" className="flex items-center gap-1.5 py-0.5 px-2 text-xs">
                             {getStatusIndicator()}
                             {connectionStatusText}
                         </Badge>
                    </DialogDescription>
                </DialogHeader>

                <ScrollArea className="flex-grow bg-gray-950 dark:bg-black text-white font-mono text-[0.8rem] leading-relaxed overflow-y-auto" onScroll={handleScroll}>
                     {/* Assign ref to the Viewport component */}
                    <ScrollAreaPrimitive.Viewport ref={scrollAreaViewportRef} className="h-full w-full rounded-[inherit] p-4">
                        {/* Initial Status Messages */}
                        {logs.length === 0 && readyState === ReadyState.CONNECTING && (
                            <p className="text-yellow-500 italic">Connecting to log stream...</p>
                        )}
                        {logs.length === 0 && readyState === ReadyState.OPEN && !showEOFMessage && (
                             <p className="text-gray-500 italic">Loading history or waiting for live logs...</p>
                        )}
                        {logs.length === 0 && (readyState === ReadyState.CLOSED || readyState === ReadyState.UNINSTANTIATED) && !websocketUrl && jobId && (
                             <p className="text-gray-500 italic">Preparing connection...</p>
                        )}
                         {logs.length === 0 && readyState === ReadyState.CLOSED && websocketUrl && !showEOFMessage && (
                              <p className="text-red-500 italic">Connection closed. Attempting to reconnect...</p>
                         )}

                        {/* Render Logs */}
                        {logs.map((log) => (
                           <p key={log.id} className={cn(getLogLineColor(log.type), "whitespace-pre-wrap break-words")}> {/* Ensure wrapping */}
                                {log.line}
                           </p>
                        ))}

                        {/* EOF Message */}
                        {showEOFMessage && (
                             <p className="text-yellow-400 italic pt-2">--- End of log stream (Job finished or stopped) ---</p>
                        )}
                    </ScrollAreaPrimitive.Viewport>
                    <ScrollBar orientation="vertical" />
                    <ScrollBar orientation="horizontal" />
                </ScrollArea>

                 <DialogFooter className="p-3 border-t flex-shrink-0">
                    <Button type="button" variant="secondary" onClick={() => setIsScrolledToBottom(!isScrolledToBottom)} size="sm">
                       {isScrolledToBottom ? "Pause Auto-Scroll" : "Resume Auto-Scroll"}
                    </Button>
                    <DialogClose asChild>
                        <Button type="button" variant="outline" size="sm">Close</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// Need to import ScrollAreaPrimitive explicitly if using its Viewport directly
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
