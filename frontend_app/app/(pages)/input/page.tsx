// File: frontend_app/app/(pages)/input/page.tsx
"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import { useForm, useFieldArray, FormProvider, SubmitErrorHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z, ZodType } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { PlusCircle, Loader2, Play, Save, Info } from "lucide-react";
import { toast } from "sonner";

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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

// --- Zod Schemas ---
const noSpacesRegex = /^[^\s]+$/;
const laneRegex = /^L\d{3}$/;

const baseSample = {
    patient: z.string().min(1, "Patient ID is required").regex(noSpacesRegex, "Patient ID cannot contain spaces"),
    sample: z.string().min(1, "Sample ID is required").regex(noSpacesRegex, "Sample ID cannot contain spaces"),
    sex: z.enum(["XX", "XY", "X", "Y", "other"], { required_error: "Sex is required" }),
    status: z.union([z.literal(0), z.literal(1)], { required_error: "Status is required" }),
};

const fastqSampleSchema = z.object({
    ...baseSample,
    lane: z.string().min(1, "Lane is required").regex(laneRegex, "Lane must be in format L001"),
    fastq_1: z.string().min(1, "FASTQ R1 is required"),
    fastq_2: z.string().min(1, "FASTQ R2 is required"),
    bam_cram: z.union([z.string().length(0, "Cannot provide BAM/CRAM for FASTQ input"), z.null(), z.undefined()]).optional(),
    vcf: z.union([z.string().length(0, "Cannot provide VCF for FASTQ input"), z.null(), z.undefined()]).optional(),
    index: z.union([z.string().length(0, "Cannot provide Index for FASTQ input"), z.null(), z.undefined()]).optional(),
});

// UPDATED BamCram Schema with Index Extension Check
const bamCramSampleSchema = z.object({
     ...baseSample,
    bam_cram: z.string().min(1, "BAM/CRAM file is required").refine(f => f.endsWith('.bam') || f.endsWith('.cram'), "Must be a .bam or .cram file"),
    index: z.string().optional().nullable(),
    lane: z.union([z.string().length(0, "Lane not applicable for BAM/CRAM"), z.null(), z.undefined()]).optional(),
    fastq_1: z.union([z.string().length(0, "FASTQ not applicable for BAM/CRAM"), z.null(), z.undefined()]).optional(),
    fastq_2: z.union([z.string().length(0, "FASTQ not applicable for BAM/CRAM"), z.null(), z.undefined()]).optional(),
    vcf: z.union([z.string().length(0, "Cannot provide VCF for BAM/CRAM input"), z.null(), z.undefined()]).optional(),
})
.refine(data => !(data.bam_cram?.endsWith('.cram') && !data.index), {
    message: "An index file (.crai) must be provided for CRAM input.", path: ["index"],
})
// ADDED: Refinement for index extension matching main file
.refine(data => {
    if (!data.index || !data.bam_cram) return true; // Pass if no index or no main file
    if (data.bam_cram.endsWith('.cram') && !data.index.endsWith('.crai')) return false; // Fail if CRAM and index not .crai
    if (data.bam_cram.endsWith('.bam') && !data.index.endsWith('.bai')) return false; // Fail if BAM and index not .bai
    return true; // Pass otherwise
}, {
    message: "Index extension mismatch: use .bai for .bam, .crai for .cram.", path: ["index"],
});

// UPDATED VCF Schema with Index Extension Check
const vcfSampleSchema = z.object({
     ...baseSample,
    vcf: z.string().min(1, "VCF file is required").refine(f => f.endsWith('.vcf') || f.endsWith('.vcf.gz'), "Must be a .vcf or .vcf.gz file"),
    index: z.string().optional().nullable(),
    lane: z.union([z.string().length(0, "Lane not applicable for VCF"), z.null(), z.undefined()]).optional(),
    fastq_1: z.union([z.string().length(0, "FASTQ not applicable for VCF"), z.null(), z.undefined()]).optional(),
    fastq_2: z.union([z.string().length(0, "FASTQ not applicable for VCF"), z.null(), z.undefined()]).optional(),
    bam_cram: z.union([z.string().length(0, "Cannot provide BAM/CRAM for VCF input"), z.null(), z.undefined()]).optional(),
})
.refine(data => !(data.vcf?.endsWith('.vcf.gz') && !data.index), {
    message: "An index file (.tbi/.csi) must be provided for compressed VCF (.vcf.gz) input.", path: ["index"],
})
// ADDED: Refinement for index extension check
.refine(data => {
    if (!data.index) return true; // Pass if no index provided
    return data.index.endsWith('.tbi') || data.index.endsWith('.csi'); // Check extension if index exists
}, {
    message: "Index file must end with .tbi or .csi.", path: ["index"],
});


