// File: frontend_app/components/ui/table.tsx
"use client"; // Assuming this was intended, keep if so. Remove if not a client component.

import * as React from "react"
import { cn } from "@/lib/utils"

// Main table component - CORRECTED
function Table({ className, children, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props} // Spread props here
      >{/* Ensure no space before children */}
        {children}
      {/* Ensure no space after children before closing tag */}</table>
    </div>
  )
}
Table.displayName = "Table"

// TableRow component - CORRECTED
function TableRow({ className, children, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors",
        className
      )}
      {...props} // Spread props here
    >{/* Ensure no space before children */}
      {children}
    {/* Ensure no space after children before closing tag */}</tr>
  );
}
TableRow.displayName = "TableRow"

// TableHeader component
function TableHeader({ className, children, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    >{children}</thead>
  )
}
TableHeader.displayName = "TableHeader"

// TableBody component
function TableBody({ className, children, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    >{children}</tbody>
  )
}
TableBody.displayName = "TableBody"

// TableFooter component
function TableFooter({ className, children, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-muted/50 border-t font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    >{children}</tfoot>
  )
}
TableFooter.displayName = "TableFooter"

// TableHead component
function TableHead({ className, children, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    >{children}</th>
  )
}
TableHead.displayName = "TableHead"

// TableCell component
function TableCell({ className, children, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-4 align-middle [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    >{children}</td>
  )
}
TableCell.displayName = "TableCell"

// TableCaption component
function TableCaption({
  className, children,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    >{children}</caption>
  )
}
TableCaption.displayName = "TableCaption"

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
