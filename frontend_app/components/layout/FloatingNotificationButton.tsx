// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React, { useEffect, useState, useRef } from 'react';
import { Bell, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'; // Removed BellRing, MessageSquareWarning, Loader2 for now unless used as default
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
    let iconElement: React.ReactNode = <Bell className="h-6 w-6" />; // Default icon
    let tooltipText = "Show Notifications";
    let buttonBgClass = "bg-secondary hover:bg-secondary/80"; // Default: secondary variant
    let iconColorClass = "text-secondary-foreground"; // Default icon color based on secondary

    if (!isClient) { // Before hydration, render default state
      return { iconElement, tooltipText, buttonBgClass, iconColorClass };
    }

    if (unreadNotificationCount > 0) {
      tooltipText = `${unreadNotificationCount} new notification(s). Click to view.`;
      buttonBgClass = "bg-primary hover:bg-primary/90"; // Primary color for unread
      iconColorClass = "text-primary-foreground"; // Icon color for primary button
      // Icon remains Bell for unread, color change and shake indicate new items
    } else if (latestSignificantEventType) {
      tooltipText = "Latest: ";
      // Keep button background neutral (secondary), icon changes color and type
      buttonBgClass = "bg-secondary hover:bg-secondary/80";
      switch (latestSignificantEventType) {
        case 'success':
          iconElement = <CheckCircle2 className="h-6 w-6" />;
          tooltipText += "Job Succeeded. Click to view log.";
          iconColorClass = "text-green-500 dark:text-green-400";
          break;
        case 'error':
          iconElement = <XCircle className="h-6 w-6" />;
          tooltipText += "Job Failed. Click to view log.";
          iconColorClass = "text-red-500 dark:text-red-400";
          break;
        case 'warning':
          iconElement = <AlertTriangle className="h-6 w-6" />;
          tooltipText += "Job Update/Warning. Click to view log.";
          iconColorClass = "text-yellow-500 dark:text-yellow-400";
          break;
        case 'info':
          iconElement = <Bell className="h-6 w-6" />; // Or Info icon
          tooltipText += "Information. Click to view log.";
          iconColorClass = "text-blue-500 dark:text-blue-400";
          break;
        default:
          iconColorClass = "text-secondary-foreground"; // Fallback for neutral 'secondary'
          break;
      }
    }
    return { iconElement, tooltipText, buttonBgClass, iconColorClass };
  };

  const { iconElement, tooltipText, buttonBgClass, iconColorClass } = getAppearance();

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            // variant is not directly used here to allow custom bg/text colors
            size="icon"
            className={cn(
              "fixed bottom-5 z-40 rounded-full shadow-lg",
              "h-12 w-12",
              "border border-border", // Consistent border
              "transition-all duration-150 ease-in-out", // For hover effects
              "hover:scale-105", // Keep hover scale effect
              "left-[calc(1.25rem_+_3.5rem_+_0.75rem)] sm:left-[calc(1.25rem_+_3.5rem_+_1rem)]",
              "cursor-pointer",
              "inline-flex items-center justify-center", // Necessary for button layout
              buttonBgClass, // Apply dynamic background
              isShaking && "shake-active"
            )}
            onClick={handleButtonClick}
            aria-label={tooltipText}
          >
            {/* Apply dynamic iconColorClass to the icon */}
            {React.cloneElement(iconElement as React.ReactElement, {
              className: cn(
                (iconElement as React.ReactElement).props.className,
                iconColorClass
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
