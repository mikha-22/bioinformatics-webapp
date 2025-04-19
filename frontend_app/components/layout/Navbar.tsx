// File: frontend_app/components/layout/Navbar.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Home" },
  { href: "/input", label: "Input" },
  { href: "/jobs", label: "Jobs" },
  { href: "/results", label: "Results" },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    // *** Ensure sticky styles are present ***
    <nav className="sticky top-0 z-50 bg-muted text-muted-foreground p-4 shadow-md border-b border-border">
      <div className="container mx-auto flex justify-start items-center gap-8">
        <Link href="/" className="text-xl font-bold text-foreground hover:text-primary transition-colors">
          BioPipeline UI
        </Link>
        <ul className="flex space-x-6 items-center">
          {navItems.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  "text-sm hover:text-primary transition-colors pb-1",
                  pathname === item.href
                    ? "border-b-2 border-primary font-semibold text-primary"
                    : "border-b-2 border-transparent text-muted-foreground"
                )}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ml-auto">
          {/* Placeholder */}
        </div>
      </div>
    </nav>
  );
}
