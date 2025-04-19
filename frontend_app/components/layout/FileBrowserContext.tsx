"use client";

import React, { createContext, useContext, useState } from 'react';

interface FileBrowserContextType {
  isOpen: boolean;
  currentPath: string | null;
  openFileBrowser: (path: string) => void;
  closeFileBrowser: () => void;
}

const FileBrowserContext = createContext<FileBrowserContextType | undefined>(undefined);

export function FileBrowserProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);

  const openFileBrowser = (path: string) => {
    setCurrentPath(path);
    setIsOpen(true);
  };

  const closeFileBrowser = () => {
    setIsOpen(false);
    setCurrentPath(null);
  };

  return (
    <FileBrowserContext.Provider value={{ isOpen, currentPath, openFileBrowser, closeFileBrowser }}>
      {children}
    </FileBrowserContext.Provider>
  );
}

export function useFileBrowser() {
  const context = useContext(FileBrowserContext);
  if (context === undefined) {
    throw new Error('useFileBrowser must be used within a FileBrowserProvider');
  }
  return context;
} 