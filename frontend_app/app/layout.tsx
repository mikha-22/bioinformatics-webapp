// File: frontend_app/app/layout.tsx
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

// Layout Components
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import FileBrowserIntegration from "@/components/layout/FileBrowserIntegration";
import FloatingNotificationButton from "@/components/layout/FloatingNotificationButton"; // <<< --- ADDED IMPORT ---

// Providers and UI Elements
import QueryProvider from "@/components/providers/QueryProvider";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { FileBrowserProvider } from "@/components/layout/FileBrowserContext";
import { NotificationProvider } from "@/components/providers/NotificationProvider"; // <<< --- ADDED IMPORT ---
import { cn } from "@/lib/utils";

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
      <body className={cn(
          "bg-background text-foreground font-sans antialiased"
        )}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {/* --- WRAP with NotificationProvider --- */}
          <NotificationProvider>
            <FileBrowserProvider>
              <QueryProvider>
                <Navbar />
                <div className="flex flex-col flex-grow overflow-y-auto">
                  <main className="flex-grow container mx-auto px-4 py-8 relative">
                    {children}
                  </main>
                  <Footer />
                </div>
                <Toaster richColors position="top-right" />
                <FileBrowserIntegration />
                <FloatingNotificationButton /> {/* <<< --- ADDED FloatingNotificationButton --- */}
              </QueryProvider>
            </FileBrowserProvider>
          </NotificationProvider>
          {/* --- END WRAP --- */}
        </ThemeProvider>
      </body>
    </html>
  );
}
