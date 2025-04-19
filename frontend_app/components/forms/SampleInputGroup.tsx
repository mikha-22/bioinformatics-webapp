// File: frontend_app/components/forms/SampleInputGroup.tsx
"use client";

import React from "react";
import { Trash2 } from "lucide-react";
// *** Make absolutely sure this import is present and correct ***
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import FileSelector from "@/components/forms/FileSelector";
import { FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from "@/components/ui/form";
import { cn } from "@/lib/utils";
import { Control } from "react-hook-form"; // Import Control type

interface SampleInputGroupProps {
  index: number;
  remove: (index: number) => void;
  control: Control<any>; // Use the passed control prop
}

export default function SampleInputGroup({ index, remove, control }: SampleInputGroupProps) {
  // No useFormContext needed here

  return (
    // The Card component causing the error
    <Card className={cn(
        "relative border border-border pt-8",
        "isolate",
        "bg-muted/10 dark:bg-muted/20"
        )}>
      <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 text-muted-foreground hover:text-destructive cursor-pointer"
          onClick={() => remove(index)}
          type="button"
      >
          <Trash2 className="h-4 w-4" />
          <span className="sr-only">Remove Sample</span>
      </Button>

      {/* Use CardContent */}
      <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
        {/* Add cursor-default to these non-interactive labels */}
        <FormField control={control} name={`samples.${index}.patient`} render={({ field }) => ( 
          <FormItem>
            <div className="flex justify-between items-center">
              <FormLabel className="cursor-default">Patient ID</FormLabel>
              <FormMessage className="text-xs" />
            </div>
            <FormControl>
              <Input placeholder="e.g., Patient_A" {...field} />
            </FormControl>
          </FormItem>
        )} />
        <FormField control={control} name={`samples.${index}.sample`} render={({ field }) => ( 
          <FormItem>
            <div className="flex justify-between items-center">
              <FormLabel className="cursor-default">Sample ID</FormLabel>
              <FormMessage className="text-xs" />
            </div>
            <FormControl>
              <Input placeholder="e.g., Sample_A_T" {...field} />
            </FormControl>
          </FormItem>
        )} />
        <FormField control={control} name={`samples.${index}.sex`} render={({ field }) => ( 
          <FormItem>
            <div className="flex justify-between items-center">
              <FormLabel className="cursor-default">Sex</FormLabel>
              <FormMessage className="text-xs" />
            </div>
            <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select sex" />
                </SelectTrigger>
              </FormControl>
              <SelectContent position="popper" sideOffset={5}>
                <SelectItem value="XX">XX</SelectItem>
                <SelectItem value="XY">XY</SelectItem>
                <SelectItem value="X">X</SelectItem>
                <SelectItem value="Y">Y</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </FormItem>
        )} />
        <FormField control={control} name={`samples.${index}.status`} render={({ field }) => ( 
          <FormItem>
            <div className="flex justify-between items-center">
              <FormLabel className="cursor-default">Status</FormLabel>
              <FormMessage className="text-xs" />
            </div>
            <Select onValueChange={(val) => field.onChange(parseInt(val, 10))} defaultValue={String(field.value ?? '')} value={String(field.value ?? '')}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
              </FormControl>
              <SelectContent position="popper" sideOffset={5}>
                <SelectItem value="0">Normal (0)</SelectItem>
                <SelectItem value="1">Tumor (1)</SelectItem>
              </SelectContent>
            </Select>
          </FormItem>
        )} />
        <div className="sm:col-span-1">
          <FormField control={control} name={`samples.${index}.lane`} render={({ field }) => ( 
            <FormItem>
              <div className="flex justify-between items-center">
                <FormLabel className="cursor-default">Lane</FormLabel>
                <FormMessage className="text-xs" />
              </div>
              <FormControl>
                <Input 
                  placeholder="e.g., L001" 
                  {...field} 
                  value={field.value || ''}
                  onChange={(e) => {
                    // Convert to uppercase and remove spaces
                    const value = e.target.value.toUpperCase().replace(/\s+/g, '');
                    field.onChange(value);
                  }}
                />
              </FormControl>
              <FormDescription className="text-xs italic">
                Lane identifier (e.g., L001, L002)
              </FormDescription>
            </FormItem>
          )} />
        </div>
        <div className="sm:col-span-2 grid grid-cols-2 gap-4">
          <FormField control={control} name={`samples.${index}.fastq_1`} render={({ field }) => ( 
            <FormItem>
              <div className="flex justify-between items-center">
                <FormLabel className="cursor-default">FASTQ Read 1</FormLabel>
                <FormMessage className="text-xs" />
              </div>
              <FormControl>
                <FileSelector 
                  fileTypeLabel="FASTQ R1" 
                  fileType="fastq" 
                  extensions={[".fastq.gz", ".fq.gz", ".fastq", ".fq"]} 
                  value={field.value} 
                  onChange={field.onChange} 
                  placeholder="Select R1 FASTQ..." 
                  required 
                />
              </FormControl>
            </FormItem>
          )} />
          <FormField control={control} name={`samples.${index}.fastq_2`} render={({ field }) => ( 
            <FormItem>
              <div className="flex justify-between items-center">
                <FormLabel className="cursor-default">FASTQ Read 2</FormLabel>
                <FormMessage className="text-xs" />
              </div>
              <FormControl>
                <FileSelector 
                  fileTypeLabel="FASTQ R2" 
                  fileType="fastq" 
                  extensions={[".fastq.gz", ".fq.gz", ".fastq", ".fq"]} 
                  value={field.value} 
                  onChange={field.onChange} 
                  placeholder="Select R2 FASTQ..." 
                  required 
                />
              </FormControl>
            </FormItem>
          )} />
        </div>
      </CardContent>
    </Card>
  );
}
