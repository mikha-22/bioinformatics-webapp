// File: frontend_app/components/forms/SaveProfileDialog.tsx
"use client";

import React, { useState, useEffect } from "react";
import { Save, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SaveProfileDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (profileName: string) => Promise<void>; // Make onSave async
  isSaving: boolean;
  currentProfileName?: string | null; // Optional: Prefill name if editing
}

// Basic validation for profile names (alphanumeric, underscore, dash)
const VALID_PROFILE_NAME_REGEX = /^[a-zA-Z0-9_\-]+$/;
const MAX_PROFILE_NAME_LENGTH = 50;

export default function SaveProfileDialog({
  isOpen,
  onOpenChange,
  onSave,
  isSaving,
  currentProfileName
}: SaveProfileDialogProps) {
  const [profileName, setProfileName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Effect to prefill name if currentProfileName changes (e.g., after loading)
  useEffect(() => {
    if (isOpen && currentProfileName) {
        setProfileName(currentProfileName);
        setError(null); // Clear error when prefilling
    } else if (!isOpen) {
        setProfileName(""); // Reset name when dialog closes
         setError(null);
    }
  }, [isOpen, currentProfileName]);

  const handleSaveClick = async () => {
      setError(null); // Clear previous errors
      const trimmedName = profileName.trim();

      if (!trimmedName) {
          setError("Profile name cannot be empty.");
          return;
      }
      if (!VALID_PROFILE_NAME_REGEX.test(trimmedName)) {
          setError("Name can only contain letters, numbers, underscores (_), and dashes (-).");
          return;
      }
       if (trimmedName.length > MAX_PROFILE_NAME_LENGTH) {
           setError(`Name cannot exceed ${MAX_PROFILE_NAME_LENGTH} characters.`);
          return;
       }

      await onSave(trimmedName); // Call the async onSave prop
      // onOpenChange(false); // Keep dialog open until mutation finishes (handled in parent)
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setProfileName(e.target.value);
      if (error) {
          setError(null); // Clear error on typing
      }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Save Configuration Profile</DialogTitle>
          <DialogDescription>
            Save the current pipeline parameters (excluding samples) as a reusable profile.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="profile-name" className="text-right">
              Profile Name
            </Label>
            <Input
              id="profile-name"
              value={profileName}
              onChange={handleNameChange}
              className="col-span-3"
              placeholder="e.g., WES_Somatic_Standard"
              aria-invalid={!!error}
              aria-describedby="profile-name-error"
            />
          </div>
          {error && (
              <p id="profile-name-error" className="col-span-4 text-sm text-destructive text-center">{error}</p>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={isSaving}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={handleSaveClick} disabled={isSaving || !profileName.trim()}>
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save Profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
