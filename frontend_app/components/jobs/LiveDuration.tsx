// frontend_app/components/jobs/LiveDuration.tsx
"use client";

import React, { useState, useEffect } from 'react';
import { formatDuration } from '@/lib/utils'; // Your existing utility

interface LiveDurationProps {
  startedAt: number; // Unix timestamp (seconds)
  status: string; // To ensure we only run for active jobs
}

const LiveDuration: React.FC<LiveDurationProps> = ({ startedAt, status }) => {
  const [currentDurationSeconds, setCurrentDurationSeconds] = useState<number | null>(null);

  useEffect(() => {
    let intervalId: NodeJS.Timeout | undefined;

    // Determine if the job is actively running
    const isActive = status?.toLowerCase() === 'running' || status?.toLowerCase() === 'started';

    if (isActive && startedAt && startedAt > 0) {
      // Calculate initial duration immediately
      const initialDuration = Math.max(0, Math.floor(Date.now() / 1000) - startedAt);
      setCurrentDurationSeconds(initialDuration);

      // Set up the interval to update the duration
      intervalId = setInterval(() => {
        setCurrentDurationSeconds(Math.max(0, Math.floor(Date.now() / 1000) - startedAt));
      }, 1000); // Update every second
    } else {
      // If not active or startedAt is invalid, reset the duration
      setCurrentDurationSeconds(null);
    }

    // Cleanup function to clear the interval when the component unmounts
    // or when dependencies (startedAt, status) change.
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [startedAt, status]); // Rerun effect if startedAt or status changes

  // If duration hasn't been calculated yet (e.g., not active), show N/A
  if (currentDurationSeconds === null) {
    return <span className="italic text-muted-foreground">N/A</span>;
  }

  // Format and display the duration
  return <span>{formatDuration(currentDurationSeconds)}</span>;
};

export default LiveDuration;
