// frontend_app/components/providers/NotificationProvider.tsx
"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo, useRef } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';

// Expanded NotificationPayload to include more event types
interface NotificationPayload {
  event_type: "job_completed" | "job_failed" | "job_started" | "job_processing_update";
  job_id: string;
  run_name: string;
  message: string;
  status_variant: "success" | "error" | "info" | "warning";
  progress?: number;
  current_task?: string;
}

// Structure for items in our notification log
export interface NotificationLogItem {
  id: string;
  type: "success" | "error" | "info" | "warning";
  message: string;
  description?: string;
  job_id?: string;
  run_name?: string;
  timestamp: number;
}

interface NotificationContextType {
  notificationsEnabled: boolean;
  permissionStatus: NotificationPermission | "loading";
  requestPermission: () => void;
  toggleNotifications: () => void;
  isSupported: boolean;
  isPanelOpen: boolean;
  openNotificationPanel: () => void;
  closeNotificationPanel: () => void;
  notificationsLog: NotificationLogItem[];
  clearNotificationsLog: () => void;
  unreadNotificationCount: number;
  latestSignificantEventType: "success" | "error" | "info" | "warning" | null;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function useNotificationManager() {
  const context = useContext(NotificationContext);
  // console.log('[useNotificationManager DEBUG] Context value:', context); // Kept for debugging if needed
  if (!context) {
    console.error('[useNotificationManager ERROR] Context is undefined. Ensure the component is wrapped by NotificationProvider.');
    throw new Error('useNotificationManager must be used within a NotificationProvider - CONTEXT IS UNDEFINED AT HOOK LEVEL');
  }
  return context;
}

interface NotificationProviderProps {
  children: ReactNode;
}

const NOTIFICATION_PREFERENCE_KEY = 'bioapp_notifications_enabled';
const NOTIFICATION_PERMISSION_KEY = 'bioapp_notification_permission';
const NOTIFICATION_LOG_STORAGE_KEY = 'bioapp_notifications_log_v1';
const MAX_LOG_ITEMS = 50;

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [isMounted, setIsMounted] = useState(false);

  const [isSupported, setIsSupported] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(true);
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission | "loading">("loading");
  const router = useRouter();

  const [notificationsLog, setNotificationsLog] = useState<NotificationLogItem[]>([]);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [latestSignificantEventType, setLatestSignificantEventType] = useState<NotificationLogItem['type'] | null>(null);

  const lastProcessedMessageDataRef = useRef<string | null>(null);

  useEffect(() => {
    setIsMounted(true);

    const storedLog = localStorage.getItem(NOTIFICATION_LOG_STORAGE_KEY);
    if (storedLog) {
      try {
        const parsedLog = JSON.parse(storedLog);
        if (Array.isArray(parsedLog)) {
          const logFromStorage = parsedLog.slice(0, MAX_LOG_ITEMS);
          setNotificationsLog(logFromStorage);
          if (logFromStorage.length > 0) {
            setLatestSignificantEventType(logFromStorage[0].type);
          }
        }
      } catch (e) {
        console.error("Error parsing stored notifications log:", e);
        localStorage.removeItem(NOTIFICATION_LOG_STORAGE_KEY);
      }
    }

    const storedPreference = localStorage.getItem(NOTIFICATION_PREFERENCE_KEY);
    setNotificationsEnabled(storedPreference ? JSON.parse(storedPreference) : true);

    if ('Notification' in window) {
      setIsSupported(true);
      setPermissionStatus(Notification.permission);
    } else {
      setIsSupported(false);
      setPermissionStatus('denied');
    }
  }, []);

  useEffect(() => {
    if (isMounted && typeof window !== 'undefined') {
      try {
        localStorage.setItem(NOTIFICATION_LOG_STORAGE_KEY, JSON.stringify(notificationsLog.slice(0, MAX_LOG_ITEMS)));
      } catch (e) {
        console.error("Error saving notifications log to localStorage:", e);
      }
    }
  }, [notificationsLog, isMounted]);


