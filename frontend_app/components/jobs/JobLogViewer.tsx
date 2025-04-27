// File: frontend_app/components/jobs/JobLogViewer.tsx
// --- START OF FILE ---
"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
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

export default function JobLogViewer({ jobId, isOpen, onOpenChange, jobDescription }: JobLogViewerProps) {
    const [logs, setLogs] = useState<LogLine[]>([]);
    const scrollAreaViewportRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const [websocketUrl, setWebsocketUrl] = useState<string | null>(null);
    const [showEOFMessage, setShowEOFMessage] = useState(false);
    const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);

    // --- Scroll to Bottom Function (using sentinel) ---
    // <<< CHANGE: Changed default behavior to 'auto' for instant scroll >>>
    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        // console.log(`Attempting scrollIntoView (${behavior})...`); // Debug
        bottomRef.current?.scrollIntoView({ behavior: behavior });
        if (behavior === 'auto') { // Force state update on instant scroll
             setIsScrolledToBottom(true);
        }
    }, []); // No dependencies needed

    // Construct WebSocket URL & Reset State on Open/Job Change
    useEffect(() => {
        if (isOpen && jobId && typeof window !== 'undefined') {
            const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
            const wsProtocol = apiUrl.startsWith('https://') ? 'wss://' : 'ws://';
            const domainAndPath = apiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
            const url = `${wsProtocol}${domainAndPath}/api/ws/logs/${jobId}`;
            console.log("[JobLogViewer] Setting WebSocket URL:", url);
            setWebsocketUrl(url);
            setShowEOFMessage(false);
            setLogs([]);
            messageIdCounter = 0;
            setIsScrolledToBottom(true); // Reset to true on open
             // --- ADDED: Scroll to bottom instantly when opening/switching job ---
             setTimeout(() => scrollToBottom('auto'), 50);
             // --------------------------------------------------------------------
        } else {
            setWebsocketUrl(null);
        }
    }, [jobId, isOpen, scrollToBottom]); // Added scrollToBottom dependency

    // Reset non-URL state when dialog closes
    useEffect(() => {
        if (!isOpen) {
            setLogs([]);
            messageIdCounter = 0;
            setShowEOFMessage(false);
        }
    }, [isOpen]);

    // WebSocket Hook
    const {
        lastMessage,
        readyState,
    } = useWebSocket(websocketUrl, {
         share: false,
         shouldReconnect: (closeEvent) => true,
         reconnectInterval: 3000,
         reconnectAttempts: 10,
         retryOnError: true,
         onOpen: () => console.log(`[JobLogViewer] WebSocket opened for ${jobId}`),
         onClose: (event) => console.log(`[JobLogViewer] WebSocket closed for ${jobId}. Code: ${event.code}, Reason: ${event.reason}`),
         onError: (event) => console.error(`[JobLogViewer] WebSocket error for ${jobId}:`, event),
         filter: (message: MessageEvent<any>): boolean => typeof message.data === 'string',
     }, !!websocketUrl);

    // Handle incoming messages
    useEffect(() => {
        if (lastMessage !== null) {
            let logEntry: LogLine | null = null;
            try {
                const jsonData = JSON.parse(lastMessage.data);
                const logData = jsonData as { type?: string; line?: any };
                const logType = logData.type || 'raw';
                const logLineContent = typeof logData.line === 'string' ? logData.line : JSON.stringify(logData.line ?? '');

                if (logType === 'control' && logLineContent === 'EOF') {
                    console.log(`[JobLogViewer] Received EOF for ${jobId}`);
                    setShowEOFMessage(true);
                    // Scroll after EOF message state is set
                    // <<< CHANGE: Use 'auto' for instant scroll on EOF >>>
                    setTimeout(() => scrollToBottom('auto'), 50);
                    return;
                }
                logEntry = { id: messageIdCounter++, type: logType as LogLine['type'], line: logLineContent, timestamp: Date.now() };
            } catch (e) {
                console.warn("[JobLogViewer] Message not valid JSON, treating as raw:", lastMessage.data);
                logEntry = { id: messageIdCounter++, type: 'raw', line: lastMessage.data, timestamp: Date.now() };
            }
            if (logEntry) {
                setLogs((prevLogs) => [...prevLogs, logEntry!]);
            }
        }
    }, [lastMessage, jobId, scrollToBottom]); // Added scrollToBottom

    // --- Auto-Scroll Effect (using sentinel) ---
    useEffect(() => {
        // Scroll whenever logs update, but only if user is considered at the bottom
        if (isScrolledToBottom) {
            // console.log("Logs updated and isScrolledToBottom=true, scrolling..."); // Debug
            // <<< CHANGE: Use 'auto' for instant scroll on new logs >>>
            scrollToBottom('auto');
        }
        // This effect also handles the initial scroll implicitly after the first logs render
    }, [logs, isScrolledToBottom, scrollToBottom]); // Depend on logs and state

    // Handle manual scrolling
    const handleScroll = useCallback(() => {
        if (scrollAreaViewportRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollAreaViewportRef.current;
            // Use a slightly larger threshold to account for potential rounding errors
            const atBottom = scrollHeight - scrollTop - clientHeight < 15;
            if (atBottom !== isScrolledToBottom) {
                // console.log(`Scrolled to bottom state changed: ${atBottom}`); // Debug
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

    // Log line color
    const getLogLineColor = (type: LogLine['type']): string => {
        switch (type) {
            case 'stdout': return 'text-gray-300 dark:text-gray-300';
            case 'stderr': return 'text-red-500 dark:text-red-400';
            case 'error': return 'text-red-600 dark:text-red-500 font-semibold';
            case 'info': return 'text-blue-500 dark:text-blue-400';
            case 'status': return 'text-yellow-600 dark:text-yellow-400 italic';
            case 'control': return 'hidden'; // Hide control messages like EOF
            case 'raw':
            default: return 'text-gray-500 dark:text-gray-500';
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
                        {logs.map((log) => (
                           <p key={log.id} className={cn(getLogLineColor(log.type), "whitespace-pre-wrap break-words")}>
                                {log.line}
                           </p>
                        ))}

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
