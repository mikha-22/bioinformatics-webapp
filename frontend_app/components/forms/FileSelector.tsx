// frontend_app/components/forms/FileSelector.tsx
"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import * as api from "@/lib/api";
import { DataFile } from "@/lib/types";

interface FileSelectorProps {
  fileTypeLabel: string;
  fileType: string;
  extensions?: string[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  allowNone?: boolean;
  required?: boolean;
  disabled?: boolean;
}

export default function FileSelector({
  fileTypeLabel,
  fileType,
  extensions,
  value,
  onChange,
  placeholder = "Select a file...",
  allowNone = false,
  required = false,
  disabled = false,
}: FileSelectorProps) {

  const [open, setOpen] = useState(false);

  const { data: files, isLoading, isError } = useQuery<DataFile[], Error>({
    queryKey: ["dataFiles", fileType, extensions?.join(',')],
    queryFn: () => api.getDataFiles(fileType, extensions),
    enabled: !disabled,
    staleTime: 5 * 60 * 1000,
  });

  const handleSelect = (selectedValue: string) => {
    const newValue = selectedValue === value ? undefined : selectedValue === "##NONE##" ? undefined : selectedValue;
    onChange(newValue);
    setOpen(false);
  };

  const currentFile = files?.find((file) => file.name === value);
  const displayValue = currentFile?.name ?? (allowNone && !value ? "None" : (value || placeholder));


  if (isLoading) {
     return <Skeleton className="h-9 w-full" />;
  }

  if (isError) {
      return (
          <Button variant="outline" disabled className="w-full justify-start font-normal text-destructive">
              Error loading files for {fileTypeLabel}
          </Button>
      );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal cursor-pointer"
          disabled={disabled || isLoading}
        >
          <span className="truncate">{displayValue}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
         className="w-[var(--radix-popover-trigger-width)] p-0 z-50"
         align="start"
         sideOffset={5}
      >
        <Command className="w-full">
          <CommandInput placeholder={`Search ${fileTypeLabel}...`} className="w-full" />
           <CommandList className="w-full">
              <CommandEmpty>No files found.</CommandEmpty>
              <CommandGroup>
                {allowNone && (
                    <CommandItem
                        key="##NONE##"
                        value="##NONE##"
                        onSelect={() => handleSelect("##NONE##")}
                    >
                    <Check
                        className={cn(
                        "mr-2 h-4 w-4",
                        !value ? "opacity-100" : "opacity-0"
                        )}
                    />
                    None
                    </CommandItem>
                )}
                {files && files.map((file) => (
                  <CommandItem
                    key={file.name}
                    value={file.name}
                    onSelect={() => handleSelect(file.name)}
                    className="cursor-pointer"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === file.name ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {file.name}
                  </CommandItem>
                ))}
              </CommandGroup>
           </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
