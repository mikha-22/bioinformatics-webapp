// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React, { useEffect, useState } from 'react'; // Removed useRef as shakeIntervalRef is no longer needed
import { Bell, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useNotificationManager } from '@/components/providers/NotificationProvider';
import { cn } from '@/lib/utils';

export default function FloatingNotificationButton() {
  const {
    openNotificationPanel,
    unreadNotificationCount,
    latestSignificantEventType,
  } = useNotificationManager();

  const [isClient, setIsClient] = useState(false);
  // Removed isShaking and shakeIntervalRef as the shake animation is being removed

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Shaking useEffect has been removed.

  const handleButtonClick = () => {
    openNotificationPanel();
    // No need to clear shake interval or reset isShaking
  };

  const getAppearance = () => {
    let iconElement: React.ReactNode = <Bell className="h-6 w-6" />;
    let tooltipText = "Show Notifications";
    // --- MODIFIED hover classes to be fully opaque ---
    let buttonClasses = "bg-secondary hover:bg-secondary text-secondary-foreground"; // Default to solid hover
    let iconColorOverride = "";

    if (!isClient) {
      return { iconElement, tooltipText, buttonClasses, iconColorOverride };
    }

    if (unreadNotificationCount > 0) {
      tooltipText = `${unreadNotificationCount} new notification(s). Click to view.`;
      // --- MODIFIED hover class ---
      buttonClasses = "bg-primary hover:bg-primary text-primary-foreground"; // Solid hover for primary
      iconElement = <Bell className="h-6 w-6" />;
    } else {
      // --- MODIFIED hover class (already solid by default, ensuring it) ---
      buttonClasses = "bg-secondary hover:bg-secondary text-secondary-foreground";
      iconColorOverride = "text-secondary-foreground";

      if (latestSignificantEventType) {
        tooltipText = "Latest (read): ";
        switch (latestSignificantEventType) {
          case 'success':
            iconElement = <CheckCircle2 className="h-6 w-6" />;
            tooltipText += "Job Succeeded.";
            iconColorOverride = "text-green-500 dark:text-green-400";
            break;
          case 'error':
            iconElement = <XCircle className="h-6 w-6" />;
            tooltipText += "Job Failed.";
            iconColorOverride = "text-red-500 dark:text-red-400";
            break;
          case 'warning':
            iconElement = <AlertTriangle className="h-6 w-6" />;
            tooltipText += "Warning.";
            iconColorOverride = "text-yellow-500 dark:text-yellow-400";
            break;
          case 'info':
          default:
            iconElement = <Bell className="h-6 w-6" />;
            tooltipText += "Information/Job Started.";
            iconColorOverride = "text-blue-500 dark:text-blue-400";
            break;
        }
      } else {
        iconElement = <Bell className="h-6 w-6" />;
        tooltipText = "No new notifications";
      }
    }
    return { iconElement, tooltipText, buttonClasses, iconColorOverride };
  };

  const { iconElement, tooltipText, buttonClasses, iconColorOverride } = getAppearance();

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            className={cn(
              "fixed bottom-5 z-40 rounded-full shadow-lg",
              "h-12 w-12",
              "border border-border",
              "transition-all duration-150 ease-in-out",
              "hover:scale-105", // Keep scale on hover for feedback
              "left-[calc(1.25rem_+_3.5rem_+_0.75rem)] sm:left-[calc(1.25rem_+_3.5rem_+_1rem)]",
              "cursor-pointer",
              "inline-flex items-center justify-center",
              "relative", // Added for positioning the badge
              buttonClasses
              // Removed shake-active class
            )}
            onClick={handleButtonClick}
            aria-label={tooltipText}
          >
            {React.cloneElement(iconElement as React.ReactElement, {
              className: cn(
                (iconElement as React.ReactElement).props.className,
                iconColorOverride
              )
            })}
            {/* --- ADDED Unread Count Badge --- */}
            {isClient && unreadNotificationCount > 0 && (
              <span
                className={cn(
                  "absolute -top-1 -right-1", // Position at top-right corner, slightly offset
                  "flex h-5 w-5 items-center justify-center rounded-full",
                  "bg-red-500 text-white text-xs font-bold",
                  "border-2 border-background" // Creates a nice separation from the button
                )}
              >
                {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
              </span>
            )}
            {/* --- END Unread Count Badge --- */}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
