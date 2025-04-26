// File: frontend_app/components/forms/ProfileLoader.tsx
"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { UseFormReturn } from "react-hook-form"; // Import UseFormReturn
import { Loader2 } from "lucide-react";
import { toast } from "sonner"; // Ensure toast is imported

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api";
import { ProfileData } from "@/lib/types";

// Define props including the form object and callbacks
interface ProfileLoaderProps {
  form: UseFormReturn<any>; // Use UseFormReturn for better type checking
  currentProfileName: string | null;
  onProfileLoad: (name: string | null, data: ProfileData | null) => void; // Callback now includes data
  // Add prop to inform loader about the current input type
  currentInputType: 'fastq' | 'bam_cram' | 'vcf';
}

const profilesQueryKey = ["profilesList"];

// Define valid steps for each input type
const VALID_STEPS_MAP = {
    fastq: ["mapping"],
    bam_cram: ["markduplicates", "prepare_recalibration", "recalibrate", "variant_calling"],
    vcf: ["annotation"],
};
// Helper type for SarekStep based on the map keys
type SarekStep = typeof VALID_STEPS_MAP[keyof typeof VALID_STEPS_MAP][number];


export default function ProfileLoader({ form, currentProfileName, onProfileLoad, currentInputType }: ProfileLoaderProps) {
  const { data: profileNames, isLoading, isError, error } = useQuery<string[], Error>({
    queryKey: profilesQueryKey,
    queryFn: api.listProfileNames,
    staleTime: 5 * 60 * 1000, // Cache for 5 mins
    refetchOnWindowFocus: false,
  });

  const handleProfileChange = async (selectedName: string) => {
    // --- Capture Toast ID ---
    let loadingToastId: string | number | undefined = undefined;
    // ------------------------

    if (!selectedName || selectedName === "-- Default Settings --") {
      // Reset to default - Trigger callback with null
      console.log("Resetting to default settings.");
      onProfileLoad(null, null); // Signal that no profile is loaded
      // Dismiss any lingering loading toast if reset is selected
      if (loadingToastId) {
           toast.dismiss(loadingToastId);
      }
      return;
    }

    try {
      // --- Start Loading Toast ---
      loadingToastId = toast.loading(`Loading profile '${selectedName}'...`);
      // ---------------------------

      const profileData = await api.getProfileData(selectedName); // profileData includes 'step'

      // Determine the input type implicitly associated with the loaded profile's step
      let profileInputType: 'fastq' | 'bam_cram' | 'vcf' | null = null;
      if (profileData.step === 'mapping') profileInputType = 'fastq';
      else if (VALID_STEPS_MAP.bam_cram.includes(profileData.step as SarekStep)) profileInputType = 'bam_cram';
      else if (profileData.step === 'annotation') profileInputType = 'vcf';

      if (!profileInputType) {
          throw new Error(`Profile '${selectedName}' has an invalid starting step ('${profileData.step}')`);
      }

      // Inform parent BEFORE setting values
      onProfileLoad(selectedName, profileData);

      // Short delay to allow parent component to re-render based on new input type
      await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay

      // Now apply loaded data to the form using setValue for each field
      Object.entries(profileData).forEach(([key, value]) => {
         const fieldShouldExist = shouldFieldBeVisible(key, profileInputType!, profileData.step as SarekStep);

         if (fieldShouldExist && value !== null && value !== undefined) {
            form.setValue(key as any, value, {
                shouldValidate: true,
                shouldDirty: true
            });
        } else if (fieldShouldExist) {
            const defaultValue = form.formState.defaultValues?.[key as keyof typeof form.formState.defaultValues];
             form.setValue(key as any, defaultValue ?? (typeof defaultValue === 'boolean' ? false : ''), {
                 shouldValidate: true,
                 shouldDirty: true
             });
        }
      });

      // --- Update Toast on Success ---
      toast.success(`Profile '${selectedName}' loaded.`, { id: loadingToastId });
      // -----------------------------

    } catch (err) {
      console.error("Failed to load profile data:", err);
      // --- Update Toast on Error ---
      toast.error(`Failed to load profile: ${err instanceof Error ? err.message : 'Unknown error'}`, { id: loadingToastId });
      // ---------------------------
      onProfileLoad(null, null); // Reset profile state on error
    }
  };

  // Helper function to determine field visibility based on type/step
  const shouldFieldBeVisible = (fieldName: string, inputType: string, step: SarekStep): boolean => {
      switch (fieldName) {
          case 'aligner':
          case 'trim_fastq':
              return inputType === 'fastq';
          case 'skip_baserecalibrator':
              return inputType !== 'vcf' && step !== 'variant_calling' && step !== 'annotation';
          case 'tools':
          case 'joint_germline':
              return inputType !== 'vcf' && step !== 'annotation';
          case 'skip_annotation':
               return inputType !== 'vcf' && step !== 'annotation';
          case 'genome':
          case 'profile':
          case 'step':
          case 'skip_qc':
          case 'wes':
          case 'intervals_file':
          case 'dbsnp':
          case 'known_indels':
          case 'pon':
          case 'description':
              return true;
          default:
              return true; // Assume visible unless explicitly hidden
      }
  };


  if (isError) {
    return <p className="text-sm text-destructive">Error loading profiles: {error.message}</p>;
  }

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
      <div className="flex-grow w-full sm:w-auto">
        <label htmlFor="profile-select" className="text-sm font-medium mb-1 block">Load Configuration Profile</label>
        {isLoading ? (
          <Skeleton className="h-10 w-full sm:w-64" />
        ) : (
          <Select
            value={currentProfileName ?? "-- Default Settings --"}
            onValueChange={handleProfileChange}
            disabled={isLoading}
            name="profile-select"
          >
            <SelectTrigger id="profile-select" className="w-full sm:w-64">
              <SelectValue placeholder="Select profile..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="-- Default Settings --">-- Default Settings --</SelectItem>
              {(profileNames ?? []).map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
       {currentProfileName && (
         <div className="mt-2 sm:mt-0 sm:ml-4 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Current:</span>
            <Badge variant="secondary">{currentProfileName}</Badge>
         </div>
       )}
    </div>
  );
}
