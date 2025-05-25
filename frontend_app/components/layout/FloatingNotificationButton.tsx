// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React, { useEffect, useState, useRef } from 'react';
import { Bell, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'; // Bell for default/info, AlertTriangle for warning/started
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
  const [isShaking, setIsShaking] = useState(false);
  const shakeIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (isClient && unreadNotificationCount > 0) {
      shakeIntervalRef.current = setInterval(() => {
        setIsShaking(true);
        setTimeout(() => setIsShaking(false), 500);
      }, 2000);
    } else {
      if (shakeIntervalRef.current) {
        clearInterval(shakeIntervalRef.current);
        shakeIntervalRef.current = null;
      }
      setIsShaking(false);
    }
    return () => {
      if (shakeIntervalRef.current) {
        clearInterval(shakeIntervalRef.current);
      }
    };
  }, [isClient, unreadNotificationCount]);

  const handleButtonClick = () => {
    openNotificationPanel();
    if (shakeIntervalRef.current) {
      clearInterval(shakeIntervalRef.current);
      shakeIntervalRef.current = null;
    }
    setIsShaking(false);
  };

  const getAppearance = () => {
    let iconElement: React.ReactNode = <Bell className="h-6 w-6" />;
    let tooltipText = "Show Notifications";
    // Default to secondary (neutral) background and its corresponding icon/text color
    let buttonClasses = "bg-secondary hover:bg-secondary/80 text-secondary-foreground";
    let iconColorOverride = ""; // By default, icon inherits color from buttonClasses

    if (!isClient) {
      return { iconElement, tooltipText, buttonClasses, iconColorOverride };
    }

    if (unreadNotificationCount > 0) {
      tooltipText = `${unreadNotificationCount} new notification(s). Click to view.`;
      buttonClasses = "bg-primary hover:bg-primary/90 text-primary-foreground"; // Primary color for unread
      iconElement = <Bell className="h-6 w-6" />; // Icon is Bell, color from buttonClasses
    } else {
      // No unread notifications: button background is always neutral (secondary).
      // Icon and tooltip can reflect the latest *read* event type.
      buttonClasses = "bg-secondary hover:bg-secondary/80 text-secondary-foreground";
      iconColorOverride = "text-secondary-foreground"; // Ensure icon matches neutral button text

      if (latestSignificantEventType) {
        tooltipText = "Latest (read): ";
        switch (latestSignificantEventType) {
          case 'success':
            iconElement = <CheckCircle2 className="h-6 w-6" />;
            tooltipText += "Job Succeeded.";
            iconColorOverride = "text-green-500 dark:text-green-400"; // Icon shows status
            break;
          case 'error':
            iconElement = <XCircle className="h-6 w-6" />;
            tooltipText += "Job Failed.";
            iconColorOverride = "text-red-500 dark:text-red-400"; // Icon shows status
            break;
          case 'warning':
            iconElement = <AlertTriangle className="h-6 w-6" />;
            tooltipText += "Warning.";
            iconColorOverride = "text-yellow-500 dark:text-yellow-400"; // Icon shows status
            break;
          case 'info':
            iconElement = <Bell className="h-6 w-6" />; // Or Info icon
            tooltipText += "Information/Job Started.";
            iconColorOverride = "text-blue-500 dark:text-blue-400"; // Icon shows status
            break;
          default:
            iconElement = <Bell className="h-6 w-6" />;
            tooltipText = "Notifications (all read)";
            break;
        }
      } else {
        // No unread, and no latest significant event (e.g., log cleared)
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
              "border",
              unreadNotificationCount > 0 ? "border-transparent" : "border-border", // Border only for default state
              "transition-all duration-150 ease-in-out",
              "hover:scale-105",
              "left-[calc(1.25rem_+_3.5rem_+_0.75rem)] sm:left-[calc(1.25rem_+_3.5rem_+_1rem)]",
              "cursor-pointer",
              "inline-flex items-center justify-center",
              buttonClasses, 
              isShaking && "shake-active"
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
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
