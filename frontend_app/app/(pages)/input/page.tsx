// File: frontend_app/app/(pages)/input/page.tsx
"use client";

import React, { useState, useMemo, useEffect } from "react";
import { useForm, useFieldArray, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z, ZodType } from "zod"; // Ensure Zod is imported
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { PlusCircle, Loader2, Play, Save } from "lucide-react";
import { toast } from "sonner";

// ... (Keep other imports: Button, Card, Form components, etc.) ...
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import SampleInputGroup from "@/components/forms/SampleInputGroup";
import BamCramSampleInputGroup from "@/components/forms/BamCramSampleInputGroup";
import VcfSampleInputGroup from "@/components/forms/VcfSampleInputGroup";
import FileSelector from "@/components/forms/FileSelector";
import ProfileLoader from "@/components/forms/ProfileLoader";
import SaveProfileDialog from "@/components/forms/SaveProfileDialog";
import * as api from "@/lib/api";
import { PipelineInput, SampleInfo as ApiSampleInfo, ProfileData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Control } from "react-hook-form";


// --- Define Zod Schema for Validation ---

const noSpacesRegex = /^[^\s]+$/;
const laneRegex = /^L\d{3}$/;

// Define base sample schema parts used across types
const baseSample = {
    patient: z.string().min(1, "Patient ID is required").regex(noSpacesRegex, "Patient ID cannot contain spaces"),
    sample: z.string().min(1, "Sample ID is required").regex(noSpacesRegex, "Sample ID cannot contain spaces"),
    sex: z.enum(["XX", "XY", "X", "Y", "other"], { required_error: "Sex is required" }),
    status: z.union([z.literal(0), z.literal(1)], { required_error: "Status is required" }),
};

// Schema for FASTQ samples
const fastqSampleSchema = z.object({
    ...baseSample,
    lane: z.string().min(1, "Lane is required").regex(laneRegex, "Lane must be in format L001"),
    fastq_1: z.string().min(1, "FASTQ R1 is required"),
    fastq_2: z.string().min(1, "FASTQ R2 is required"),
    bam_cram: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    vcf: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    index: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
});

// Schema for BAM/CRAM samples
const bamCramSampleSchema = z.object({
     ...baseSample,
    bam_cram: z.string().min(1, "BAM/CRAM file is required").refine(f => f.endsWith('.bam') || f.endsWith('.cram'), "Must be a .bam or .cram file"),
    index: z.string().optional().nullable(),
    lane: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    fastq_1: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    fastq_2: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    vcf: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
}).refine(data => !(data.bam_cram?.endsWith('.cram') && !data.index), {
    message: "An index file (.crai) must be provided for CRAM input.", path: ["index"],
});

// Schema for VCF samples
const vcfSampleSchema = z.object({
     ...baseSample,
    vcf: z.string().min(1, "VCF file is required").refine(f => f.endsWith('.vcf') || f.endsWith('.vcf.gz'), "Must be a .vcf or .vcf.gz file"),
    index: z.string().optional().nullable(),
    lane: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    fastq_1: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    fastq_2: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    bam_cram: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
}).refine(data => !(data.vcf?.endsWith('.vcf.gz') && !data.index), {
    message: "An index file (.tbi) must be provided for compressed VCF (.vcf.gz) input.", path: ["index"],
});

// Define constants
const ALL_SAREK_STEPS = ["mapping", "markduplicates", "prepare_recalibration", "recalibrate", "variant_calling", "annotation"] as const;
type SarekStep = typeof ALL_SAREK_STEPS[number];
const SAREK_TOOLS = ["strelka", "mutect2", "freebayes", "mpileup", "vardict", "manta", "cnvkit"];
const SAREK_PROFILES = ["docker", "singularity", "conda", "podman"];
const SAREK_GENOMES = [ { value: "GATK.GRCh38", label: "GRCh38 (GATK Bundle)" }, { value: "GATK.GRCh37", label: "GRCh37 (GATK Bundle)" }, { value: "hg38", label: "hg38 (UCSC)" }, { value: "hg19", label: "hg19 (UCSC)" }, ];
const VALID_GENOME_VALUES = SAREK_GENOMES.map(g => g.value) as [string, ...string[]];
const SAREK_ALIGNERS = ["bwa-mem", "dragmap"];
const SOMATIC_TOOLS = ["mutect2", "strelka"];
const STEPS_FOR_INPUT_TYPE: Record<'fastq' | 'bam_cram' | 'vcf', SarekStep[]> = { fastq: ["mapping"], bam_cram: ["markduplicates", "prepare_recalibration", "recalibrate", "variant_calling"], vcf: ["annotation"], };