  const websocketUrl = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
    const wsProtocol = apiUrl.startsWith('https://') ? 'wss://' : 'ws://';
    const domainAndPath = apiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `${wsProtocol}${domainAndPath}/api/ws/app_notifications`;
  }, []);

  const { lastMessage } = useWebSocket(websocketUrl, {
    share: true,
    shouldReconnect: (closeEvent) => true,
    reconnectInterval: 5000,
    reconnectAttempts: 10,
    retryOnError: true,
    onOpen: () => console.log('[NotificationProvider] WebSocket for notifications opened.'),
    onClose: (event) => console.log(`[NotificationProvider] WebSocket for notifications closed. Code: ${event.code}`),
    onError: (event) => console.error('[NotificationProvider] WebSocket notification error:', event),
    filter: (message: MessageEvent<any>): boolean => typeof message.data === 'string',
  }, !!websocketUrl && isMounted);

  useEffect(() => {
    if (isMounted && lastMessage?.data) {
      if (lastMessage.data === lastProcessedMessageDataRef.current) {
        // console.log('[NotificationProvider DEBUG] Already processed this exact lastMessage.data, skipping.');
        return;
      }

      try {
        const data = JSON.parse(lastMessage.data as string) as NotificationPayload;
        // console.log('[NotificationProvider DEBUG] Received WebSocket data for processing:', data);

        lastProcessedMessageDataRef.current = lastMessage.data;

        toast[data.status_variant](data.message, {
          description: `Job: ${data.run_name} (ID: ...${data.job_id.slice(-6)})`,
          duration: 10000,
          action: { label: "View Job", onClick: () => router.push(`/jobs`) },
        });

        const newLogItem: NotificationLogItem = {
          id: uuidv4(),
          type: data.status_variant,
          message: data.message,
          description: `Job: ${data.run_name} (ID: ...${data.job_id.slice(-6)})`,
          job_id: data.job_id,
          run_name: data.run_name,
          timestamp: Date.now(),
        };
        
        setNotificationsLog(prevLog => [newLogItem, ...prevLog.slice(0, MAX_LOG_ITEMS - 1)]);
        setLatestSignificantEventType(data.status_variant);

        if (!isPanelOpen) {
          setUnreadNotificationCount(prev => prev + 1);
        }

      } catch (error) {
        console.error('[NotificationProvider DEBUG] Error processing notification message:', error);
        lastProcessedMessageDataRef.current = null; 
      }
    }
  }, [lastMessage, isMounted, router, isPanelOpen]); // isPanelOpen is needed for unreadNotificationCount logic

  const requestPermission = useCallback(async () => {
    if (!isMounted || !isSupported || permissionStatus === 'denied') {
      toast.info("Browser notifications are blocked or not supported.", { duration: 8000});
      return;
    }
    if (permissionStatus === 'granted') {
        toast.info("Browser notification permission is already granted.", {duration: 6000});
        return;
    }
    try {
      const permission = await Notification.requestPermission();
      setPermissionStatus(permission); // Update state
      if(typeof window !== 'undefined') localStorage.setItem(NOTIFICATION_PERMISSION_KEY, permission); // Persist
      if (permission === 'granted') {
        setNotificationsEnabled(true); // Update state
        if(typeof window !== 'undefined') localStorage.setItem(NOTIFICATION_PREFERENCE_KEY, JSON.stringify(true)); // Persist
        toast.success("Browser notification permission granted!");
      } else if (permission === 'denied') {
        setNotificationsEnabled(false); // Update state
        if(typeof window !== 'undefined') localStorage.setItem(NOTIFICATION_PREFERENCE_KEY, JSON.stringify(false)); // Persist
        toast.info("Browser notifications denied.");
      }
    } catch (error) {
      console.error('[NotificationProvider] Error requesting notification permission:', error);
      toast.error("Could not request notification permission.");
    }
  }, [isMounted, isSupported, permissionStatus]);

  const openNotificationPanel = useCallback(() => {
    if (isMounted) {
        setIsPanelOpen(true);
        setUnreadNotificationCount(0);
    }
  }, [isMounted]);
  
  const toggleNotifications = useCallback(() => { // This function is called by FloatingNotificationButton's onClick
    if (isMounted) {
        openNotificationPanel(); // Primary action is to open panel
    }
  }, [isMounted, openNotificationPanel]);


  const closeNotificationPanel = useCallback(() => {
    if (isMounted) setIsPanelOpen(false);
  }, [isMounted]);

  const clearNotificationsLog = useCallback(() => {
    if (isMounted) {
        setNotificationsLog([]);
        setUnreadNotificationCount(0);
        setLatestSignificantEventType(null);
        if (typeof window !== 'undefined') {
          localStorage.removeItem(NOTIFICATION_LOG_STORAGE_KEY);
        }
        toast.success("Notifications cleared.");
    }
  }, [isMounted]);

  useEffect(() => {
    if (isMounted && !latestSignificantEventType && notificationsLog.length > 0) {
      setLatestSignificantEventType(notificationsLog[0].type);
    }
  }, [notificationsLog, latestSignificantEventType, isMounted]);


  const contextValue: NotificationContextType = {
    notificationsEnabled,
    permissionStatus,
    requestPermission,
    toggleNotifications,
    isSupported,
    isPanelOpen,
    openNotificationPanel,
    closeNotificationPanel,
    notificationsLog: isMounted ? notificationsLog : [],
    clearNotificationsLog,
    unreadNotificationCount: isMounted ? unreadNotificationCount : 0,
    latestSignificantEventType: isMounted ? latestSignificantEventType : null,
  };

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
}
