// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React from 'react';
import { Bell, BellRing, Loader2, AlertTriangle, CheckCircle2, XCircle, MessageSquareWarning } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useNotificationManager } from '@/components/providers/NotificationProvider';
import { cn } from '@/lib/utils';

export default function FloatingNotificationButton() {
  const {
    openNotificationPanel,
    unreadNotificationCount,
    latestSignificantEventType,
    // isSupported, // Not directly used for button's primary action anymore
    // permissionStatus // Also less relevant for the primary action
  } = useNotificationManager();

  const handleButtonClick = () => {
    openNotificationPanel();
  };

  const getAppearance = () => {
    let icon: React.ReactNode = <Bell className="h-5 w-5" />;
    let tooltipText = "Show Notifications";
    let buttonVariant: "secondary" | "default" | "destructive" | "outline" = "secondary";
    let pulse = false;
    let iconColorClass = "text-foreground"; // Default icon color

    if (unreadNotificationCount > 0) {
      icon = <MessageSquareWarning className="h-5 w-5" />; // Icon indicating unread messages
      tooltipText = `${unreadNotificationCount} new notification(s). Click to view.`;
      buttonVariant = "default"; // Make it more prominent like the primary button
      iconColorClass = "text-primary-foreground"; // If buttonVariant 'default' has dark bg
      pulse = true; // Add pulse for unread
    } else if (latestSignificantEventType) {
      switch (latestSignificantEventType) {
        case 'success':
          icon = <CheckCircle2 className="h-5 w-5" />;
          tooltipText = "Latest: Job Succeeded. Click to view log.";
          iconColorClass = "text-green-500 dark:text-green-400";
          break;
        case 'error':
          icon = <XCircle className="h-5 w-5" />;
          tooltipText = "Latest: Job Failed. Click to view log.";
          iconColorClass = "text-red-500 dark:text-red-400";
          break;
        case 'warning': // For "job_started" or other warnings
          icon = <AlertTriangle className="h-5 w-5" />;
          tooltipText = "Latest: Job Update/Warning. Click to view log.";
          iconColorClass = "text-yellow-500 dark:text-yellow-400";
          break;
        case 'info': // Could be used for less critical "job_started" if preferred
          icon = <BellRing className="h-5 w-5" />;
          tooltipText = "Latest: Information. Click to view log.";
          iconColorClass = "text-blue-500 dark:text-blue-400";
          break;
        default:
          icon = <Bell className="h-5 w-5" />;
          tooltipText = "Show Notifications";
          iconColorClass = "text-foreground";
      }
    }

    return { icon, tooltipText, buttonVariant, pulse, iconColorClass };
  };

  const { icon, tooltipText, buttonVariant, pulse, iconColorClass } = getAppearance();

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={buttonVariant}
            size="icon"
            className={cn(
              "fixed bottom-5 z-40 rounded-full shadow-lg",
              "h-12 w-12",
              "border border-border",
              "transition-all duration-150 ease-in-out", // Combined transitions
              "opacity-100 hover:opacity-100",
              "hover:scale-105",
              "left-[calc(1.25rem_+_3.5rem_+_0.75rem)] sm:left-[calc(1.25rem_+_3.5rem_+_1rem)]",
              "cursor-pointer",
              pulse && "animate-pulse", // Apply pulse animation if needed
              // Specific overrides for button variants if default hover isn't desired
              buttonVariant === "default" && "bg-primary text-primary-foreground hover:bg-primary/90",
              buttonVariant === "destructive" && "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              // Ensure icon color is applied correctly within the button
              iconColorClass
            )}
            onClick={handleButtonClick}
            aria-label={tooltipText}
          >
            {React.cloneElement(icon as React.ReactElement, { className: cn((icon as React.ReactElement).props.className, iconColorClass) })}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
