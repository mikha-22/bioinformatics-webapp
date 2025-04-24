// File: frontend_app/components/forms/VcfSampleInputGroup.tsx
"use client";

import React from "react";
import { Trash2 } from "lucide-react";
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
import { Control } from "react-hook-form";

interface VcfSampleInputGroupProps {
  index: number;
  remove: (index: number) => void;
  control: Control<any>; // Use the passed control prop
}

export default function VcfSampleInputGroup({ index, remove, control }: VcfSampleInputGroupProps) {
  return (
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

      <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
        {/* Patient, Sample, Sex, Status are the same */}
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

        {/* VCF File Selector */}
        <div className="sm:col-span-2">
            <FormField control={control} name={`samples.${index}.vcf`} render={({ field }) => (
            <FormItem>
                <div className="flex justify-between items-center">
                <FormLabel className="cursor-default">Variant Calls File</FormLabel>
                <FormMessage className="text-xs" />
                </div>
                <FormControl>
                <FileSelector
                    fileTypeLabel="VCF"
                    fileType="vcf" // Generic type for filtering if needed
                    extensions={[".vcf", ".vcf.gz"]}
                    value={field.value || undefined}
                    onChange={field.onChange}
                    placeholder="Select VCF file..."
                    required
                />
                </FormControl>
            </FormItem>
            )} />
        </div>

         {/* Index File Selector (Optional but Recommended) */}
         <div className="sm:col-span-2">
            <FormField control={control} name={`samples.${index}.index`} render={({ field }) => (
            <FormItem>
                <div className="flex justify-between items-center">
                <FormLabel className="cursor-default">Index File <span className="text-muted-foreground text-xs">(Optional, Required for .vcf.gz)</span></FormLabel>
                <FormMessage className="text-xs" />
                </div>
                <FormControl>
                <FileSelector
                    fileTypeLabel="Index"
                    fileType="index" // Generic type for filtering if needed
                    extensions={[".tbi", ".csi"]} // Common VCF index extensions
                    value={field.value || undefined}
                    onChange={field.onChange}
                    placeholder="Select index file (.tbi/.csi)..."
                    allowNone
                />
                </FormControl>
                 <FormDescription className="text-xs italic">
                    Provide the corresponding index (.tbi for .vcf.gz).
                </FormDescription>
            </FormItem>
            )} />
        </div>

      </CardContent>
    </Card>
  );
}
