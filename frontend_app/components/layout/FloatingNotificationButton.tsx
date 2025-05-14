// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React from 'react';
import { Bell, BellRing, BellOff, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useNotificationManager } from '@/components/providers/NotificationProvider';
import { cn } from '@/lib/utils';

export default function FloatingNotificationButton() {
  const {
    notificationsEnabled,
    permissionStatus,
    requestPermission,
    toggleNotifications,
    isSupported,
  } = useNotificationManager();

  if (!isSupported) {
    return null; // Don't render the button if notifications aren't supported
  }

  const getIconAndTooltip = () => {
    if (permissionStatus === 'denied') {
      return {
        icon: <BellOff className="h-6 w-6 text-destructive" />,
        tooltip: "Notifications blocked by browser. Click to see how to enable.",
        action: toggleNotifications, // Will show info toast
        variant: "destructive_outline" as const, // Custom variant for styling
      };
    }
    if (permissionStatus === 'default') {
      return {
        icon: <Bell className="h-6 w-6 text-muted-foreground" />,
        tooltip: "Click to enable browser notifications",
        action: requestPermission,
        variant: "secondary" as const,
      };
    }
    if (notificationsEnabled) {
      return {
        icon: <BellRing className="h-6 w-6 text-primary" />,
        tooltip: "Browser notifications enabled. Click to disable.",
        action: toggleNotifications,
        variant: "secondary" as const, // Or "default" if you prefer a more prominent look
      };
    }
    // Permission granted, but notifications are manually disabled by user
    return {
      icon: <BellOff className="h-6 w-6 text-muted-foreground" />,
      tooltip: "Browser notifications disabled. Click to enable.",
      action: toggleNotifications,
      variant: "secondary" as const,
    };
  };

  const { icon, tooltip, action, variant } = getIconAndTooltip();

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant === "destructive_outline" ? "outline" : variant} // Map custom variant
            size="icon"
            className={cn(
              "fixed bottom-5 z-40 h-14 w-14 rounded-full shadow-lg",
              "border", // Ensure border is always present
              "cursor-pointer transition-all duration-150 ease-in-out",
              "hover:scale-105", // Simple hover effect
              // Position it next to the FileBrowser button (assuming FileBrowser is left-5)
              "left-[calc(theme(spacing.5)_+_theme(spacing.14)_+_theme(spacing.3))] sm:left-[calc(theme(spacing.5)_+_theme(spacing.14)_+_theme(spacing.4))]", // left-5 + width-of-fb-button + gap
              variant === "destructive_outline" && "border-destructive/50 hover:bg-destructive/10",
              permissionStatus === 'loading' && "opacity-50 cursor-wait" // Loading state
            )}
            onClick={action}
            aria-label={tooltip}
            disabled={permissionStatus === 'loading'}
          >
            {permissionStatus === 'loading' ? <AlertTriangle className="h-6 w-6 animate-pulse text-yellow-500" /> : icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
