// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React, { useEffect, useState } from 'react';
import { Bell, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'; // Corrected XCircle import
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

  useEffect(() => {
    setIsClient(true);
  }, []);

  const handleButtonClick = () => {
    openNotificationPanel();
  };

  const getAppearance = () => {
    let iconElement: React.ReactNode = <Bell className="h-6 w-6" />;
    let tooltipText = "Show Notifications";
    let buttonClasses = "bg-secondary hover:bg-secondary text-secondary-foreground"; // Default: solid hover
    let iconColorOverride = "text-secondary-foreground"; // Default icon color for secondary button

    if (!isClient) {
      // Default appearance before client-side hydration or if context is not ready
      return { iconElement, tooltipText, buttonClasses, iconColorOverride };
    }

    if (unreadNotificationCount > 0) {
      tooltipText = `${unreadNotificationCount} new notification(s). Click to view.`;
      buttonClasses = "bg-primary hover:bg-primary text-primary-foreground"; // Solid hover for primary
      iconElement = <Bell className="h-6 w-6" />; // Standard bell for unread
      iconColorOverride = "text-primary-foreground"; // Icon matches button text color
    } else {
      // No unread notifications: button is secondary, icon color defaults to secondary-foreground
      buttonClasses = "bg-secondary hover:bg-secondary text-secondary-foreground";
      iconColorOverride = "text-secondary-foreground"; // Explicitly set for clarity

      // Only show specific icons for critical/success/warning events when all are read.
      // For 'info' or null latestSignificantEventType, show the default Bell with secondary color.
      if (latestSignificantEventType === 'success') {
        iconElement = <CheckCircle2 className="h-6 w-6" />;
        tooltipText = "Latest (read): Succeeded";
        iconColorOverride = "text-green-500 dark:text-green-400"; // Specific color for success icon
      } else if (latestSignificantEventType === 'error') {
        iconElement = <XCircle className="h-6 w-6" />; // Corrected from XCircleIcon
        tooltipText = "Latest (read): Failed";
        iconColorOverride = "text-red-500 dark:text-red-400"; // Specific color for error icon
      } else if (latestSignificantEventType === 'warning') {
        iconElement = <AlertTriangle className="h-6 w-6" />;
        tooltipText = "Latest (read): Warning";
        iconColorOverride = "text-yellow-500 dark:text-yellow-400"; // Specific color for warning icon
      } else { 
        // This covers latestSignificantEventType === 'info' OR null (no significant event type to highlight)
        iconElement = <Bell className="h-6 w-6" />; // Default Bell icon
        tooltipText = latestSignificantEventType === 'info' ? "Latest (read): Info" : "No new notifications";
        // iconColorOverride remains "text-secondary-foreground" (plain bell for secondary button)
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
              "hover:scale-105",
              "left-[calc(1.25rem_+_3.5rem_+_0.75rem)] sm:left-[calc(1.25rem_+_3.5rem_+_1rem)]",
              "cursor-pointer",
              "inline-flex items-center justify-center", // For icon centering
              "relative", // For positioning the badge
              buttonClasses // Applies dynamic background and hover states
            )}
            onClick={handleButtonClick}
            aria-label={tooltipText}
          >
            {/* Clone icon to apply specific color override if needed */}
            {React.cloneElement(iconElement as React.ReactElement, {
              className: cn(
                (iconElement as React.ReactElement).props.className, // Keep original icon classes (like h-6 w-6)
                iconColorOverride // Apply dynamic color override
              )
            })}
            {/* Unread Count Badge */}
            {isClient && unreadNotificationCount > 0 && (
              <span
                className={cn(
                  "absolute -top-1 -right-1", 
                  "flex h-5 w-5 items-center justify-center rounded-full",
                  "bg-red-500 text-white text-xs font-bold",
                  "border-2 border-background" 
                )}
              >
                {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
