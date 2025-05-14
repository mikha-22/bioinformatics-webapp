// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React from 'react';
import { Bell, BellRing, BellOff, Loader2 } from 'lucide-react';
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
    if (permissionStatus === 'loading') {
        return {
            icon: <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />,
            tooltip: "Checking notification status...",
            action: () => {},
            variant: "secondary" as const,
            disabled: true,
        };
    }
    if (permissionStatus === 'denied') {
      return {
        icon: <BellOff className="h-5 w-5 text-destructive" />,
        tooltip: "Notifications blocked. Click for info.",
        action: toggleNotifications,
        variant: "destructive_outline" as const,
        disabled: false,
      };
    }
    if (permissionStatus === 'default') {
      return {
        icon: <Bell className="h-5 w-5 text-muted-foreground" />,
        tooltip: "Click to enable browser notifications",
        action: requestPermission,
        variant: "secondary" as const,
        disabled: false,
      };
    }
    if (notificationsEnabled) {
      return {
        icon: <BellRing className="h-5 w-5 text-green-600 dark:text-green-500" />,
        tooltip: "Browser notifications ON. Click to disable.",
        action: toggleNotifications,
        variant: "secondary" as const,
        disabled: false,
      };
    }
    return {
      icon: <BellOff className="h-5 w-5 text-muted-foreground" />,
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
              "fixed bottom-5 z-40 rounded-full shadow-lg",
              "h-12 w-12", // Smaller size
              "border",
              "transition-all duration-150 ease-in-out", // Keep transition for scale
              // Positioning
              "left-[calc(1.25rem_+_3.5rem_+_0.75rem)] sm:left-[calc(1.25rem_+_3.5rem_+_1rem)]",

              // <<< --- MODIFIED HOVER & DISABLED STYLING --- >>>
              disabled
                ? "cursor-not-allowed" // Only cursor change when disabled (loading)
                : "cursor-pointer hover:scale-105", // Apply hover scale only when not disabled

              variant === "destructive_outline" && "border-destructive/50 hover:bg-destructive/10 text-destructive hover:text-destructive"
              // No opacity class here
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
