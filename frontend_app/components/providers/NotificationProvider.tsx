// frontend_app/components/providers/NotificationProvider.tsx
"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid'; // Import a UUID generator

// Expanded NotificationPayload to include more event types
interface NotificationPayload {
  event_type: "job_completed" | "job_failed" | "job_started" | "job_processing_update"; // Added more types
  job_id: string;
  run_name: string;
  message: string;
  status_variant: "success" | "error" | "info" | "warning"; // Added info/warning
  // Optional fields for more detail if needed
  progress?: number;
  current_task?: string;
}

// Structure for items in our notification log
export interface NotificationLogItem {
  id: string; // Unique ID for each log item
  type: "success" | "error" | "info" | "warning"; // Simplified type for panel display
  message: string;
  description?: string; // e.g., Job Name (ID)
  job_id?: string;
  run_name?: string;
  timestamp: number;
}

interface NotificationContextType {
  // Existing permission-related state (can be phased out or repurposed if not needed for panel)
  notificationsEnabled: boolean;
  permissionStatus: NotificationPermission | "loading";
  requestPermission: () => void;
  toggleNotifications: () => void; // Might repurpose this to toggle panel or clear notifications
  isSupported: boolean;

  // New state and functions for the notification panel
  isPanelOpen: boolean;
  openNotificationPanel: () => void;
  closeNotificationPanel: () => void;
  notificationsLog: NotificationLogItem[];
  clearNotificationsLog: () => void;
  unreadNotificationCount: number; // To potentially show a badge on the button
  latestSignificantEventType: "success" | "error" | "info" | "warning" | null; // For button color
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function useNotificationManager() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotificationManager must be used within a NotificationProvider');
  }
  return context;
}

interface NotificationProviderProps {
  children: ReactNode;
}

const NOTIFICATION_PREFERENCE_KEY = 'bioapp_notifications_enabled';
const NOTIFICATION_PERMISSION_KEY = 'bioapp_notification_permission';
const MAX_LOG_ITEMS = 50; // Max number of items to keep in the log

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [isSupported, setIsSupported] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const storedPreference = localStorage.getItem(NOTIFICATION_PREFERENCE_KEY);
      return storedPreference ? JSON.parse(storedPreference) : true;
    }
    return true;
  });
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission | "loading">("loading");
  const router = useRouter();

  // New state for the panel
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [notificationsLog, setNotificationsLog] = useState<NotificationLogItem[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [latestSignificantEventType, setLatestSignificantEventType] = useState<NotificationLogItem['type'] | null>(null);


  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setIsSupported(true);
      setPermissionStatus(Notification.permission);
    } else {
      setIsSupported(false);
      setPermissionStatus('denied');
    }
  }, []);

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
  }, !!websocketUrl);

  useEffect(() => {
    if (lastMessage?.data) {
      try {
        const data = JSON.parse(lastMessage.data as string) as NotificationPayload;
        console.log('[NotificationProvider] Received notification payload:', data);

        // Show in-app toast
        toast[data.status_variant](data.message, {
          description: `Job: ${data.run_name} (ID: ...${data.job_id.slice(-6)})`,
          duration: 10000,
          action: {
            label: "View Job",
            onClick: () => router.push(`/jobs`),
          },
        });

        // Add to internal log for the panel
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
        console.error('[NotificationProvider] Error processing notification message:', error);
      }
    }
  }, [lastMessage, router, isPanelOpen]); // Added isPanelOpen to dependencies

  const requestPermission = useCallback(async () => {
    // This function's relevance diminishes, but we keep it for completeness
    // if the button ever needs to manage browser perms again.
    if (!isSupported || permissionStatus === 'denied') {
      toast.info("Browser notifications are blocked by your browser settings.", { duration: 8000});
      return;
    }
    if (permissionStatus === 'granted') {
        toast.info("Browser notification permission is already granted.", {duration: 6000});
        return;
    }
    try {
      const permission = await Notification.requestPermission();
      setPermissionStatus(permission);
      localStorage.setItem(NOTIFICATION_PERMISSION_KEY, permission);
      // ... (rest of permission handling, less critical now)
    } catch (error) {
      console.error('[NotificationProvider] Error requesting notification permission:', error);
    }
  }, [isSupported, permissionStatus]);

  const toggleNotifications = useCallback(() => {
    // This will now primarily be used to open/close the panel or clear notifications.
    // For now, let's make it open the panel.
    openNotificationPanel();
  }, []); // Removed dependencies no longer relevant for this specific toggle action

  // Panel management functions
  const openNotificationPanel = useCallback(() => {
    setIsPanelOpen(true);
    setUnreadNotificationCount(0); // Reset unread count when panel is opened
    // Optionally reset latestSignificantEventType if button color should reset on open
    // setLatestSignificantEventType(null);
  }, []);

  const closeNotificationPanel = useCallback(() => {
    setIsPanelOpen(false);
  }, []);

  const clearNotificationsLog = useCallback(() => {
    setNotificationsLog([]);
    setUnreadNotificationCount(0);
    setLatestSignificantEventType(null); // Reset button color
    toast.success("Notifications cleared.");
  }, []);

  const contextValue: NotificationContextType = {
    notificationsEnabled, // Keeping for now, might be useful for user preference of in-app features
    permissionStatus,
    requestPermission,
    toggleNotifications, // This will be used to open the panel from the button
    isSupported,
    isPanelOpen,
    openNotificationPanel,
    closeNotificationPanel,
    notificationsLog,
    clearNotificationsLog,
    unreadNotificationCount,
    latestSignificantEventType,
  };

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
}
