// frontend_app/components/forms/HelpTooltipIcon.tsx
"use client";

import React from 'react';
import { HelpCircle, Info } from 'lucide-react'; // Using HelpCircle, Info is an alternative
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { sarekParameterTooltips, TooltipContentData } from '@/lib/tooltipData'; // Import the data
import Link from 'next/link'; // For external links in tooltips

interface HelpTooltipIconProps {
  tooltipKey?: keyof typeof sarekParameterTooltips; // Key to lookup in sarekParameterTooltips
  tooltipContent?: string | TooltipContentData;    // Or provide content directly
  className?: string;
  iconSize?: number; // Optional size for the icon
  iconType?: "help" | "info"; // Optional to switch icon
}

export default function HelpTooltipIcon({
  tooltipKey,
  tooltipContent,
  className,
  iconSize = 4, // Default h-4 w-4
  iconType = "help",
}: HelpTooltipIconProps) {
  let contentToDisplay: string | TooltipContentData | undefined = tooltipContent;

  if (!contentToDisplay && tooltipKey) {
    contentToDisplay = sarekParameterTooltips[tooltipKey];
  }

  if (!contentToDisplay) {
    // console.warn(`HelpTooltipIcon: No tooltip content found for key "${tooltipKey}" or direct content provided.`);
    return null; // Don't render if no content
  }

  const IconComponent = iconType === "info" ? Info : HelpCircle;
  const iconClasses = `h-${iconSize} w-${iconSize} text-muted-foreground hover:text-foreground transition-colors`;

  const renderContent = (data: string | TooltipContentData) => {
    if (typeof data === 'string') {
      return <p className="text-xs max-w-xs break-words">{data}</p>;
    }
    return (
      <div className="text-xs max-w-xs break-words">
        {data.title && <p className="font-semibold mb-1">{data.title}</p>}
        <p>{data.message}</p>
        {data.link && (
          <Link
            href={data.link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-primary hover:underline text-xs"
            onClick={(e) => e.stopPropagation()} // Prevent tooltip from closing if link is inside
          >
            {data.linkText || "Learn more"}
          </Link>
        )}
      </div>
    );
  };

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild className={className}>
          <button
            type="button"
            className="ml-1.5 p-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            aria-label={typeof contentToDisplay === 'string' ? contentToDisplay : contentToDisplay.title || "More information"}
            onClick={(e) => e.preventDefault()} // Prevent form submission if inside a label
          >
            <IconComponent className={iconClasses} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" className="bg-popover text-popover-foreground shadow-md p-3">
          {renderContent(contentToDisplay)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
