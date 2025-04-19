// File: frontend_app/components/common/ErrorDisplay.tsx
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

interface ErrorDisplayProps {
  error: Error | string | null | undefined;
  title?: string;
  className?: string;
}

export default function ErrorDisplay({
  error,
  title = "An Error Occurred",
  className,
}: ErrorDisplayProps) {
  if (!error) return null;

  const errorMessage = typeof error === "string" ? error : error.message;

  return (
    <Alert variant="destructive" className={cn(className)}>
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{errorMessage || "Unknown error"}</AlertDescription>
    </Alert>
  );
}