// --- Constants ---
const ALL_SAREK_STEPS = ["mapping", "markduplicates", "prepare_recalibration", "recalibrate", "variant_calling", "annotation"] as const;
type SarekStep = typeof ALL_SAREK_STEPS[number];
const SAREK_TOOLS = ["strelka", "mutect2", "freebayes", "mpileup", "vardict", "manta", "cnvkit"];
const SAREK_PROFILES = ["docker", "singularity", "conda", "podman"];
const SAREK_GENOMES = [ { value: "GATK.GRCh38", label: "GRCh38 (GATK Bundle)" }, { value: "GATK.GRCh37", label: "GRCh37 (GATK Bundle)" }, { value: "hg38", label: "hg38 (UCSC)" }, { value: "hg19", label: "hg19 (UCSC)" }, ];
const VALID_GENOME_VALUES = SAREK_GENOMES.map(g => g.value) as [string, ...string[]];
const SAREK_ALIGNERS = ["bwa-mem", "dragmap"];
const SOMATIC_TOOLS = ["mutect2", "strelka"];
const STEPS_FOR_INPUT_TYPE: Record<'fastq' | 'bam_cram' | 'vcf', SarekStep[]> = { fastq: ["mapping"], bam_cram: ["markduplicates", "prepare_recalibration", "recalibrate", "variant_calling"], vcf: ["annotation"], };

// --- Base Schemas ---
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
    aligner: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    joint_germline: z.boolean().default(false),
    wes: z.boolean().default(false),
    trim_fastq: z.boolean().default(false),
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
    tools: z.array(z.string()).default([]),
    profile: z.enum(SAREK_PROFILES as [string, ...string[]]).default("docker"),
    aligner: z.union([z.string().length(0), z.null(), z.undefined()]).optional(),
    joint_germline: z.boolean().default(false),
    wes: z.boolean().default(false),
    trim_fastq: z.boolean().default(false),
    skip_qc: z.boolean().default(false),
    skip_annotation: z.boolean().default(false),
    skip_baserecalibrator: z.boolean().default(false),
    description: z.string().optional(),
});

// --- Final Schema with Refinements ---
const pipelineInputSchema = z.discriminatedUnion("input_type", [
    fastqPipelineSchemaBase,
    bamCramPipelineSchemaBase,
    vcfPipelineSchemaBase,
])
.superRefine((data, ctx) => {
    // BQSR file requirement
    const isBqsrRelevant = data.input_type !== 'vcf' && data.step !== 'variant_calling' && data.step !== 'annotation';
    const isBqsrEnabled = !data.skip_baserecalibrator;
    const missingBqsrFiles = !data.dbsnp && !data.known_indels;
    if (isBqsrRelevant && isBqsrEnabled && missingBqsrFiles) {
         ctx.addIssue({ code: z.ZodIssueCode.custom, message: "dbSNP or Known Indels file required if BQSR not skipped.", path: ["dbsnp"] });
         ctx.addIssue({ code: z.ZodIssueCode.custom, message: "dbSNP or Known Indels file required.", path: ["skip_baserecalibrator"] });
    }
    // WES and Intervals requirement
    if (data.wes && !data.intervals_file) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Intervals file is required when WES mode is enabled.", path: ["intervals_file"] });
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Intervals file is required.", path: ["wes"] });
    }
    // Somatic Tools and Tumor Sample Requirement
    if (data.step !== 'annotation') {
        const toolsToCheck = data.tools ?? [];
        const selectedSomaticTools = toolsToCheck.filter(tool => SOMATIC_TOOLS.includes(tool));
        if (selectedSomaticTools.length > 0) {
            const hasTumorSample = data.samples.some(sample => sample.status === 1);
            if (!hasTumorSample) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Somatic tool(s) selected (${selectedSomaticTools.join(', ')}) require at least one sample with Status = 1 (Tumor).`, path: ["tools"] });
                 ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Tumor sample required for selected somatic tool(s).`, path: ["samples"] });
            }
        }
    }
    // Type/Step Specific Refinements
    if (data.input_type === 'fastq') { if (data.aligner && !SAREK_ALIGNERS.includes(data.aligner)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid aligner selected.", path: ["aligner"] }); } }
    if (data.input_type === 'bam_cram') { if (data.trim_fastq) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Trim FASTQ' not applicable for BAM/CRAM input", path: ["trim_fastq"] }); } if (data.aligner && data.aligner.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Aligner not applicable for BAM/CRAM input", path: ["aligner"] }); } if (data.skip_baserecalibrator && (data.step === 'variant_calling')) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Base Recalibration' not applicable when starting at variant calling.", path: ["skip_baserecalibrator"] }); } }
    if (data.input_type === 'vcf') { if (data.trim_fastq) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Trim FASTQ' not applicable for VCF input", path: ["trim_fastq"] }); } if (data.aligner && data.aligner.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Aligner not applicable for VCF input", path: ["aligner"] }); } if (data.skip_baserecalibrator) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Base Recalibration' not applicable for VCF input", path: ["skip_baserecalibrator"] }); } if (data.tools.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Variant calling tools not applicable for VCF input", path: ["tools"] }); } if (data.skip_annotation) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Annotation' not applicable when starting at annotation", path: ["skip_annotation"] }); } if (data.joint_germline) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Joint Germline' not applicable when starting at annotation", path: ["joint_germline"] }); } }
});
// --- End Zod Schema ---