// *** REVISED SCHEMA STRUCTURE - Independent Schemas, Refine AFTER Union ***

// Define independent schemas WITHOUT refinements first
const fastqPipelineSchemaBase = z.object({
    input_type: z.literal('fastq'),
    samples: z.array(fastqSampleSchema).min(1, "At least one sample is required for FASTQ input."),
    genome: z.enum(VALID_GENOME_VALUES, { required_error: "Genome build is required" }),
    step: z.literal('mapping'),
    intervals_file: z.string().optional().refine((val) => !val || val === "" || val.endsWith('.bed') || val.endsWith('.list') || val.endsWith('.interval_list'), { message: "Intervals file must end with .bed, .list, or .interval_list" }),
    dbsnp: z.string().optional(),
    known_indels: z.string().optional(),
    pon: z.string().optional(),
    tools: z.array(z.string()).default([]),
    profile: z.enum(SAREK_PROFILES as [string, ...string[]]).default("docker"),
    aligner: z.enum(SAREK_ALIGNERS as [string, ...string[]]).optional().default("bwa-mem"),
    joint_germline: z.boolean().default(false),
    wes: z.boolean().default(false),
    trim_fastq: z.boolean().default(false),
    skip_qc: z.boolean().default(false),
    skip_annotation: z.boolean().default(false),
    skip_baserecalibrator: z.boolean().default(false),
    description: z.string().optional(),
});

const bamCramPipelineSchemaBase = z.object({
    input_type: z.literal('bam_cram'),
    samples: z.array(bamCramSampleSchema).min(1, "At least one sample is required for BAM/CRAM input."),
    genome: z.enum(VALID_GENOME_VALUES, { required_error: "Genome build is required" }),
    step: z.enum(["markduplicates", "prepare_recalibration", "recalibrate", "variant_calling"]),
    intervals_file: z.string().optional().refine((val) => !val || val === "" || val.endsWith('.bed') || val.endsWith('.list') || val.endsWith('.interval_list'), { message: "Intervals file must end with .bed, .list, or .interval_list" }),
    dbsnp: z.string().optional(),
    known_indels: z.string().optional(),
    pon: z.string().optional(),
    tools: z.array(z.string()).default([]),
    profile: z.enum(SAREK_PROFILES as [string, ...string[]]).default("docker"),
    aligner: z.union([z.string().length(0), z.null(), z.undefined()]).optional(), // Should be empty/null/undefined
    joint_germline: z.boolean().default(false),
    wes: z.boolean().default(false),
    trim_fastq: z.boolean().default(false), // Allow base schema default, refine later
    skip_qc: z.boolean().default(false),
    skip_annotation: z.boolean().default(false),
    skip_baserecalibrator: z.boolean().default(false),
    description: z.string().optional(),
});

const vcfPipelineSchemaBase = z.object({
    input_type: z.literal('vcf'),
    samples: z.array(vcfSampleSchema).min(1, "At least one sample is required for VCF input."),
    genome: z.enum(VALID_GENOME_VALUES, { required_error: "Genome build is required" }),
    step: z.literal('annotation'),
    intervals_file: z.string().optional().refine((val) => !val || val === "" || val.endsWith('.bed') || val.endsWith('.list') || val.endsWith('.interval_list'), { message: "Intervals file must end with .bed, .list, or .interval_list" }),
    dbsnp: z.string().optional(),
    known_indels: z.string().optional(),
    pon: z.string().optional(),
    tools: z.array(z.string()).default([]), // Allow base schema default, refine later
    profile: z.enum(SAREK_PROFILES as [string, ...string[]]).default("docker"),
    aligner: z.union([z.string().length(0), z.null(), z.undefined()]).optional(), // Should be empty/null/undefined
    joint_germline: z.boolean().default(false), // Allow base schema default, refine later
    wes: z.boolean().default(false),
    trim_fastq: z.boolean().default(false), // Allow base schema default, refine later
    skip_qc: z.boolean().default(false),
    skip_annotation: z.boolean().default(false), // Allow base schema default, refine later
    skip_baserecalibrator: z.boolean().default(false), // Allow base schema default, refine later
    description: z.string().optional(),
});


