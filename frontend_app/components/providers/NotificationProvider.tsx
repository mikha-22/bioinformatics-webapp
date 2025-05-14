// frontend_app/components/providers/NotificationProvider.tsx
"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation'; // For navigating on notification click

interface NotificationPayload {
  event_type: "job_completed" | "job_failed";
  job_id: string;
  run_name: string;
  message: string;
  status_variant: "success" | "error"; // For toast styling
}

interface NotificationContextType {
  notificationsEnabled: boolean;
  permissionStatus: NotificationPermission | "loading"; // Add 'loading' state
  requestPermission: () => void;
  toggleNotifications: () => void;
  isSupported: boolean;
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
const NOTIFICATION_PERMISSION_KEY = 'bioapp_notification_permission'; // To remember if we asked

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [isSupported, setIsSupported] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const storedPreference = localStorage.getItem(NOTIFICATION_PREFERENCE_KEY);
      return storedPreference ? JSON.parse(storedPreference) : true; // Default to true
    }
    return true;
  });
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission | "loading">("loading");
  const router = useRouter();

  // Check for Notification API support and initial permission status
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setIsSupported(true);
      setPermissionStatus(Notification.permission);
    } else {
      setIsSupported(false);
      setPermissionStatus('denied'); // Effectively denied if not supported
    }
  }, []);

  const websocketUrl = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
    const wsProtocol = apiUrl.startsWith('https://') ? 'wss://' : 'ws://';
    const domainAndPath = apiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `${wsProtocol}${domainAndPath}/api/ws/app_notifications`;
  }, []);

  const { lastMessage, readyState } = useWebSocket(websocketUrl, {
    share: true, // Allow multiple components to share this connection if needed later
    shouldReconnect: (closeEvent) => true,
    reconnectInterval: 5000,
    reconnectAttempts: 10,
    retryOnError: true,
    onOpen: () => console.log('[NotificationProvider] WebSocket for notifications opened.'),
    onClose: (event) => console.log(`[NotificationProvider] WebSocket for notifications closed. Code: ${event.code}`),
    onError: (event) => console.error('[NotificationProvider] WebSocket notification error:', event),
    filter: (message: MessageEvent<any>): boolean => typeof message.data === 'string',
  }, !!websocketUrl); // Only connect if URL is valid

  // Handle incoming notification messages
  useEffect(() => {
    if (lastMessage?.data) {
      try {
        const data = JSON.parse(lastMessage.data as string) as NotificationPayload;
        console.log('[NotificationProvider] Received notification payload:', data);

        // Always show in-app toast
        toast[data.status_variant === 'success' ? 'success' : 'error'](data.message, {
          description: `Job: ${data.run_name} (ID: ...${data.job_id.slice(-6)})`,
          duration: 10000, // Longer duration for job notifications
          action: {
            label: "View Job",
            onClick: () => router.push(`/jobs`), // Consider highlighting specific job later
          },
        });

        // Show browser notification if enabled, permission granted, and tab is not visible
        if (notificationsEnabled && permissionStatus === 'granted' && document.visibilityState === 'hidden') {
          const notification = new Notification(`Sarek Job: ${data.run_name}`, {
            body: data.message,
            icon: data.status_variant === 'success' ? '/icons/success_icon_64.png' : '/icons/failure_icon_64.png',
            tag: `job-notification-${data.job_id}`, // Helps replace/group notifications
            renotify: true, // If a notification with the same tag is shown, it will re-alert the user
          });

          notification.onclick = () => {
            window.focus();
            router.push(`/jobs`); // Navigate to jobs page
            notification.close();
          };
        }
      } catch (error) {
        console.error('[NotificationProvider] Error processing notification message:', error);
      }
    }
  }, [lastMessage, notificationsEnabled, permissionStatus, router]);

  const requestPermission = useCallback(async () => {
    if (!isSupported || permissionStatus === 'granted' || permissionStatus === 'denied') {
      if (permissionStatus === 'denied') {
        toast.info("Browser notifications are blocked. Please enable them in your browser settings if you wish to receive them.", { duration: 8000});
      }
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setPermissionStatus(permission);
      localStorage.setItem(NOTIFICATION_PERMISSION_KEY, permission); // Remember choice
      if (permission === 'granted') {
        setNotificationsEnabled(true); // Enable by default if permission granted
        localStorage.setItem(NOTIFICATION_PREFERENCE_KEY, JSON.stringify(true));
        toast.success("Browser notifications enabled!");
      } else if (permission === 'denied') {
        setNotificationsEnabled(false);
        localStorage.setItem(NOTIFICATION_PREFERENCE_KEY, JSON.stringify(false));
        toast.info("Browser notifications denied. You can enable them later via the notification button or browser settings.");
      }
    } catch (error) {
      console.error('[NotificationProvider] Error requesting notification permission:', error);
      toast.error("Could not request notification permission.");
    }
  }, [isSupported, permissionStatus]);

  const toggleNotifications = useCallback(() => {
    if (!isSupported) {
        toast.error("Browser notifications are not supported by this browser.");
        return;
    }
    if (permissionStatus === 'denied') {
      toast.info("Notifications are blocked by your browser. Please check your browser settings.", {
        action: { label: "Help", onClick: () => alert("To enable notifications, go to your browser's site settings for this page and allow notifications.") }
      });
      return;
    }
    if (permissionStatus === 'default') {
      requestPermission(); // Request permission first if not yet granted/denied
      return;
    }
    const newValue = !notificationsEnabled;
    setNotificationsEnabled(newValue);
    localStorage.setItem(NOTIFICATION_PREFERENCE_KEY, JSON.stringify(newValue));
    toast.info(`Browser notifications ${newValue ? 'enabled' : 'disabled'}.`);
  }, [notificationsEnabled, permissionStatus, isSupported, requestPermission]);

  const contextValue: NotificationContextType = {
    notificationsEnabled,
    permissionStatus,
    requestPermission,
    toggleNotifications,
    isSupported,
  };

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
}
