// File: frontend_app/components/layout/Footer.tsx
import { cn } from "@/lib/utils";

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    // Removed mt-auto, added mt-16 for spacing inside scrollable area
    <footer className={cn(
        "bg-muted text-muted-foreground text-center py-4 border-t border-border",
        "mt-16" // Space above footer within the scrollable div
    )}>
      <div className="container mx-auto">
        <p className="text-sm">
          © {currentYear} Bioinformatics Webapp. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