type PipelineFormValues = z.infer<typeof pipelineInputSchema>;
type InputType = PipelineFormValues['input_type'];

export default function InputPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isSaveProfileOpen, setIsSaveProfileOpen] = useState(false);
  const [currentProfileName, setCurrentProfileName] = useState<string | null>(null);
  const [selectedInputType, setSelectedInputType] = useState<InputType>('fastq');
  const formRef = useRef<HTMLFormElement>(null);

  const form = useForm<PipelineFormValues>({
    resolver: zodResolver(pipelineInputSchema),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: {
      input_type: 'fastq',
      samples: [{ patient: "", sample: "", sex: undefined, status: undefined, lane: "L001", fastq_1: "", fastq_2: "" }],
      genome: "GATK.GRCh38",
      step: "mapping",
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

  // Watch necessary fields
  const watchedInputType = form.watch('input_type');
  const watchedStep = form.watch('step');
  const watchedSkipBqsr = form.watch('skip_baserecalibrator');
  const watchedDbsnp = form.watch('dbsnp');
  const watchedKnownIndels = form.watch('known_indels');
  const watchedWes = form.watch('wes');
  const watchedIntervalsFile = form.watch('intervals_file');
  const watchedTools = form.watch('tools');
  const watchedSamples = form.watch('samples');

  // Input Type Change Effect
  useEffect(() => {
      if (watchedInputType !== selectedInputType) {
          console.log(`Input type changed from ${selectedInputType} to ${watchedInputType}`);
          setSelectedInputType(watchedInputType);
          let defaultSample: Partial<ApiSampleInfo> = {};
          if (watchedInputType === 'fastq') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, lane: "L001", fastq_1: "", fastq_2: "" }; }
          else if (watchedInputType === 'bam_cram') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, bam_cram: "", index: "" }; }
          else if (watchedInputType === 'vcf') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, vcf: "", index: "" }; }
          const currentValues = form.getValues();
          form.reset({
              genome: currentValues.genome, profile: currentValues.profile, wes: currentValues.wes, skip_qc: currentValues.skip_qc, description: currentValues.description, intervals_file: currentValues.intervals_file, dbsnp: currentValues.dbsnp, known_indels: currentValues.known_indels, pon: currentValues.pon,
              input_type: watchedInputType, samples: [defaultSample], step: STEPS_FOR_INPUT_TYPE[watchedInputType][0],
              aligner: watchedInputType === 'fastq' ? (currentValues.aligner || 'bwa-mem') : '', trim_fastq: watchedInputType === 'fastq' ? currentValues.trim_fastq : false, tools: watchedInputType === 'vcf' ? [] : currentValues.tools, skip_annotation: watchedInputType === 'vcf' ? false : currentValues.skip_annotation, skip_baserecalibrator: watchedInputType === 'vcf' ? false : currentValues.skip_baserecalibrator, joint_germline: watchedInputType === 'vcf' ? false : currentValues.joint_germline,
          });
          setCurrentProfileName(null);
      }
  }, [watchedInputType, form, selectedInputType]);

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "samples",
  });

  const availableSteps = useMemo(() => {
      return STEPS_FOR_INPUT_TYPE[selectedInputType] || [];
  }, [selectedInputType]);

  // Parameter Visibility
  const showAligner = selectedInputType === 'fastq';
  const showTrimFastq = selectedInputType === 'fastq';
  const showSkipBaserecalibrator = selectedInputType !== 'vcf' && watchedStep !== 'variant_calling' && watchedStep !== 'annotation';
  const showTools = selectedInputType !== 'vcf' && watchedStep !== 'annotation';
  const showSkipAnnotation = selectedInputType !== 'vcf' && watchedStep !== 'annotation';
  const showJointGermline = selectedInputType !== 'vcf' && watchedStep !== 'annotation';

  // --- Mutations ---
  const stageMutation = useMutation({
     mutationFn: (values: PipelineInput) => api.stagePipelineJob(values),
     onSuccess: (data) => {
        toast.success(`Job staged successfully: ${data.staged_job_id}`);
        queryClient.invalidateQueries({ queryKey: ['jobsList'] });
        form.reset();
        setSelectedInputType('fastq');
        setCurrentProfileName(null);
        router.push('/jobs');
     },
     onError: (error) => {
        let message = `Failed to stage job: ${error.message}`;
        // @ts-ignore
        const detail = error.originalError?.response?.data?.detail;
        if (detail) { message = `Failed to stage job: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`; }
        else { message = `Failed to stage job: ${error.message}`; }
        toast.error(message, { duration: 10000 });
        scrollToFirstError(form.formState.errors);
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
   // --- END Mutations ---

   // --- Button Disabling Logic ---
   const isBqsrRelevantForButton = watchedInputType !== 'vcf' && watchedStep !== 'variant_calling' && watchedStep !== 'annotation';
   const isBqsrEnabledForButton = !watchedSkipBqsr;
   const missingBqsrFilesForButton = !watchedDbsnp && !watchedKnownIndels;
   const isBqsrCheckFailedForButton = isBqsrRelevantForButton && isBqsrEnabledForButton && missingBqsrFilesForButton;

   const isSomaticToolSelected = watchedTools?.some(tool => SOMATIC_TOOLS.includes(tool)) ?? false;
   const hasTumorSample = watchedSamples?.some(sample => sample.status === 1) ?? false;
   const isSomaticTumorCheckFailedForButton = isSomaticToolSelected && !hasTumorSample && watchedStep !== 'annotation';

   const isWesIntervalsCheckFailedForButton = watchedWes && (!watchedIntervalsFile || watchedIntervalsFile.trim() === ''); // Check if empty string too

   const isStagingDisabled = stageMutation.isPending || saveProfileMutation.isPending || isBqsrCheckFailedForButton || isSomaticTumorCheckFailedForButton || isWesIntervalsCheckFailedForButton;

   const getDisabledButtonTooltip = (): string | undefined => {
       if (isBqsrCheckFailedForButton) { return "BQSR requires dbSNP or Known Indels file unless skipped."; }
       if (isSomaticTumorCheckFailedForButton) { return "Selected somatic tool(s) require at least one Tumor sample (Status=1)."; }
       if (isWesIntervalsCheckFailedForButton) { return "Intervals file is required when WES mode is enabled."; }
       if (stageMutation.isPending || saveProfileMutation.isPending) { return "Operation in progress..."; }
       return undefined;
   };
   // --- End Button Disable Logic ---

  // --- onSubmit function ---
  function onSubmit(values: PipelineFormValues) {
     console.log("Form Values Submitted:", values);
      const apiPayload: PipelineInput = {
          input_type: values.input_type, samples: values.samples.map((s): ApiSampleInfo => ({ patient: s.patient, sample: s.sample, sex: s.sex!, status: s.status!, lane: s.lane || null, fastq_1: s.fastq_1 || null, fastq_2: s.fastq_2 || null, bam_cram: s.bam_cram || null, index: s.index || null, vcf: s.vcf || null, })),
          genome: values.genome, step: values.step, intervals_file: values.intervals_file || undefined, dbsnp: values.dbsnp || undefined, known_indels: values.known_indels || undefined, pon: values.pon || undefined,
          tools: showTools && values.tools && values.tools.length > 0 ? values.tools : undefined, profile: values.profile, aligner: showAligner ? (values.aligner || undefined) : undefined, joint_germline: showJointGermline ? values.joint_germline : undefined, wes: values.wes,
          trim_fastq: showTrimFastq ? values.trim_fastq : undefined, skip_qc: values.skip_qc, skip_annotation: showSkipAnnotation ? values.skip_annotation : undefined, skip_baserecalibrator: showSkipBaserecalibrator ? values.skip_baserecalibrator : undefined, description: values.description || undefined,
      };
     console.log("API Payload to be sent:", apiPayload);
     stageMutation.mutate(apiPayload);
  }

  // --- Scroll Function ---
  const scrollToFirstError = (errors: typeof form.formState.errors) => {
        const errorKeys = Object.keys(errors);
        if (errorKeys.length > 0) {
            let firstErrorKey = errorKeys[0] as keyof PipelineFormValues | 'samples';
            let fieldName = firstErrorKey;
            if (firstErrorKey === 'samples' && Array.isArray(errors.samples)) {
                const firstSampleErrorIndex = errors.samples.findIndex(s => s && Object.keys(s).length > 0);
                if (firstSampleErrorIndex !== -1) {
                    const sampleErrors = errors.samples[firstSampleErrorIndex];
                     if (sampleErrors) { const firstSampleFieldError = Object.keys(sampleErrors)[0]; fieldName = `samples.${firstSampleErrorIndex}.${firstSampleFieldError}`; }
                }
            } else if (firstErrorKey === 'samples' && typeof errors.samples?.root?.message === 'string') {
                 // Handle root error on samples array (e.g., tumor required)
                 // Try to scroll to the Samples card header or the first sample group
                 const samplesCardHeader = formRef.current?.querySelector('#samples-card-header'); // Need to add this ID
                 if (samplesCardHeader) {
                     samplesCardHeader.scrollIntoView({ behavior: "smooth", block: "center" });
                     return; // Exit after scrolling to card header
                 } else {
                      // Fallback to scrolling first sample group if header ID not found
                     fieldName = `samples.0.patient`; // Or another field in the first sample
                 }
            }
            console.log(`Attempting to scroll to first error field: ${fieldName}`);
            const element = formRef.current?.querySelector(`[name="${fieldName}"]`);
            if (element) { element.scrollIntoView({ behavior: "smooth", block: "center" }); }
            else { console.warn(`Could not find element with name: ${fieldName}. Scrolling form to top.`); formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }
        }
    };

   // --- Error Handler ---
   const onFormError: SubmitErrorHandler<PipelineFormValues> = (errors) => {
       console.error("Form validation failed:", errors);
       toast.error("Please fix the validation errors before staging.", { duration: 5000 });
       scrollToFirstError(errors);
   };

   // --- toggleCheckboxValue function ---
   const toggleCheckboxValue = (fieldName: keyof PipelineFormValues | 'tools', tool?: string) => {
        if (fieldName === 'tools' && tool) { const currentVal = form.getValues("tools") ?? []; const newVal = currentVal.includes(tool) ? currentVal.filter((t) => t !== tool) : [...currentVal, tool]; form.setValue("tools", newVal, { shouldValidate: true, shouldDirty: true }); }
        else if (fieldName !== 'tools') { const fieldKey = fieldName as keyof PipelineFormValues; if (fieldKey in form.getValues()) { const currentVal = form.getValues(fieldKey); form.setValue(fieldKey, !currentVal, { shouldValidate: true, shouldDirty: true }); } else { console.warn(`Attempted to toggle non-existent field: ${fieldName}`); } }
    };

   // --- handleProfileLoaded function ---
   const handleProfileLoaded = (name: string | null, data: ProfileData | null) => {
       setCurrentProfileName(name);
        if (data) {
            let loadedInputType: InputType = 'fastq';
            if (data.step === 'mapping') loadedInputType = 'fastq';
            else if (STEPS_FOR_INPUT_TYPE.bam_cram.includes(data.step as SarekStep)) loadedInputType = 'bam_cram';
            else if (data.step === 'annotation') loadedInputType = 'vcf';

            // Check if input type needs to change *before* calling onProfileLoad
            const currentInputType = form.getValues('input_type');
            if (loadedInputType !== currentInputType) {
                toast.info(`Profile '${name}' requires ${loadedInputType.toUpperCase()} input. Switching input type.`);
                // Set the value directly here to trigger the useEffect hook in this component
                form.setValue('input_type', loadedInputType, { shouldValidate: true });
            }

            // Now call the callback to let ProfileLoader set the actual values
            onProfileLoad(selectedName, profileData); // Pass selectedName and profileData

       } else {
            form.reset();
            setSelectedInputType('fastq');
       }
   };

   // --- handleSaveProfile function ---
   const handleSaveProfile = async (profileName: string) => {
       const currentValues = form.getValues();
       const profileData: ProfileData = { genome: currentValues.genome, step: currentValues.step, intervals_file: currentValues.intervals_file || null, dbsnp: currentValues.dbsnp || null, known_indels: currentValues.known_indels || null, pon: currentValues.pon || null, tools: showTools && currentValues.tools && currentValues.tools.length > 0 ? currentValues.tools : null, profile: currentValues.profile, aligner: showAligner ? (currentValues.aligner || null) : null, joint_germline: showJointGermline ? currentValues.joint_germline : null, wes: currentValues.wes, trim_fastq: showTrimFastq ? currentValues.trim_fastq : null, skip_qc: currentValues.skip_qc, skip_annotation: showSkipAnnotation ? currentValues.skip_annotation : null, skip_baserecalibrator: showSkipBaserecalibrator ? currentValues.skip_baserecalibrator : null, description: currentValues.description || null, };
       console.log("Saving profile data:", profileData);
       await saveProfileMutation.mutateAsync({ name: profileName, data: profileData });
    };

   // --- addSample function ---
   const addSample = () => {
        let defaultSample: Partial<ApiSampleInfo> = {};
         if (selectedInputType === 'fastq') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, lane: "L001", fastq_1: "", fastq_2: "" }; }
         else if (selectedInputType === 'bam_cram') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, bam_cram: "", index: "" }; }
         else if (selectedInputType === 'vcf') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, vcf: "", index: "" }; }
         append(defaultSample);
    };


  // --- JSX Return ---
  return (
    <FormProvider {...form}>
      <Form {...form}>
        <form ref={formRef} onSubmit={form.handleSubmit(onSubmit, onFormError)} className="space-y-8">
          <h1 className="text-3xl font-bold mb-6 ml-2">Stage New Sarek Run</h1>

           {/* Input Config Card */}
           <Card>
             <CardHeader> <CardTitle className="text-primary">Input Configuration</CardTitle> <CardDescription>Select the type of input data you have and load any saved configurations.</CardDescription> </CardHeader>
             <CardContent className="space-y-6">
                 <FormField control={form.control} name="input_type" render={({ field }) => ( <FormItem> <FormLabel>Input Data Type</FormLabel> <Select onValueChange={field.onChange} value={field.value}> <FormControl> <SelectTrigger className="w-full sm:w-64"> <SelectValue placeholder="Select input data type..." /> </SelectTrigger> </FormControl> <SelectContent> <SelectItem value="fastq">Raw Reads (FASTQ)</SelectItem> <SelectItem value="bam_cram">Aligned Reads (BAM/CRAM)</SelectItem> <SelectItem value="vcf">Variant Calls (VCF)</SelectItem> </SelectContent> </Select> <FormDescription>Determines the required sample information and available starting steps.</FormDescription> <FormMessage /> </FormItem> )} />
                 <ProfileLoader form={form} currentProfileName={currentProfileName} onProfileLoad={handleProfileLoaded} currentInputType={selectedInputType} />
             </CardContent>
           </Card>

          {/* Samples Card - Added ID to header */}
          <Card>
            <CardHeader id="samples-card-header"> {/* Added ID here */}
                <CardTitle className="text-primary">Sample Information</CardTitle>
                <CardDescription> {selectedInputType === 'fastq' && "Provide FASTQ file pairs and lane information."} {selectedInputType === 'bam_cram' && "Provide coordinate-sorted BAM or CRAM files (and index for CRAM)."} {selectedInputType === 'vcf' && "Provide VCF files (and index for compressed VCFs)."} {" Status 0 = Normal, 1 = Tumor. IDs cannot contain spaces."} </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {fields.map((field, index) => {
                  if (selectedInputType === 'fastq') { return <SampleInputGroup key={field.id} index={index} remove={remove} control={form.control} />; }
                  else if (selectedInputType === 'bam_cram') { return <BamCramSampleInputGroup key={field.id} index={index} remove={remove} control={form.control} />; }
                  else if (selectedInputType === 'vcf') { return <VcfSampleInputGroup key={field.id} index={index} remove={remove} control={form.control} />; }
                  return null;
              })}
               <Button type="button" variant="outline" size="sm" onClick={addSample} className="mt-2 cursor-pointer" > <PlusCircle className="mr-2 h-4 w-4" /> Add Sample </Button>
               <FormMessage>{form.formState.errors.samples?.message || form.formState.errors.samples?.root?.message}</FormMessage>
            </CardContent>
          </Card>

          {/* Reference Files Card - Updated descriptions */}
          <Card>
            <CardHeader> <CardTitle className="text-primary">Reference & Annotation Files</CardTitle> <CardDescription>Select the reference genome build and optional annotation files (relevance depends on starting step).</CardDescription> </CardHeader>
            <CardContent className="space-y-4">
              <FormField control={form.control} name="genome" render={({ field }) => ( <FormItem> <FormLabel>Reference Genome Build <span className="text-destructive">*</span></FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select genome build" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_GENOMES.map(g => ( <SelectItem key={g.value} value={g.value}> {g.label} </SelectItem> ))} </SelectContent> </Select> <FormDescription className="italic"> Select the genome assembly key (e.g., GATK.GRCh38). </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="intervals_file" render={({ field }) => ( <FormItem> <FormLabel> Intervals File <span className="text-muted-foreground text-xs"> (Optional)</span> </FormLabel> <FormControl> <FileSelector fileTypeLabel="Intervals" fileType="intervals" extensions={[".bed", ".list", ".interval_list"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select intervals file..." allowNone required={false} /> </FormControl> <FormDescription className="italic"> Target regions (e.g., for WES). Required if WES mode is checked below. </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="dbsnp" render={({ field }) => ( <FormItem> <FormLabel>dbSNP (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="dbSNP" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select dbSNP file..." allowNone /> </FormControl> <FormDescription className="italic"> Known variants VCF. Required for Base Quality Score Recalibration (BQSR) if not skipped. </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="known_indels" render={({ field }) => ( <FormItem> <FormLabel>Known Indels (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="Known Indels" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select known indels file..." allowNone /> </FormControl> <FormDescription className="italic"> Known indels VCF. Required for Base Quality Score Recalibration (BQSR) if not skipped. </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="pon" render={({ field }) => ( <FormItem> <FormLabel>Panel of Normals (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="Panel of Normals" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select Panel of Normals file..." allowNone /> </FormControl> <FormDescription className="italic"> Panel of Normals VCF. Recommended for Mutect2 somatic variant calling. </FormDescription> <FormMessage /> </FormItem> )} />
            </CardContent>
          </Card>

          {/* Parameters Card */}
          <Card>
             <CardHeader> <CardTitle className="text-primary">Pipeline Parameters</CardTitle> <CardDescription>Configure Sarek workflow options. Availability depends on Input Type and Starting Step.</CardDescription> </CardHeader>
             <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 <FormField control={form.control} name="step" render={({ field }) => ( <FormItem> <FormLabel>Starting Step <span className="text-destructive">*</span></FormLabel> <Select onValueChange={field.onChange} value={field.value} disabled={availableSteps.length <= 1} > <FormControl> <SelectTrigger> <SelectValue placeholder="Select starting step" /> </SelectTrigger> </FormControl> <SelectContent> {availableSteps.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic">Pipeline execution starting point.</FormDescription> <FormMessage /> </FormItem> )} />
                 <FormField control={form.control} name="profile" render={({ field }) => ( <FormItem> <FormLabel>Execution Profile</FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select execution profile" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_PROFILES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Container or environment system. </FormDescription> <FormMessage /> </FormItem> )} />
                 {showAligner && ( <FormField control={form.control} name="aligner" render={({ field }) => ( <FormItem> <FormLabel>Aligner</FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value || ""}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select aligner" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_ALIGNERS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Alignment algorithm (only for FASTQ input). </FormDescription> <FormMessage /> </FormItem> )} /> )}
                 {showTools && ( <div className="md:col-span-2"> <div className="mb-4"> <div className="text-base font-medium">Variant Calling Tools</div> <p className="text-sm text-muted-foreground">Select tools to run (not applicable when starting at annotation).</p> </div> <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"> {SAREK_TOOLS.map((tool) => { const uniqueId = `tool-${tool}`; const currentTools: string[] = form.watch("tools") || []; const isChecked = currentTools.includes(tool); return ( <FormItem key={uniqueId} className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-3 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor={uniqueId} className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id={uniqueId} checked={isChecked} onCheckedChange={() => toggleCheckboxValue('tools', tool)} /> </FormControl> <span className="pt-px">{tool}</span> </FormLabel> </FormItem> ); })} </div> <FormField control={form.control} name="tools" render={() => <FormMessage className="pt-2" />} /> </div> )}
                 {/* Flags Group */}
                 <div className="md:col-span-2 space-y-4">
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-wes" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-wes" checked={form.watch('wes')} onCheckedChange={() => toggleCheckboxValue('wes')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Whole Exome Sequencing (WES)</span> <FormDescription className="italic mt-1"> Check if data is WES/targeted. Requires Intervals file. </FormDescription> </div> </FormLabel> <FormField control={form.control} name="wes" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem>
                    {showTrimFastq && ( <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-trim_fastq" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-trim_fastq" checked={form.watch('trim_fastq')} onCheckedChange={() => toggleCheckboxValue('trim_fastq')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Trim FASTQ</span> <FormDescription className="italic mt-1"> Enable adapter trimming (only for FASTQ input). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="trim_fastq" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem> )}
                    {showSkipBaserecalibrator && ( <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-skip_baserecalibrator" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-skip_baserecalibrator" checked={form.watch('skip_baserecalibrator')} onCheckedChange={() => toggleCheckboxValue('skip_baserecalibrator')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Skip Base Recalibration</span> <FormDescription className="italic mt-1"> Skip BQSR step (requires dbSNP/Known Indels if not skipped). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="skip_baserecalibrator" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem> )}
                    {showJointGermline && ( <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-joint_germline" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-joint_germline" checked={form.watch('joint_germline')} onCheckedChange={() => toggleCheckboxValue('joint_germline')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Joint Germline Calling</span> <FormDescription className="italic mt-1"> Enable joint calling (not applicable if starting at annotation). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="joint_germline" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem> )}
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-skip_qc" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-skip_qc" checked={form.watch('skip_qc')} onCheckedChange={() => toggleCheckboxValue('skip_qc')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Skip QC</span> <FormDescription className="italic mt-1"> Skip quality control steps (FastQC, Samtools stats, etc.). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="skip_qc" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem>
                    {showSkipAnnotation && ( <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-skip_annotation" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-skip_annotation" checked={form.watch('skip_annotation')} onCheckedChange={() => toggleCheckboxValue('skip_annotation')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Skip Annotation</span> <FormDescription className="italic mt-1"> Skip variant annotation steps (not applicable if starting at annotation). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="skip_annotation" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem> )}
                  </div>
             </CardContent>
           </Card>

            {/* Metadata Card */}
           <Card>
                <CardHeader> <CardTitle className="text-primary">Metadata</CardTitle> </CardHeader>
                <CardContent> <FormField control={form.control} name="description" render={({ field }) => ( <FormItem> <FormLabel>Run Description <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <Input placeholder="e.g., Initial somatic analysis for Cohort X" {...field} value={field.value ?? ''}/> </FormControl> <FormMessage /> </FormItem> )} /> </CardContent>
            </Card>

            {/* Action Buttons */}
            <div className="flex justify-start items-center gap-4 px-[1%]">
                 <TooltipProvider delayDuration={100}>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span tabIndex={isStagingDisabled ? 0 : -1}>
                                <Button
                                    type="submit"
                                    disabled={isStagingDisabled}
                                    className={cn( "border border-primary hover:underline bg-primary text-primary-foreground hover:bg-primary/90", isStagingDisabled && "cursor-not-allowed opacity-50" )}
                                    aria-disabled={isStagingDisabled}
                                >
                                    {(stageMutation.isPending || saveProfileMutation.isPending)
                                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        : <Play className="mr-2 h-4 w-4" />
                                    }
                                    Stage Pipeline Run
                                </Button>
                            </span>
                        </TooltipTrigger>
                        {isStagingDisabled && (
                            <TooltipContent side="top" align="center">
                                <p className="text-sm flex items-center gap-1">
                                    <Info className="h-4 w-4"/>
                                    {getDisabledButtonTooltip()}
                                </p>
                            </TooltipContent>
                        )}
                    </Tooltip>
                 </TooltipProvider>

                 <Button type="button" variant="outline" onClick={() => setIsSaveProfileOpen(true)} disabled={stageMutation.isPending || saveProfileMutation.isPending} className="cursor-pointer" > <Save className="mr-2 h-4 w-4" /> Save Profile </Button>
             </div>
        </form>
      </Form>

       <SaveProfileDialog isOpen={isSaveProfileOpen} onOpenChange={setIsSaveProfileOpen} onSave={handleSaveProfile} isSaving={saveProfileMutation.isPending} currentProfileName={currentProfileName} />
    </FormProvider>
  );
}
