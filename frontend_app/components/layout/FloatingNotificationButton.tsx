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
            hoverClass: "", // No hover effect when disabled
        };
    }
    if (permissionStatus === 'denied') {
      return {
        icon: <BellOff className="h-5 w-5 text-destructive" />,
        tooltip: "Notifications blocked. Click for info.",
        action: toggleNotifications,
        variant: "destructive_outline" as const,
        disabled: false,
        hoverClass: "hover:bg-destructive/10", // Specific hover for this state
      };
    }
    if (permissionStatus === 'default') {
      return {
        icon: <Bell className="h-5 w-5 text-muted-foreground" />,
        tooltip: "Click to enable browser notifications",
        action: requestPermission,
        variant: "secondary" as const,
        disabled: false,
        hoverClass: "hover:bg-secondary", // Explicitly set hover to be same as base secondary
      };
    }
    if (notificationsEnabled) { // Permission granted and notifications enabled
      return {
        icon: <BellRing className="h-5 w-5 text-green-600 dark:text-green-500" />,
        tooltip: "Browser notifications ON. Click to disable.",
        action: toggleNotifications,
        variant: "secondary" as const,
        disabled: false,
        hoverClass: "hover:bg-secondary", // Explicitly set hover to be same as base secondary
      };
    }
    // Permission granted, but notifications are manually disabled by user
    return {
      icon: <BellOff className="h-5 w-5 text-muted-foreground" />,
      tooltip: "Browser notifications OFF. Click to enable.",
      action: toggleNotifications,
      variant: "secondary" as const,
      disabled: false,
      hoverClass: "hover:bg-secondary", // Explicitly set hover to be same as base secondary
    };
  };

  const { icon, tooltip, action, variant, disabled, hoverClass } = getIconAndTooltip();

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant === "destructive_outline" ? "outline" : variant}
            size="icon"
            className={cn(
              "fixed bottom-5 z-40 rounded-full shadow-lg",
              "h-12 w-12",
              "border",
              // <<< --- MODIFIED TRANSITION & OPACITY --- >>>
              "transition-transform duration-150 ease-in-out", // Only transition transform (scale)
              "opacity-100 hover:opacity-100", // Force opacity to 100 always
              // Positioning
              "left-[calc(1.25rem_+_3.5rem_+_0.75rem)] sm:left-[calc(1.25rem_+_3.5rem_+_1rem)]",

              disabled
                ? "cursor-not-allowed"
                : ["cursor-pointer hover:scale-105", hoverClass],

              variant === "destructive_outline" && "border-destructive/50 text-destructive" // Removed hover:bg-destructive/10 from here, hoverClass will handle if needed
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
