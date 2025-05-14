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
            variant: "secondary" as const, // Keep as secondary for base style
            disabled: true,
            hoverClass: "", // No special hover when disabled
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
        hoverClass: "hover:bg-secondary/90 dark:hover:bg-secondary/70", // Subtle hover for secondary
      };
    }
    if (notificationsEnabled) { // Permission granted and notifications enabled
      return {
        icon: <BellRing className="h-5 w-5 text-green-600 dark:text-green-500" />,
        tooltip: "Browser notifications ON. Click to disable.",
        action: toggleNotifications,
        variant: "secondary" as const, // Base style
        disabled: false,
        // Explicitly define hover background to be same as non-hover or a very subtle change
        // This ensures no default opacity/darkening from the base button variant's hover
        hoverClass: "hover:bg-secondary/90 dark:hover:bg-secondary/70", // Or simply "hover:bg-secondary" if you want no change
      };
    }
    // Permission granted, but notifications are manually disabled by user
    return {
      icon: <BellOff className="h-5 w-5 text-muted-foreground" />,
      tooltip: "Browser notifications OFF. Click to enable.",
      action: toggleNotifications,
      variant: "secondary" as const,
      disabled: false,
      hoverClass: "hover:bg-secondary/90 dark:hover:bg-secondary/70", // Subtle hover for secondary
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
              "transition-all duration-150 ease-in-out",
              "left-[calc(1.25rem_+_3.5rem_+_0.75rem)] sm:left-[calc(1.25rem_+_3.5rem_+_1rem)]",

              disabled
                ? "cursor-not-allowed"
                : ["cursor-pointer hover:scale-105", hoverClass], // Apply hoverClass when not disabled

              variant === "destructive_outline" && "border-destructive/50 text-destructive hover:text-destructive"
              // No general hover:bg-X here, it's handled by hoverClass or variant's default
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
