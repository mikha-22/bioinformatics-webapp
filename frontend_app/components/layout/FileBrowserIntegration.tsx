// File: frontend_app/components/layout/FileBrowserIntegration.tsx
"use client";

import React, { useState, useEffect } from "react";
import { FolderClosed, FolderOpen } from "lucide-react"; // Keep both icons
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
    const url = process.env.NEXT_PUBLIC_FILEBROWSER_URL;
    if (url) {
      setFileBrowserUrl(url.replace(/\/$/, ""));
    } else {
      console.warn("NEXT_PUBLIC_FILEBROWSER_URL is not set.");
    }
  }, []);

  const handleToggle = () => {
    setIframeKey(prev => prev + 1);
    if (isOpen) {
      closeFileBrowser();
    } else {
      openFileBrowser('/filebrowser/files'); // Default path when opening via floating button
    }
  };

  const getIframeUrl = () => {
    if (!fileBrowserUrl) return null;
    if (currentPath) {
      const cleanPath = currentPath.startsWith('/') ? currentPath.slice(1) : currentPath;
      // Ensure the path starts with the filebrowser base URL if it's not already included
      // This logic assumes currentPath might be like '/results/run_xyz' or '/filebrowser/files/results/run_xyz'
      if (cleanPath.startsWith('filebrowser/files')) {
        return `${fileBrowserUrl}/${cleanPath}`;
      }
      // If currentPath is just a relative path like 'results/run_xyz', prepend the default filebrowser files path
      return `${fileBrowserUrl}/filebrowser/files/${cleanPath}`;
    }
    return `${fileBrowserUrl}/filebrowser/files`; // Default to root of files if no specific path
  };


  return (
    <>
      {/* Floating Button */}
      <Button
        variant="secondary"
        size="icon"
        className={cn(
            "fixed bottom-5 left-5 z-40 h-14 w-14 rounded-full shadow-lg",
            "group",
            "cursor-pointer",
            "border border-border",
            "hover:bg-secondary", // Keep original hover background
            // <<< --- ADDED HOVER ANIMATION --- >>>
            "transition-all duration-150 ease-in-out hover:scale-105"
            // <<< --- END ADDED HOVER ANIMATION --- >>>
        )}
        onClick={handleToggle}
        aria-label="Toggle File Browser"
        disabled={!fileBrowserUrl}
      >
        <FolderClosed className={cn(
            "h-8 w-8",
            "block group-hover:hidden transition-opacity duration-150"
            )}
        />
        <FolderOpen className={cn(
            "h-8 w-8",
            "hidden group-hover:block transition-opacity duration-150"
            )}
        />
      </Button>

      {/* Dialog for Modal */}
      <Dialog open={isOpen} onOpenChange={(open) => { if (!open) closeFileBrowser(); }}>
        <DialogContent
          className={cn(
            "p-0 gap-0 sm:max-w-[90vw] h-[85vh] flex flex-col",
          )}
          onInteractOutside={(e) => {
            if ((e.target as HTMLElement)?.closest('iframe')) {
              e.preventDefault();
            }
          }}
        >
          <DialogHeader className="p-4 border-b">
            <DialogTitle>File Browser</DialogTitle>
          </DialogHeader>
          <div className="flex-grow overflow-hidden p-1">
            {fileBrowserUrl && (
              <iframe
                key={iframeKey}
                src={getIframeUrl() || `${fileBrowserUrl}/filebrowser/files`} // Fallback src
                title="File Browser"
                className="w-full h-full border-0"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
