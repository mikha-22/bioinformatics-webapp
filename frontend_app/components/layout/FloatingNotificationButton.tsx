// frontend_app/components/layout/FloatingNotificationButton.tsx
"use client";

import React, { useEffect, useState, useRef } from 'react';
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
    let buttonClasses = "bg-secondary hover:bg-secondary/80 text-secondary-foreground";
    let iconColorOverride = ""; 

    if (!isClient) {
      return { iconElement, tooltipText, buttonClasses, iconColorOverride };
    }

    if (unreadNotificationCount > 0) {
      tooltipText = `${unreadNotificationCount} new notification(s). Click to view.`;
      buttonClasses = "bg-primary hover:bg-primary/90 text-primary-foreground";
      iconElement = <Bell className="h-6 w-6" />;
    } else {
      buttonClasses = "bg-secondary hover:bg-secondary/80 text-secondary-foreground";
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
            iconElement = <Bell className="h-6 w-6" />;
            tooltipText += "Information/Job Started.";
            iconColorOverride = "text-blue-500 dark:text-blue-400";
            break;
          default:
            iconElement = <Bell className="h-6 w-6" />;
            tooltipText = "Notifications (all read)";
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
              "border border-border", // <<< ALWAYS APPLY DEFAULT BORDER
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
