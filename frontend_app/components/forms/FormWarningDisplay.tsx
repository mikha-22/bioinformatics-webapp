// frontend_app/components/forms/FormWarningDisplay.tsx
import React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FormWarningDisplayProps {
  message: string | null | undefined;
  className?: string;
  title?: string; // Optional title for the warning
}

export default function FormWarningDisplay({ message, className, title }: FormWarningDisplayProps) {
  if (!message) {
    return null;
  }

  return (
    <div
      className={cn(
        "p-3 rounded-md border bg-yellow-50 border-yellow-300 text-yellow-700 dark:bg-yellow-900/30 dark:border-yellow-700/50 dark:text-yellow-400",
        "shadow-sm", // Added a subtle shadow for better visibility
        className
      )}
      role="alert" // Add role for accessibility
    >
      <div className="flex items-start">
        <AlertCircle className="h-5 w-5 mr-2 flex-shrink-0 mt-0.5" />
        <div className="flex-grow">
          {title && <p className="font-semibold text-sm mb-0.5">{title}</p>}
          <p className="text-xs leading-relaxed">{message}</p>
        </div>
      </div>
    </div>
  );
}
