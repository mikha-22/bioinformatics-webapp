// File: frontend_app/components/forms/ProfileLoader.tsx
"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { UseFormReturn } from "react-hook-form"; // Import UseFormReturn
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api"; // <<< Ensure this import is correct
import { ProfileData } from "@/lib/types"; // Assuming PipelineInput is the form type

// Define props including the form object and callbacks
interface ProfileLoaderProps {
  form: UseFormReturn<any>; // Use UseFormReturn for better type checking
  currentProfileName: string | null;
  onProfileLoad: (name: string | null, data: ProfileData | null) => void;
}

const profilesQueryKey = ["profilesList"];

export default function ProfileLoader({ form, currentProfileName, onProfileLoad }: ProfileLoaderProps) {
  const { data: profileNames, isLoading, isError, error } = useQuery<string[], Error>({
    queryKey: profilesQueryKey,
    queryFn: api.listProfileNames, // <<< --- ADD THIS LINE ---
    staleTime: 5 * 60 * 1000, // Cache for 5 mins
    refetchOnWindowFocus: false,
  });

  const handleProfileChange = async (selectedName: string) => {
    if (!selectedName || selectedName === "-- Default Settings --") {
      // Reset to default - how you handle this depends on desired behavior
      // Option 1: Reset the whole form (might clear samples too)
      // form.reset(); // Resets to defaultValues defined in useForm
      // Option 2: Reset only profile-related fields (safer for samples)
      // Manually reset fields known to be part of profiles to their defaults
      // form.resetField("genome"); form.resetField("tools"); ... etc.
      console.log("Clearing loaded profile (implement reset logic if needed)");
      onProfileLoad(null, null); // Signal that no profile is loaded
      return;
    }

    try {
      toast.loading(`Loading profile '${selectedName}'...`);
      const profileData = await api.getProfileData(selectedName);

      // Apply loaded data to the form using setValue for each field
      // This avoids resetting the 'samples' array
      Object.entries(profileData).forEach(([key, value]) => {
         if (value !== null && value !== undefined) { // Only set defined values
            // Type assertion needed as key is string
            form.setValue(key as any, value, {
                shouldValidate: true,
                shouldDirty: true // Mark as dirty initially, but will reset later if desired
            });
        } else {
            // Explicitly clear fields that are null/undefined in the profile
            // Use form defaults if available, otherwise clear to empty/false
            const defaultValue = form.formState.defaultValues?.[key as keyof typeof form.formState.defaultValues];
            form.setValue(key as any, defaultValue ?? (typeof defaultValue === 'boolean' ? false : ''), {
                 shouldValidate: true,
                 shouldDirty: true
            });
        }
      });

      // Reset dirty state *after* setting values if needed, to track user modifications *after* load
      // form.reset({}, { keepValues: true, keepDirty: false }); // Keeps values, marks as not dirty

      onProfileLoad(selectedName, profileData); // Pass name and data up
      toast.success(`Profile '${selectedName}' loaded.`);
    } catch (err) {
      console.error("Failed to load profile data:", err);
      toast.error(`Failed to load profile: ${err instanceof Error ? err.message : 'Unknown error'}`);
      onProfileLoad(null, null); // Reset profile state on error
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
            name="profile-select" // Add name for accessibility/testing
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
            {/* Add '(modified)' logic here if needed */}
            {/* {form.formState.isDirty && <Badge variant="outline">modified</Badge>} */}
         </div>
       )}
    </div>
  );
}
