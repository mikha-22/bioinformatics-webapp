// File: frontend_app/components/layout/FileBrowserIntegration.tsx
"use client";

import React, { useState, useEffect } from "react";
// Import both icons
import { FolderClosed, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useFileBrowser } from "./FileBrowserContext";

export default function FileBrowserIntegration() {
  const [fileBrowserUrl, setFileBrowserUrl] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState<number>(0);
  const { isOpen, currentPath, closeFileBrowser, openFileBrowser } = useFileBrowser();

  useEffect(() => {
    // Fetch URL from env var only on the client-side
    const url = process.env.NEXT_PUBLIC_FILEBROWSER_URL;
    if (url) {
      // Basic validation/cleanup (remove trailing slash)
      setFileBrowserUrl(url.replace(/\/$/, ""));
    } else {
      console.warn("NEXT_PUBLIC_FILEBROWSER_URL is not set.");
    }
  }, []);

  const handleToggle = () => {
    // Increment key to force reload when opening
    setIframeKey(prev => prev + 1);
    
    if (isOpen) {
      closeFileBrowser();
    } else {
      // Open with root path when clicking the floating button
      openFileBrowser('/filebrowser/files');
    }
  };

  // Construct the iframe URL based on the current path
  const getIframeUrl = () => {
    if (!fileBrowserUrl) return null;
    
    // If we have a currentPath, it's already in the format /filebrowser/files/results/...
    // We just need to append it to the base URL
    if (currentPath) {
      // Remove any leading slash from currentPath to avoid double slashes
      const cleanPath = currentPath.startsWith('/') ? currentPath.slice(1) : currentPath;
      return `${fileBrowserUrl}/${cleanPath}`;
    }
    
    return fileBrowserUrl;
  };

  // Use Dialog component for overlay and content management
  return (
    <>
      {/* Floating Button */}
      <Button
        variant="secondary" // Keep the base variant for initial styling
        size="icon"
        className={cn(
            "fixed bottom-5 left-5 z-40 h-14 w-14 rounded-full shadow-lg",
            // Add group utility for targeting child icons on hover
            "group",
            // Ensure cursor is pointer unless disabled
            "cursor-pointer",
            // Add border and set its color using the theme variable
            "border border-border",
            // Override the default hover background change for secondary variant
            // Apply the non-hover secondary background color even on hover
            "hover:bg-secondary"
        )}
        onClick={handleToggle}
        aria-label="Toggle File Browser"
        disabled={!fileBrowserUrl} // Disable if URL is not set
      >
        {/* Default Icon: Visible normally, hidden on group hover */}
        <FolderClosed className={cn(
            "h-8 w-8", // Increased icon size
            "block group-hover:hidden transition-opacity duration-150" // Show by default, hide on hover
            )}
        />
        {/* Hover Icon: Hidden normally, visible on group hover */}
        <FolderOpen className={cn(
            "h-8 w-8", // Increased icon size
            "hidden group-hover:block transition-opacity duration-150" // Hide by default, show on hover
            )}
        />
      </Button>

      {/* Dialog for Modal */}
      <Dialog open={isOpen} onOpenChange={closeFileBrowser}>
        <DialogContent
          className={cn(
            "p-0 gap-0 sm:max-w-[90vw] h-[85vh] flex flex-col", // Adjust size as needed
            // Remove default padding and make flex column
          )}
          onInteractOutside={(e) => {
            // Prevent closing when clicking inside the iframe itself
            if ((e.target as HTMLElement)?.closest('iframe')) {
              e.preventDefault();
            }
          }}
        >
          <DialogHeader className="p-4 border-b">
            <DialogTitle>File Browser</DialogTitle>
             {/* DialogClose is automatically handled by Dialog component's X */}
          </DialogHeader>
          <div className="flex-grow overflow-hidden p-1"> {/* Container for iframe */}
            {fileBrowserUrl && (
              <iframe
                key={iframeKey} // Use key to force reload
                src={getIframeUrl() || fileBrowserUrl}
                title="File Browser"
                className="w-full h-full border-0"
                // sandbox="allow-scripts allow-same-origin allow-forms allow-popups" // Consider security implications
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
