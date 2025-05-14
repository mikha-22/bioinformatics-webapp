// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React from 'react';
import { Bell, BellRing, BellOff, AlertTriangle, Loader2 } from 'lucide-react'; // Added Loader2
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
    return null;
  }

  const getIconAndTooltip = () => {
    if (permissionStatus === 'loading') { // Handle loading state first
        return {
            icon: <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />,
            tooltip: "Checking notification status...",
            action: () => {}, // No action while loading
            variant: "secondary" as const,
            disabled: true,
        };
    }
    if (permissionStatus === 'denied') {
      return {
        icon: <BellOff className="h-6 w-6 text-destructive" />,
        tooltip: "Notifications blocked. Click for info.", // Updated tooltip
        action: toggleNotifications,
        variant: "destructive_outline" as const,
        disabled: false,
      };
    }
    if (permissionStatus === 'default') {
      return {
        icon: <Bell className="h-6 w-6 text-muted-foreground" />,
        tooltip: "Click to enable browser notifications",
        action: requestPermission,
        variant: "secondary" as const,
        disabled: false,
      };
    }
    // Permission is 'granted' from here
    if (notificationsEnabled) {
      return {
        // Use BellRing with a prominent color for the enabled state
        icon: <BellRing className="h-6 w-6 text-green-600 dark:text-green-500" />, // <<< CHANGED: More prominent color
        tooltip: "Browser notifications ON. Click to disable.",
        action: toggleNotifications,
        variant: "secondary" as const, // Keep secondary, icon color will make it stand out
        // Or, if you want the button itself to change more:
        // variant: "default" as const, // This would make it use primary background
        disabled: false,
      };
    }
    // Permission granted, but notifications are manually disabled by user
    return {
      icon: <BellOff className="h-6 w-6 text-muted-foreground" />,
      tooltip: "Browser notifications OFF. Click to enable.",
      action: toggleNotifications,
      variant: "secondary" as const,
      disabled: false,
    };
  };

  const { icon, tooltip, action, variant, disabled } = getIconAndTooltip();

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant === "destructive_outline" ? "outline" : variant}
            size="icon"
            className={cn(
              "fixed bottom-5 z-40 h-14 w-14 rounded-full shadow-lg",
              "border",
              "cursor-pointer transition-all duration-150 ease-in-out",
              "hover:scale-105",
              "left-[calc(theme(spacing.5)_+_theme(spacing.14)_+_theme(spacing.3))] sm:left-[calc(theme(spacing.5)_+_theme(spacing.14)_+_theme(spacing.4))]",
              variant === "destructive_outline" && "border-destructive/50 hover:bg-destructive/10 text-destructive hover:text-destructive", // Ensure text color is also destructive
              disabled && "opacity-70 cursor-not-allowed hover:scale-100" // Style for disabled/loading
            )}
            onClick={action}
            aria-label={tooltip}
            disabled={disabled}
          >
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
