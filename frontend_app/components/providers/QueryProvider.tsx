// File: frontend_app/components/providers/QueryProvider.tsx
"use client"; // This component uses useState, so it must be a Client Component

import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Optional: Import React Query DevTools for development
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

export default function QueryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Create the QueryClient instance *once* using useState
  // This prevents creating a new client on every render
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Default query options can go here, e.g.:
            staleTime: 1000 * 60 * 5, // Data is considered fresh for 5 minutes
            refetchOnWindowFocus: false, // Optional: disable refetching on window focus
            retry: 1, // Optional: retry failed queries once
          },
        },
      })
  );

  return (
    // Provide the client to the rest of your app
    <QueryClientProvider client={queryClient}>
      {children}
      {/* Optional: Add React Query DevTools for easy debugging in development */}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
