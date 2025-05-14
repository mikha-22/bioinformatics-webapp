// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React from 'react';
import { Bell, BellRing, BellOff, Loader2 } from 'lucide-react'; // Changed AlertTriangle to Loader2 for loading
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
            icon: <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />, // Icon size adjusted for smaller button
            tooltip: "Checking notification status...",
            action: () => {},
            variant: "secondary" as const,
            disabled: true,
        };
    }
    if (permissionStatus === 'denied') {
      return {
        icon: <BellOff className="h-5 w-5 text-destructive" />, // Icon size adjusted
        tooltip: "Notifications blocked. Click for info.",
        action: toggleNotifications,
        variant: "destructive_outline" as const,
        disabled: false,
      };
    }
    if (permissionStatus === 'default') {
      return {
        icon: <Bell className="h-5 w-5 text-muted-foreground" />, // Icon size adjusted
        tooltip: "Click to enable browser notifications",
        action: requestPermission,
        variant: "secondary" as const,
        disabled: false,
      };
    }
    if (notificationsEnabled) {
      return {
        icon: <BellRing className="h-5 w-5 text-green-600 dark:text-green-500" />, // Icon size adjusted
        tooltip: "Browser notifications ON. Click to disable.",
        action: toggleNotifications,
        variant: "secondary" as const,
        disabled: false,
      };
    }
    return {
      icon: <BellOff className="h-5 w-5 text-muted-foreground" />, // Icon size adjusted
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
              // <<< --- MODIFIED SIZE --- >>>
              "h-12 w-12", // Smaller than h-14 w-14
              "border",
              "cursor-pointer transition-all duration-150 ease-in-out",
              // Position it next to the FileBrowser button (assuming FileBrowser is left-5, w-14)
              // left-5 (1.25rem) + w-14 (3.5rem) + gap (e.g., 0.75rem for sm:1rem)
              "left-[calc(1.25rem_+_3.5rem_+_0.75rem)] sm:left-[calc(1.25rem_+_3.5rem_+_1rem)]",


              // <<< --- MODIFIED HOVER & DISABLED STYLING --- >>>
              disabled
                ? "opacity-70 cursor-not-allowed" // Apply opacity only when truly disabled (loading)
                : "hover:scale-105", // Apply hover scale only when not disabled

              variant === "destructive_outline" && "border-destructive/50 hover:bg-destructive/10 text-destructive hover:text-destructive"
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