// Discriminated union using the base schemas
const pipelineInputSchema = z.discriminatedUnion("input_type", [
    fastqPipelineSchemaBase,
    bamCramPipelineSchemaBase,
    vcfPipelineSchemaBase,
])
.superRefine((data, ctx) => {
    // Apply ALL refinements here based on the resolved data.input_type and data.step

    // --- FASTQ Refinements ---
    if (data.input_type === 'fastq') {
        if (data.aligner && !SAREK_ALIGNERS.includes(data.aligner)) {
             ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid aligner selected.", path: ["aligner"] });
        }
        // Step is already literal('mapping'), no need to check skip_annotation/tools vs step here
    }

    // --- BAM/CRAM Refinements ---
    if (data.input_type === 'bam_cram') {
        if (data.trim_fastq) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Trim FASTQ' not applicable for BAM/CRAM input", path: ["trim_fastq"] });
        }
        if (data.aligner && data.aligner.length > 0) {
             ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Aligner not applicable for BAM/CRAM input", path: ["aligner"] });
        }
        if (data.skip_baserecalibrator && (data.step === 'variant_calling' || data.step === 'annotation')) { // Step annotation check is technically redundant due to step enum, but safe
             ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Base Recalibration' not applicable when starting at or after variant calling.", path: ["skip_baserecalibrator"] });
        }
         if (data.skip_annotation && data.step === 'annotation') { // Step annotation check is technically redundant
             ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Annotation' cannot be used when step is 'annotation'.", path: ["skip_annotation"] });
         }
         if (data.tools.length > 0 && data.step === 'annotation') { // Step annotation check is technically redundant
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Variant calling tools cannot be specified when starting at annotation.", path: ["tools"] });
         }
    }

    // --- VCF Refinements ---
     if (data.input_type === 'vcf') {
         if (data.trim_fastq) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Trim FASTQ' not applicable for VCF input", path: ["trim_fastq"] }); }
         if (data.aligner && data.aligner.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Aligner not applicable for VCF input", path: ["aligner"] }); }
         if (data.skip_baserecalibrator) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Base Recalibration' not applicable for VCF input", path: ["skip_baserecalibrator"] }); }
         if (data.tools.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Variant calling tools not applicable for VCF input", path: ["tools"] }); }
         if (data.skip_annotation) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Annotation' not applicable when starting at annotation", path: ["skip_annotation"] }); }
         if (data.joint_germline) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Joint Germline' not applicable when starting at annotation", path: ["joint_germline"] }); }
     }


    // --- Cross-field Refinements (Applied to all relevant types) ---
    // Somatic tool check (only if not starting at annotation)
    if (data.step !== 'annotation') {
        // Ensure 'tools' exists on the data type before filtering
        const toolsToCheck = data.tools ?? [];
        const selectedSomaticTools = toolsToCheck.filter(tool => SOMATIC_TOOLS.includes(tool));
        if (selectedSomaticTools.length > 0) {
            const hasTumorSample = data.samples.some(sample => sample.status === 1);
            if (!hasTumorSample) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Tools like ${SOMATIC_TOOLS.join(', ')} require at least one sample with Status = 1 (Tumor).`,
                    path: ["tools"],
                });
            }
        }
    }
    // WES check - intervals file recommended/needed? Add logic if needed.
    // if (data.wes && !data.intervals_file) { ... }
});


// --- End Zod Schema ---


type PipelineFormValues = z.infer<typeof pipelineInputSchema>;
type InputType = PipelineFormValues['input_type'];


export default function InputPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isSaveProfileOpen, setIsSaveProfileOpen] = useState(false);
  const [currentProfileName, setCurrentProfileName] = useState<string | null>(null);
  // State to manage the selected input type
  const [selectedInputType, setSelectedInputType] = useState<InputType>('fastq');

  const form = useForm<PipelineFormValues>({
    resolver: zodResolver(pipelineInputSchema), // Use the discriminated union schema
    mode: "onBlur",
    reValidateMode: "onChange",
    // Default values should align with one of the union types (fastq here)
    defaultValues: {
      input_type: 'fastq',
      samples: [{ patient: "", sample: "", sex: undefined, status: undefined, lane: "", fastq_1: "", fastq_2: "" }],
      genome: "GATK.GRCh38",
      step: "mapping", // Default step for fastq
      intervals_file: "",
      dbsnp: "",
      known_indels: "",
      pon: "",
      tools: [],
      profile: "docker",
      aligner: "bwa-mem",
      joint_germline: false,
      wes: false,
      trim_fastq: false,
      skip_qc: false,
      skip_annotation: false,
      skip_baserecalibrator: false,
      description: "",
    },
  });

  // Watch the input_type field to react to changes
  const watchedInputType = form.watch('input_type');
  const watchedStep = form.watch('step'); // Watch step for parameter visibility

  // Use effect to update selectedInputType state when form value changes
  // and reset samples/step when input type changes
  useEffect(() => {
      if (watchedInputType !== selectedInputType) {
          console.log(`Input type changed from ${selectedInputType} to ${watchedInputType}`);
          setSelectedInputType(watchedInputType);

          // Reset samples to match the new input type's structure
          let defaultSample: Partial<ApiSampleInfo> = {};
          if (watchedInputType === 'fastq') {
              defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, lane: "", fastq_1: "", fastq_2: "" };
          } else if (watchedInputType === 'bam_cram') {
              defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, bam_cram: "", index: "" };
          } else if (watchedInputType === 'vcf') {
               defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, vcf: "", index: "" };
          }
          // Get current values *before* reset to preserve relevant ones
          const currentValues = form.getValues();
          form.reset({
              // Preserve fields common across types or generally applicable
              genome: currentValues.genome,
              profile: currentValues.profile,
              wes: currentValues.wes,
              skip_qc: currentValues.skip_qc,
              description: currentValues.description,
              intervals_file: currentValues.intervals_file, // Keep optional files? Or reset? Resetting might be safer.
              dbsnp: currentValues.dbsnp,
              known_indels: currentValues.known_indels,
              pon: currentValues.pon,

              // Set the new mandatory fields
              input_type: watchedInputType,
              samples: [defaultSample],
              step: STEPS_FOR_INPUT_TYPE[watchedInputType][0], // Set default step for new type

              // Explicitly reset fields that change relevance
              aligner: watchedInputType === 'fastq' ? (currentValues.aligner || 'bwa-mem') : '',
              trim_fastq: watchedInputType === 'fastq' ? currentValues.trim_fastq : false,
              tools: watchedInputType === 'vcf' ? [] : currentValues.tools,
              skip_annotation: watchedInputType === 'vcf' ? false : currentValues.skip_annotation,
              skip_baserecalibrator: watchedInputType === 'vcf' ? false : currentValues.skip_baserecalibrator,
              joint_germline: watchedInputType === 'vcf' ? false : currentValues.joint_germline,
          });
          setCurrentProfileName(null); // Clear loaded profile name on type change
      }
  }, [watchedInputType, form, selectedInputType]);


  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "samples",
  });

  // Memoize available steps based on selected input type
  const availableSteps = useMemo(() => {
      return STEPS_FOR_INPUT_TYPE[selectedInputType] || [];
  }, [selectedInputType]);

  // Determine parameter visibility based on type and step
  const showAligner = selectedInputType === 'fastq';
  const showTrimFastq = selectedInputType === 'fastq';
  const showSkipBaserecalibrator = selectedInputType !== 'vcf' && watchedStep !== 'variant_calling' && watchedStep !== 'annotation';
  const showTools = selectedInputType !== 'vcf' && watchedStep !== 'annotation';
  const showSkipAnnotation = selectedInputType !== 'vcf' && watchedStep !== 'annotation';
  const showJointGermline = selectedInputType !== 'vcf' && watchedStep !== 'annotation';


  const stageMutation = useMutation({
     mutationFn: (values: PipelineInput) => api.stagePipelineJob(values),
     onSuccess: (data) => {
        toast.success(`Job staged successfully: ${data.staged_job_id}`);
        queryClient.invalidateQueries({ queryKey: ['jobsList'] });
        form.reset(); // Reset form to defaults
        setSelectedInputType('fastq'); // Reset selected type state
        setCurrentProfileName(null); // Reset loaded profile name
        router.push('/jobs');
     },
     onError: (error) => {
        let message = `Failed to stage job: ${error.message}`;
        // @ts-ignore - Check if originalError exists and has response data detail
        const detail = error.originalError?.response?.data?.detail;
        if (detail) {
          message = `Failed to stage job: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
        } else {
          message = `Failed to stage job: ${error.message}`;
        }
        toast.error(message, { duration: 10000 });
     }
  });

   const saveProfileMutation = useMutation({
       mutationFn: ({ name, data }: { name: string; data: ProfileData }) => api.saveProfile(name, data),
       onSuccess: (data) => {
           toast.success(`Profile '${data.profile_name}' saved successfully.`);
           queryClient.invalidateQueries({ queryKey: ['profilesList'] });
           setCurrentProfileName(data.profile_name);
           setIsSaveProfileOpen(false);
       },
       onError: (error: Error, variables) => {
            toast.error(`Failed to save profile '${variables.name}': ${error.message}`);
       },
   });

  function onSubmit(values: PipelineFormValues) {
     console.log("Form Values Submitted:", values);
      // Map form values to the API payload type
      const apiPayload: PipelineInput = {
          input_type: values.input_type,
          samples: values.samples.map((s): ApiSampleInfo => ({ // Map to ApiSampleInfo which allows optional fields
                patient: s.patient,
                sample: s.sample,
                sex: s.sex!,
                status: s.status!,
                lane: s.lane || null,
                fastq_1: s.fastq_1 || null,
                fastq_2: s.fastq_2 || null,
                bam_cram: s.bam_cram || null,
                index: s.index || null,
                vcf: s.vcf || null,
          })),
          genome: values.genome,
          step: values.step, // Step is now directly from form
          intervals_file: values.intervals_file || undefined,
          dbsnp: values.dbsnp || undefined,
          known_indels: values.known_indels || undefined,
          pon: values.pon || undefined,
          tools: showTools && values.tools && values.tools.length > 0 ? values.tools : undefined,
          profile: values.profile,
          aligner: showAligner ? (values.aligner || undefined) : undefined, // Only send if relevant
          joint_germline: showJointGermline ? values.joint_germline : undefined, // Only send if relevant
          wes: values.wes,
          trim_fastq: showTrimFastq ? values.trim_fastq : undefined, // Only send if relevant
          skip_qc: values.skip_qc,
          skip_annotation: showSkipAnnotation ? values.skip_annotation : undefined, // Only send if relevant
          skip_baserecalibrator: showSkipBaserecalibrator ? values.skip_baserecalibrator : undefined, // Only send if relevant
          description: values.description || undefined,
      };
     console.log("API Payload to be sent:", apiPayload);
     stageMutation.mutate(apiPayload);
  }

   const toggleCheckboxValue = (fieldName: keyof PipelineFormValues | 'tools', tool?: string) => {
        if (fieldName === 'tools' && tool) {
            const currentVal = form.getValues("tools") ?? [];
            const newVal = currentVal.includes(tool)
                ? currentVal.filter((t) => t !== tool)
                : [...currentVal, tool];
            form.setValue("tools", newVal, { shouldValidate: true, shouldDirty: true });
        } else if (fieldName !== 'tools') {
             if (fieldName in form.getValues()) {
                 const currentVal = form.getValues(fieldName as keyof PipelineFormValues);
                 form.setValue(fieldName as keyof PipelineFormValues, !currentVal, { shouldValidate: true, shouldDirty: true });
            } else {
                console.warn(`Attempted to toggle non-existent field: ${fieldName}`);
            }
        }
    };

   const handleProfileLoaded = (name: string | null, data: ProfileData | null) => {
       setCurrentProfileName(name);
        if (data) {
            // Determine the input type based on the loaded step
            let loadedInputType: InputType = 'fastq'; // Default fallback
            if (data.step === 'mapping') loadedInputType = 'fastq';
            else if (STEPS_FOR_INPUT_TYPE.bam_cram.includes(data.step as SarekStep)) loadedInputType = 'bam_cram';
            else if (data.step === 'annotation') loadedInputType = 'vcf';

             // Trigger input type change FIRST if necessary
            if (loadedInputType !== form.getValues('input_type')) {
                 form.setValue('input_type', loadedInputType, { shouldValidate: true });
                 // The useEffect hook watching input_type will handle resetting samples/step
            }
            // Note: ProfileLoader now handles setting the form values *after* this callback
       } else {
            // Handle reset to default if needed (e.g., user selected '-- Default --')
            form.reset(); // Reset to form's default values
            setSelectedInputType('fastq'); // Explicitly reset state
       }
   };

   const handleSaveProfile = async (profileName: string) => {
       const currentValues = form.getValues();
       // Create the profile data object, excluding 'samples' and 'input_type'
       const profileData: ProfileData = {
           genome: currentValues.genome,
           step: currentValues.step, // Include step
           intervals_file: currentValues.intervals_file || null,
           dbsnp: currentValues.dbsnp || null,
           known_indels: currentValues.known_indels || null,
           pon: currentValues.pon || null,
           tools: showTools && currentValues.tools && currentValues.tools.length > 0 ? currentValues.tools : null,
           profile: currentValues.profile,
           aligner: showAligner ? (currentValues.aligner || null) : null,
           joint_germline: showJointGermline ? currentValues.joint_germline : null,
           wes: currentValues.wes,
           trim_fastq: showTrimFastq ? currentValues.trim_fastq : null,
           skip_qc: currentValues.skip_qc,
           skip_annotation: showSkipAnnotation ? currentValues.skip_annotation : null,
           skip_baserecalibrator: showSkipBaserecalibrator ? currentValues.skip_baserecalibrator : null,
           description: currentValues.description || null,
       };
       console.log("Saving profile data:", profileData);
       await saveProfileMutation.mutateAsync({ name: profileName, data: profileData });
   };

   // Function to add a default sample based on the current input type
    const addSample = () => {
        let defaultSample: Partial<ApiSampleInfo> = {};
         if (selectedInputType === 'fastq') {
             defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, lane: "", fastq_1: "", fastq_2: "" };
         } else if (selectedInputType === 'bam_cram') {
             defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, bam_cram: "", index: "" };
         } else if (selectedInputType === 'vcf') {
              defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, vcf: "", index: "" };
         }
         append(defaultSample);
    };


  return (
    <FormProvider {...form}>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
          <h1 className="text-3xl font-bold mb-6 ml-2">Stage New Sarek Run</h1>

           {/* Input Type and Profile Loader Section */}
           <Card>
             <CardHeader>
                 <CardTitle className="text-primary">Input Configuration</CardTitle>
                 <CardDescription>Select the type of input data you have and load any saved configurations.</CardDescription>
             </CardHeader>
             <CardContent className="space-y-6">
                 {/* Input Type Selector */}
                 <FormField
                     control={form.control}
                     name="input_type"
                     render={({ field }) => (
                         <FormItem>
                             <FormLabel>Input Data Type</FormLabel>
                             <Select onValueChange={field.onChange} value={field.value}>
                                 <FormControl>
                                     <SelectTrigger className="w-full sm:w-64">
                                         <SelectValue placeholder="Select input data type..." />
                                     </SelectTrigger>
                                 </FormControl>
                                 <SelectContent>
                                     <SelectItem value="fastq">Raw Reads (FASTQ)</SelectItem>
                                     <SelectItem value="bam_cram">Aligned Reads (BAM/CRAM)</SelectItem>
                                     <SelectItem value="vcf">Variant Calls (VCF)</SelectItem>
                                 </SelectContent>
                             </Select>
                             <FormDescription>Determines the required sample information and available starting steps.</FormDescription>
                             <FormMessage />
                         </FormItem>
                     )}
                 />
                 {/* Profile Loader */}
                 <ProfileLoader
                     form={form}
                     currentProfileName={currentProfileName}
                     onProfileLoad={handleProfileLoaded}
                     currentInputType={selectedInputType} // Pass current type
                 />
             </CardContent>
           </Card>

          {/* Samples Section - Conditionally Rendered */}
          <Card>
            <CardHeader>
              <CardTitle className="text-primary">Sample Information</CardTitle>
              <CardDescription>
                 {selectedInputType === 'fastq' && "Provide FASTQ file pairs and lane information."}
                 {selectedInputType === 'bam_cram' && "Provide coordinate-sorted BAM or CRAM files (and index for CRAM)."}
                 {selectedInputType === 'vcf' && "Provide VCF files (and index for compressed VCFs)."}
                 {" Status 0 = Normal, 1 = Tumor. IDs cannot contain spaces."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {fields.map((field, index) => {
                  if (selectedInputType === 'fastq') {
                      return <SampleInputGroup key={field.id} index={index} remove={remove} control={form.control} />;
                  } else if (selectedInputType === 'bam_cram') {
                       return <BamCramSampleInputGroup key={field.id} index={index} remove={remove} control={form.control} />;
                  } else if (selectedInputType === 'vcf') {
                       return <VcfSampleInputGroup key={field.id} index={index} remove={remove} control={form.control} />;
                  }
                  return null; // Should not happen
              })}
               <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addSample} // Use the new addSample function
                className="mt-2 cursor-pointer"
              >
                <PlusCircle className="mr-2 h-4 w-4" />
                Add Sample
              </Button>
               {/* Display root errors for samples array */}
               <FormMessage>{form.formState.errors.samples?.message || form.formState.errors.samples?.root?.message}</FormMessage>
            </CardContent>
          </Card>

          {/* Reference & Annotation Files Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-primary">Reference & Annotation Files</CardTitle>
              <CardDescription>Select the reference genome build and optional annotation files (relevance depends on starting step).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Genome (Always relevant) */}
              <FormField control={form.control} name="genome" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Reference Genome Build <span className="text-destructive">*</span></FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select genome build" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_GENOMES.map(g => ( <SelectItem key={g.value} value={g.value}> {g.label} </SelectItem> ))} </SelectContent> </Select> <FormDescription className="italic"> Select the genome assembly key (e.g., GATK.GRCh38). </FormDescription> <FormMessage /> </FormItem> )} />
              {/* Optional Files - Visibility could be further refined if needed */}
              <FormField control={form.control} name="intervals_file" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default"> Intervals File <span className="text-muted-foreground text-xs"> (Optional)</span> </FormLabel> <FormControl> <FileSelector fileTypeLabel="Intervals" fileType="intervals" extensions={[".bed", ".list", ".interval_list"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select intervals file..." allowNone required={false} /> </FormControl> <FormDescription className="italic"> Target regions (e.g., for WES). </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="dbsnp" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">dbSNP (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="dbSNP" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select dbSNP file..." allowNone /> </FormControl> <FormDescription className="italic"> Known variants VCF (e.g., for BQSR). </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="known_indels" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Known Indels (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="Known Indels" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select known indels file..." allowNone /> </FormControl> <FormDescription className="italic"> Known indels VCF (e.g., for BQSR). </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="pon" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Panel of Normals (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="Panel of Normals" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select Panel of Normals file..." allowNone /> </FormControl> <FormDescription className="italic"> Panel of Normals VCF (for somatic calling). </FormDescription> <FormMessage /> </FormItem> )} />
            </CardContent>
          </Card>

          {/* Parameters Section - Dynamic Visibility */}
           <Card>
             <CardHeader>
                 <CardTitle className="text-primary">Pipeline Parameters</CardTitle>
                 <CardDescription>Configure Sarek workflow options. Availability depends on Input Type and Starting Step.</CardDescription>
             </CardHeader>
             <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 {/* Starting Step */}
                 <FormField
                     control={form.control}
                     name="step"
                     render={({ field }) => (
                         <FormItem>
                             <FormLabel className="cursor-default">Starting Step <span className="text-destructive">*</span></FormLabel>
                             <Select
                                 onValueChange={field.onChange}
                                 value={field.value}
                                 disabled={availableSteps.length <= 1} // Disable if only one option
                             >
                                 <FormControl>
                                     <SelectTrigger>
                                         <SelectValue placeholder="Select starting step" />
                                     </SelectTrigger>
                                 </FormControl>
                                 <SelectContent>
                                     {availableSteps.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                                 </SelectContent>
                             </Select>
                             <FormDescription className="italic">Pipeline execution starting point.</FormDescription>
                             <FormMessage />
                         </FormItem>
                     )}
                 />
                 {/* Profile */}
                 <FormField control={form.control} name="profile" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Execution Profile</FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select execution profile" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_PROFILES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Container or environment system. </FormDescription> <FormMessage /> </FormItem> )} />

                 {/* Aligner (Conditional) */}
                 {showAligner && (
                     <FormField control={form.control} name="aligner" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Aligner</FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value || ""}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select aligner" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_ALIGNERS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Alignment algorithm (only for FASTQ input). </FormDescription> <FormMessage /> </FormItem> )} />
                 )}

                 {/* Tools Checkboxes (Conditional) */}
                 {showTools && (
                    <div className="md:col-span-2">
                        <div className="mb-4">
                            <div className="text-base font-medium">Variant Calling Tools</div>
                            <p className="text-sm text-muted-foreground">Select tools to run (not applicable when starting at annotation).</p>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                            {SAREK_TOOLS.map((tool) => {
                                const uniqueId = `tool-${tool}`;
                                const currentTools: string[] = form.watch("tools") || [];
                                const isChecked = currentTools.includes(tool);
                                return (
                                    <FormItem key={uniqueId} className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-3 hover:bg-accent/50 transition-colors select-none">
                                        <FormLabel htmlFor={uniqueId} className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full">
                                            <FormControl className="flex h-6 items-start">
                                                <Checkbox id={uniqueId} checked={isChecked} onCheckedChange={() => toggleCheckboxValue('tools', tool)} />
                                            </FormControl>
                                            <span className="pt-px">{tool}</span>
                                        </FormLabel>
                                    </FormItem>
                                );
                            })}
                        </div>
                        <FormField control={form.control} name="tools" render={() => <FormMessage className="pt-2" />} />
                    </div>
                 )}


                 {/* Boolean Flags Group (Conditional Visibility) */}
                  <div className="md:col-span-2 space-y-4">
                      {/* WES Flag (Always visible, relevance depends on intervals) */}
                       <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                           <FormLabel htmlFor="flag-wes" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full">
                               <FormControl className="flex h-6 items-start"> <Checkbox id="flag-wes" checked={form.watch('wes')} onCheckedChange={() => toggleCheckboxValue('wes')} /> </FormControl>
                               <div className="space-y-1 leading-none pt-px"> <span>Whole Exome Sequencing (WES)</span> <FormDescription className="italic mt-1"> Check if data is WES/targeted. Recommended to provide an Intervals file. </FormDescription> </div>
                           </FormLabel>
                           <FormField control={form.control} name="wes" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} />
                       </FormItem>

                      {/* Trim FASTQ (Conditional) */}
                      {showTrimFastq && (
                         <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                             <FormLabel htmlFor="flag-trim_fastq" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full">
                                 <FormControl className="flex h-6 items-start"> <Checkbox id="flag-trim_fastq" checked={form.watch('trim_fastq')} onCheckedChange={() => toggleCheckboxValue('trim_fastq')} /> </FormControl>
                                 <div className="space-y-1 leading-none pt-px"> <span>Trim FASTQ</span> <FormDescription className="italic mt-1"> Enable adapter trimming (only for FASTQ input). </FormDescription> </div>
                             </FormLabel>
                             <FormField control={form.control} name="trim_fastq" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} />
                         </FormItem>
                      )}

                      {/* Skip BaseRecalibrator (Conditional) */}
                      {showSkipBaserecalibrator && (
                         <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                             <FormLabel htmlFor="flag-skip_baserecalibrator" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full">
                                 <FormControl className="flex h-6 items-start"> <Checkbox id="flag-skip_baserecalibrator" checked={form.watch('skip_baserecalibrator')} onCheckedChange={() => toggleCheckboxValue('skip_baserecalibrator')} /> </FormControl>
                                 <div className="space-y-1 leading-none pt-px"> <span>Skip Base Recalibration</span> <FormDescription className="italic mt-1"> Skip BQSR step (not applicable if starting at/after variant calling). </FormDescription> </div>
                             </FormLabel>
                             <FormField control={form.control} name="skip_baserecalibrator" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} />
                         </FormItem>
                      )}

                       {/* Joint Germline (Conditional) */}
                       {showJointGermline && (
                          <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                              <FormLabel htmlFor="flag-joint_germline" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full">
                                  <FormControl className="flex h-6 items-start"> <Checkbox id="flag-joint_germline" checked={form.watch('joint_germline')} onCheckedChange={() => toggleCheckboxValue('joint_germline')} /> </FormControl>
                                  <div className="space-y-1 leading-none pt-px"> <span>Joint Germline Calling</span> <FormDescription className="italic mt-1"> Enable joint calling (not applicable if starting at annotation). </FormDescription> </div>
                              </FormLabel>
                              <FormField control={form.control} name="joint_germline" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} />
                          </FormItem>
                       )}

                       {/* Skip QC (Always visible) */}
                       <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                           <FormLabel htmlFor="flag-skip_qc" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full">
                               <FormControl className="flex h-6 items-start"> <Checkbox id="flag-skip_qc" checked={form.watch('skip_qc')} onCheckedChange={() => toggleCheckboxValue('skip_qc')} /> </FormControl>
                               <div className="space-y-1 leading-none pt-px"> <span>Skip QC</span> <FormDescription className="italic mt-1"> Skip quality control steps (FastQC, Samtools stats, etc.). </FormDescription> </div>
                           </FormLabel>
                           <FormField control={form.control} name="skip_qc" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} />
                       </FormItem>

                        {/* Skip Annotation (Conditional) */}
                        {showSkipAnnotation && (
                           <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                               <FormLabel htmlFor="flag-skip_annotation" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full">
                                   <FormControl className="flex h-6 items-start"> <Checkbox id="flag-skip_annotation" checked={form.watch('skip_annotation')} onCheckedChange={() => toggleCheckboxValue('skip_annotation')} /> </FormControl>
                                   <div className="space-y-1 leading-none pt-px"> <span>Skip Annotation</span> <FormDescription className="italic mt-1"> Skip variant annotation steps (not applicable if starting at annotation). </FormDescription> </div>
                               </FormLabel>
                               <FormField control={form.control} name="skip_annotation" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} />
                           </FormItem>
                        )}
                  </div>
             </CardContent>
           </Card>

           {/* Metadata Section */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-primary">Metadata</CardTitle>
                </CardHeader>
                <CardContent>
                    <FormField control={form.control} name="description" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Run Description <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <Input placeholder="e.g., Initial somatic analysis for Cohort X" {...field} value={field.value ?? ''}/> </FormControl> <FormMessage /> </FormItem> )} />
                </CardContent>
            </Card>

          {/* Action Buttons - Stage and Save Profile */}
            <div className="flex justify-start items-center gap-4 px-[1%]">
                 {/* Stage Button */}
                 <Button
                    type="submit"
                    disabled={stageMutation.isPending || saveProfileMutation.isPending}
                    className="border border-primary hover:underline cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90"
                 >
                   {stageMutation.isPending
                     ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                     : <Play className="mr-2 h-4 w-4" />
                   }
                   Stage Pipeline Run
                 </Button>

                 {/* Save Profile Button */}
                 <Button
                     type="button"
                     variant="outline"
                     onClick={() => setIsSaveProfileOpen(true)}
                     disabled={stageMutation.isPending || saveProfileMutation.isPending}
                     className="cursor-pointer"
                 >
                    <Save className="mr-2 h-4 w-4" />
                    Save Profile
                 </Button>
             </div>

        </form>
      </Form>

       {/* Save Profile Dialog */}
        <SaveProfileDialog
           isOpen={isSaveProfileOpen}
           onOpenChange={setIsSaveProfileOpen}
           onSave={handleSaveProfile}
           isSaving={saveProfileMutation.isPending}
           currentProfileName={currentProfileName}
        />

    </FormProvider>
  );
}
