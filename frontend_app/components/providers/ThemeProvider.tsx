// File: frontend_app/components/providers/ThemeProvider.tsx
"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"
// Import type directly from the package root
import { type ThemeProviderProps } from "next-themes" // <-- CHANGED IMPORT PATH

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}

