// frontend_app/components/providers/NotificationProvider.tsx
"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';

interface NotificationPayload { /* ... */ }
export interface NotificationLogItem { /* ... */ }
interface NotificationContextType { /* ... */ }

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);
export function useNotificationManager() { /* ... */ }

const NOTIFICATION_PREFERENCE_KEY = 'bioapp_notifications_enabled';
const NOTIFICATION_PERMISSION_KEY = 'bioapp_notification_permission';
const NOTIFICATION_LOG_STORAGE_KEY = 'bioapp_notifications_log_v1';
const MAX_LOG_ITEMS = 50;

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [isMounted, setIsMounted] = useState(false); // <-- New state for hydration safety

  const [isSupported, setIsSupported] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(true); // Default before mount
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission | "loading">("loading");
  const router = useRouter();

  // Initialize with empty/default values, will be populated from localStorage after mount
  const [notificationsLog, setNotificationsLog] = useState<NotificationLogItem[]>([]);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [latestSignificantEventType, setLatestSignificantEventType] = useState<NotificationLogItem['type'] | null>(null);

  // Effect to run only on the client after mounting
  useEffect(() => {
    setIsMounted(true); // Signal that client has mounted

    // Load from localStorage now that we are on the client
    const storedLog = localStorage.getItem(NOTIFICATION_LOG_STORAGE_KEY);
    if (storedLog) {
      try {
        const parsedLog = JSON.parse(storedLog);
        if (Array.isArray(parsedLog)) {
          const logFromStorage = parsedLog.slice(0, MAX_LOG_ITEMS);
          setNotificationsLog(logFromStorage);
          if (logFromStorage.length > 0) {
            setLatestSignificantEventType(logFromStorage[0].type);
            // Note: unreadNotificationCount logic is complex to persist reliably without more state.
            // For now, it resets on load, and only increments for new messages while panel is closed.
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
  }, []); // Empty dependency array ensures this runs once on mount

  // Persist notificationsLog to localStorage whenever it changes, only if mounted
  useEffect(() => {
    if (isMounted && typeof window !== 'undefined') {
      try {
        localStorage.setItem(NOTIFICATION_LOG_STORAGE_KEY, JSON.stringify(notificationsLog.slice(0, MAX_LOG_ITEMS)));
      } catch (e) {
        console.error("Error saving notifications log to localStorage:", e);
      }
    }
  }, [notificationsLog, isMounted]);


  const websocketUrl = useMemo(() => { /* ... unchanged ... */ }, []);
  const { lastMessage } = useWebSocket(websocketUrl, { /* ... options ... */ }, !!websocketUrl);

  useEffect(() => {
    if (isMounted && lastMessage?.data) { // Only process if mounted
      // ... (rest of your lastMessage handling logic remains the same) ...
      try {
        const data = JSON.parse(lastMessage.data as string) as NotificationPayload;
        // console.log('[NotificationProvider DEBUG] Received WebSocket data:', data);

        const lastLogEntry = notificationsLog[0];
        if (
          lastLogEntry &&
          lastLogEntry.job_id === data.job_id &&
          lastLogEntry.message === data.message &&
          lastLogEntry.type === data.status_variant &&
          (Date.now() - lastLogEntry.timestamp < 3000)
        ) {
          // console.warn('[NotificationProvider DEBUG] Likely duplicate message received, skipping log add:', data);
          if (data.status_variant === 'error' || (data.status_variant === 'warning' && latestSignificantEventType !== 'error')) {
            setLatestSignificantEventType(data.status_variant);
          }
          return;
        }

        toast[data.status_variant](data.message, { /* ... toast config ... */ });

        const newLogItem: NotificationLogItem = {
          id: uuidv4(),
          type: data.status_variant,
          message: data.message,
          description: `Job: ${data.run_name} (ID: ...${data.job_id.slice(-6)})`,
          job_id: data.job_id,
          run_name: data.run_name,
          timestamp: Date.now(),
        };
        
        // console.log('[NotificationProvider DEBUG] New log item created:', newLogItem);

        setNotificationsLog(prevLog => {
          const updatedLog = [newLogItem, ...prevLog.slice(0, MAX_LOG_ITEMS - 1)];
          // console.log(`[NotificationProvider DEBUG] Updating notificationsLog. Prev length: ${prevLog.length}, New length: ${updatedLog.length}`);
          return updatedLog;
        });

        setLatestSignificantEventType(data.status_variant);
        if (!isPanelOpen) {
          setUnreadNotificationCount(prev => prev + 1);
        }

      } catch (error) {
        console.error('[NotificationProvider DEBUG] Error processing notification message:', error);
      }
    }
  }, [lastMessage, router, isPanelOpen, notificationsLog, latestSignificantEventType, isMounted]); // Added isMounted

  const requestPermission = useCallback(async () => { /* ... unchanged ... */ }, [isSupported, permissionStatus]);
  const toggleNotifications = useCallback(() => { /* ... unchanged ... */ }, [/* ... */]);
  const openNotificationPanel = useCallback(() => { /* ... unchanged ... */ }, []);
  const closeNotificationPanel = useCallback(() => { /* ... unchanged ... */ }, []);

  const clearNotificationsLog = useCallback(() => {
    setNotificationsLog([]);
    setUnreadNotificationCount(0);
    setLatestSignificantEventType(null);
    if (isMounted && typeof window !== 'undefined') {
      localStorage.removeItem(NOTIFICATION_LOG_STORAGE_KEY);
    }
    toast.success("Notifications cleared.");
  }, [isMounted]);


  const contextValue: NotificationContextType = {
    notificationsEnabled,
    permissionStatus,
    requestPermission,
    toggleNotifications,
    isSupported,
    isPanelOpen,
    openNotificationPanel,
    closeNotificationPanel,
    notificationsLog: isMounted ? notificationsLog : [], // Return empty log if not mounted yet
    clearNotificationsLog,
    unreadNotificationCount: isMounted ? unreadNotificationCount : 0,
    latestSignificantEventType: isMounted ? latestSignificantEventType : null, // Return default if not mounted
  };

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
}
