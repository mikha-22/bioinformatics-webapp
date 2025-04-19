// File: frontend_app/components/ui/dropdown-menu.tsx
"use client"

import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

// --- MODIFIED DropdownMenuItem ---
function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  children, // Explicitly destructure children
  ...props // Keep rest of the props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "cursor-pointer data-[disabled]:cursor-not-allowed",
        className
      )}
      {...props} // Spread remaining props (like onSelect, disabled, etc.)
    >
      {/* Wrap children in a single element */}
      <span>{children}</span>
    </DropdownMenuPrimitive.Item>
  )
}
DropdownMenuItem.displayName = "DropdownMenuItem"
// --- END MODIFICATION ---

// --- Other components remain unchanged ---
function DropdownMenu({ /* ... */ }) { /* ... */ }
DropdownMenu.displayName = "DropdownMenu"
function DropdownMenuPortal({ /* ... */ }) { /* ... */ }
DropdownMenuPortal.displayName = "DropdownMenuPortal"
function DropdownMenuTrigger({ /* ... */ }) { /* ... */ }
DropdownMenuTrigger.displayName = "DropdownMenuTrigger"
function DropdownMenuContent({ /* ... */ }) { /* ... */ }
DropdownMenuContent.displayName = "DropdownMenuContent"
function DropdownMenuGroup({ /* ... */ }) { /* ... */ }
DropdownMenuGroup.displayName = "DropdownMenuGroup"
function DropdownMenuCheckboxItem({ /* ... */ }) { /* ... */ }
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem"
function DropdownMenuRadioGroup({ /* ... */ }) { /* ... */ }
DropdownMenuRadioGroup.displayName = "DropdownMenuRadioGroup"
function DropdownMenuRadioItem({ /* ... */ }) { /* ... */ }
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem"
function DropdownMenuLabel({ /* ... */ }) { /* ... */ }
DropdownMenuLabel.displayName = "DropdownMenuLabel"
function DropdownMenuSeparator({ /* ... */ }) { /* ... */ }
DropdownMenuSeparator.displayName = "DropdownMenuSeparator"
function DropdownMenuShortcut({ /* ... */ }) { /* ... */ }
DropdownMenuShortcut.displayName = "DropdownMenuShortcut"
function DropdownMenuSub({ /* ... */ }) { /* ... */ }
DropdownMenuSub.displayName = "DropdownMenuSub"
function DropdownMenuSubTrigger({ /* ... */ }) { /* ... */ }
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger"
function DropdownMenuSubContent({ /* ... */ }) { /* ... */ }
DropdownMenuSubContent.displayName = "DropdownMenuSubContent"

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem, // Export modified component
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
