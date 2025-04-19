// File: frontend_app/app/layout.tsx
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import "./globals.css"; // Keep this import

// Layout Components
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import FileBrowserIntegration from "@/components/layout/FileBrowserIntegration";

// Providers and UI Elements
import QueryProvider from "@/components/providers/QueryProvider";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { cn } from "@/lib/utils"; // Import cn
import { FileBrowserProvider } from "@/components/layout/FileBrowserContext";

export const metadata: Metadata = {
  title: "Bioinformatics Pipeline UI",
  description: "Stage, run, and manage Sarek bioinformatics pipelines",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("h-full", GeistSans.variable)} suppressHydrationWarning>
       {/* Body is the main flex container taking full height */}
      <body className={cn(
          "bg-background text-foreground font-sans antialiased"
        )}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <FileBrowserProvider>
            <QueryProvider>
               {/* Navbar is sticky relative to the body */}
              <Navbar />
              {/* This div becomes the scrollable container */}
              <div className="flex flex-col flex-grow overflow-y-auto"> {/* Scrollable container */}
                {/* Main content area with padding and centering */}
                <main className="flex-grow container mx-auto px-4 py-8 relative"> {/* flex-grow pushes footer down */}
                  {children}
                </main>
                {/* Footer is inside scrollable area, but outside main's container/padding */}
                <Footer />
              </div>
              {/* These are outside the scrollable area */}
              <Toaster richColors position="top-right" />
              <FileBrowserIntegration />
            </QueryProvider>
          </FileBrowserProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
