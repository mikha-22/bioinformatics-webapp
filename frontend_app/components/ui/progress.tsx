// File: frontend_app/components/ui/progress.tsx
"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

// Define the props for our Progress component, extending Radix's props
// and adding our custom indicatorClassName.
interface ProgressProps extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  indicatorClassName?: string;
}

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps // Use our extended ProgressProps
>(({ className, value, indicatorClassName, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    // data-slot="progress" // You can keep or remove data-slot if not used by your specific styling
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-secondary dark:bg-muted", // Default track color
      // Or use your original: "bg-primary/20 relative h-2 w-full overflow-hidden rounded-full",
      className
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      // data-slot="progress-indicator" // Keep or remove data-slot
      className={cn(
        "h-full w-full flex-1 bg-primary transition-all", // Default indicator color and transition
        indicatorClassName // Apply the custom indicator class here
      )}
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
