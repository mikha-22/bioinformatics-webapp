// File: frontend_app/components/jobs/JobLogViewer.tsx
// --- START OF FILE ---
"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { Terminal, Wifi, WifiOff, Loader2, ServerCrash } from 'lucide-react';
import Convert from 'ansi-to-html'; // <<< ADDED IMPORT

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

let messageIdCounter = 0;

// Create a new Convert instance
// You can configure options like fg, bg, newline, escapeXML, stream, etc.
const ansiConverter = new Convert({
    newline: true,    // Convert \n to <br/>
    escapeXML: true,  // Escape XML entities for security if rendering HTML directly
    // Optional: Customize colors to better fit your dark theme if defaults clash
    // colors: {
    //   0: '#000', // black
    //   1: '#C00', // red
    //   2: '#0C0', // green
    //   3: '#C90', // yellow
    //   4: '#00C', // blue
    //   5: '#C0C', // magenta
    //   6: '#0CC', // cyan
    //   7: '#CCC', // white
    //   // ... and bright versions 8-15
    // }
});

export default function JobLogViewer({ jobId, isOpen, onOpenChange, jobDescription }: JobLogViewerProps) {
    const [logs, setLogs] = useState<LogLine[]>([]);
    const scrollAreaViewportRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null); // Sentinel for scrolling
    const [websocketUrl, setWebsocketUrl] = useState<string | null>(null);
    const [showEOFMessage, setShowEOFMessage] = useState(false);
    const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);

    // Scroll to Bottom Function
    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        bottomRef.current?.scrollIntoView({ behavior: behavior });
        if (behavior === 'auto') { // Force state update on instant scroll
             setIsScrolledToBottom(true);
        }
    }, []);

    // Construct WebSocket URL & Reset State on Open/Job Change
    useEffect(() => {
        if (isOpen && jobId && typeof window !== 'undefined') {
            const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
            const wsProtocol = apiUrl.startsWith('https://') ? 'wss://' : 'ws://';
            const domainAndPath = apiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
            const url = `${wsProtocol}${domainAndPath}/api/ws/logs/${jobId}`;
            // console.log("[JobLogViewer] Setting WebSocket URL:", url);
            setWebsocketUrl(url);
            setShowEOFMessage(false); // Reset EOF message
            setLogs([]); // Clear previous logs
            messageIdCounter = 0; // Reset counter
            setIsScrolledToBottom(true); // Assume scrolled to bottom initially
             // Scroll to bottom instantly when opening/switching job
             setTimeout(() => scrollToBottom('auto'), 50);
        } else {
            setWebsocketUrl(null); // Clear URL when dialog is closed or no job ID
        }
    }, [jobId, isOpen, scrollToBottom]);

    // Reset non-URL state when dialog closes (mainly for cleanliness if jobId doesn't change but dialog reopens)
    useEffect(() => {
        if (!isOpen) {
            setLogs([]);
            messageIdCounter = 0;
            setShowEOFMessage(false);
            // websocketUrl is already handled by the other useEffect
        }
    }, [isOpen]);

    // WebSocket Hook
    const {
        lastMessage,
        readyState,
    } = useWebSocket(websocketUrl, {
         share: false, // Each viewer instance should have its own connection
         shouldReconnect: (closeEvent) => true, // Always attempt to reconnect
         reconnectInterval: 3000,
         reconnectAttempts: 10,
         retryOnError: true,
         onOpen: () => console.log(`[JobLogViewer] WebSocket opened for ${jobId}`),
         onClose: (event) => console.log(`[JobLogViewer] WebSocket closed for ${jobId}. Code: ${event.code}, Reason: ${event.reason}`),
         onError: (event) => console.error(`[JobLogViewer] WebSocket error for ${jobId}:`, event),
         // Ensure we only process string messages
         filter: (message: MessageEvent<any>): boolean => typeof message.data === 'string',
     }, !!websocketUrl); // Only connect if websocketUrl is not null

    // Handle incoming messages
    useEffect(() => {
        if (lastMessage !== null) {
            let logEntry: LogLine | null = null;
            try {
                const jsonData = JSON.parse(lastMessage.data);
                const logData = jsonData as { type?: string; line?: any }; // Type assertion for clarity
                const logType = logData.type || 'raw';
                // Ensure line is always a string, even if originally a number or object
                const logLineContent = typeof logData.line === 'string' ? logData.line : JSON.stringify(logData.line ?? '');

                if (logType === 'control' && logLineContent === 'EOF') {
                    // console.log(`[JobLogViewer] Received EOF for ${jobId}`);
                    setShowEOFMessage(true);
                    setTimeout(() => scrollToBottom('auto'), 50); // Scroll after EOF message state is set
                    return; // Don't add EOF to logs list
                }
                logEntry = { id: messageIdCounter++, type: logType as LogLine['type'], line: logLineContent, timestamp: Date.now() };
            } catch (e) {
                // If parsing fails, treat the whole message as a raw log line
                // console.warn("[JobLogViewer] Message not valid JSON, treating as raw:", lastMessage.data);
                logEntry = { id: messageIdCounter++, type: 'raw', line: lastMessage.data, timestamp: Date.now() };
            }

            if (logEntry) {
                setLogs((prevLogs) => [...prevLogs, logEntry!]);
            }
        }
    }, [lastMessage, jobId, scrollToBottom]); // Added scrollToBottom

    // Auto-Scroll Effect
    useEffect(() => {
        if (isScrolledToBottom) {
            scrollToBottom('auto');
        }
    }, [logs, isScrolledToBottom, scrollToBottom]);

    // Handle manual scrolling
    const handleScroll = useCallback(() => {
        if (scrollAreaViewportRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollAreaViewportRef.current;
            // A small threshold helps with sub-pixel issues or slight delays
            const atBottom = scrollHeight - scrollTop - clientHeight < 15;
            if (atBottom !== isScrolledToBottom) {
                setIsScrolledToBottom(atBottom);
            }
        }
    }, [isScrolledToBottom]);


    // Connection status text and indicator
    const connectionStatusText = {
        [ReadyState.CONNECTING]: 'Connecting...',
        [ReadyState.OPEN]: 'Connected',
        [ReadyState.CLOSING]: 'Closing...',
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

    // Log line color based on type (primarily for non-ANSI lines or as a base)
    const getLogLineColor = (type: LogLine['type']): string => {
        switch (type) {
            case 'stdout': return 'text-gray-300 dark:text-gray-300'; // Base for stdout
            case 'stderr': return 'text-red-500 dark:text-red-400'; // Base for stderr
            case 'error': return 'text-red-600 dark:text-red-500 font-semibold';
            case 'info': return 'text-blue-500 dark:text-blue-400';
            case 'status': return 'text-yellow-600 dark:text-yellow-400 italic';
            case 'control': return 'hidden'; // Hide control messages like EOF
            case 'raw':
            default: return 'text-gray-500 dark:text-gray-500'; // For unparsed or unknown
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-5xl md:max-w-6xl lg:max-w-7xl h-[90vh] flex flex-col p-0 gap-0">
                {/* Header */}
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
                    <ScrollAreaPrimitive.Viewport ref={scrollAreaViewportRef} className="h-full w-full rounded-[inherit] p-4">
                        {/* Initial Status Messages */}
                        {logs.length === 0 && readyState === ReadyState.CONNECTING && ( <p className="text-yellow-500 italic">Connecting to log stream...</p> )}
                        {logs.length === 0 && readyState === ReadyState.OPEN && !showEOFMessage && ( <p className="text-gray-500 italic">Loading history or waiting for live logs...</p> )}
                        {logs.length === 0 && (readyState === ReadyState.CLOSED || readyState === ReadyState.UNINSTANTIATED) && !websocketUrl && jobId && ( <p className="text-gray-500 italic">Preparing connection...</p> )}
                        {logs.length === 0 && readyState === ReadyState.CLOSED && websocketUrl && !showEOFMessage && ( <p className="text-red-500 italic">Connection closed. Attempting to reconnect...</p> )}

                        {/* Render Logs */}
                        {logs.map((log) => {
                            // Convert ANSI to HTML
                            const htmlLogLine = ansiConverter.toHtml(log.line);
                            return (
                               <div // Use div for block display of potentially multi-span HTML from ansi-to-html
                                    key={log.id}
                                    className={cn(getLogLineColor(log.type), "whitespace-pre-wrap break-words")}
                                    dangerouslySetInnerHTML={{ __html: htmlLogLine }}
                                />
                            );
                        })}

                        {/* EOF Message */}
                        {showEOFMessage && ( <p className="text-yellow-400 italic pt-2">--- End of log stream (Job finished or stopped) ---</p> )}

                        {/* Sentinel Element for scrolling */}
                        <div ref={bottomRef} style={{ height: '1px' }} />

                    </ScrollAreaPrimitive.Viewport>
                    <ScrollBar orientation="vertical" />
                    <ScrollBar orientation="horizontal" />
                </ScrollArea>

                 {/* Footer with Pause/Resume Button */}
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
// --- END OF FILE ---
