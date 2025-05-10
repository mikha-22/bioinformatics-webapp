// File: frontend_app/app/(pages)/input/page.tsx
"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import { useForm, useFieldArray, FormProvider, SubmitErrorHandler, FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z, ZodType } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { PlusCircle, Loader2, Play, Save, Info, Settings2, ChevronDown } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader, // Keep for other cards
  CardTitle,   // Keep for other cards
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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


// --- Zod Schemas (Remain Unchanged) ---
const noSpacesRegex = /^[^\s]+$/;
const laneRegex = /^L\d{3}$/;
const baseSample = { patient: z.string().min(1, "Patient ID is required").regex(noSpacesRegex, "Patient ID cannot contain spaces"), sample: z.string().min(1, "Sample ID is required").regex(noSpacesRegex, "Sample ID cannot contain spaces"), sex: z.enum(["XX", "XY", "X", "Y", "other"], { required_error: "Sex is required" }), status: z.union([z.literal(0), z.literal(1)], { required_error: "Status is required" }), };
const fastqSampleSchema = z.object({ ...baseSample, lane: z.string().min(1, "Lane is required").regex(laneRegex, "Lane must be in format L001"), fastq_1: z.string().min(1, "FASTQ R1 is required"), fastq_2: z.string().min(1, "FASTQ R2 is required"), bam_cram: z.union([z.string().length(0, "Cannot provide BAM/CRAM for FASTQ input"), z.null(), z.undefined()]).optional(), vcf: z.union([z.string().length(0, "Cannot provide VCF for FASTQ input"), z.null(), z.undefined()]).optional(), index: z.union([z.string().length(0, "Cannot provide Index for FASTQ input"), z.null(), z.undefined()]).optional(), });
const bamCramSampleSchema = z.object({ ...baseSample, bam_cram: z.string().min(1, "BAM/CRAM file is required").refine(f => f.endsWith('.bam') || f.endsWith('.cram'), "Must be a .bam or .cram file"), index: z.string().optional().nullable(), lane: z.union([z.string().length(0, "Lane not applicable for BAM/CRAM"), z.null(), z.undefined()]).optional(), fastq_1: z.union([z.string().length(0, "FASTQ not applicable for BAM/CRAM"), z.null(), z.undefined()]).optional(), fastq_2: z.union([z.string().length(0, "FASTQ not applicable for BAM/CRAM"), z.null(), z.undefined()]).optional(), vcf: z.union([z.string().length(0, "Cannot provide VCF for BAM/CRAM input"), z.null(), z.undefined()]).optional(), }).refine(data => !(data.bam_cram?.endsWith('.cram') && !data.index), { message: "An index file (.crai) must be provided for CRAM input.", path: ["index"], }).refine(data => { if (!data.index || !data.bam_cram) return true; if (data.bam_cram.endsWith('.cram') && !data.index.endsWith('.crai')) return false; if (data.bam_cram.endsWith('.bam') && !data.index.endsWith('.bai')) return false; return true; }, { message: "Index extension mismatch: use .bai for .bam, .crai for .cram.", path: ["index"],});
const vcfSampleSchema = z.object({ ...baseSample, vcf: z.string().min(1, "VCF file is required").refine(f => f.endsWith('.vcf') || f.endsWith('.vcf.gz'), "Must be a .vcf or .vcf.gz file"), index: z.string().optional().nullable(), lane: z.union([z.string().length(0, "Lane not applicable for VCF"), z.null(), z.undefined()]).optional(), fastq_1: z.union([z.string().length(0, "FASTQ not applicable for VCF"), z.null(), z.undefined()]).optional(), fastq_2: z.union([z.string().length(0, "FASTQ not applicable for VCF"), z.null(), z.undefined()]).optional(), bam_cram: z.union([z.string().length(0, "Cannot provide BAM/CRAM for VCF input"), z.null(), z.undefined()]).optional(), }).refine(data => !(data.vcf?.endsWith('.vcf.gz') && !data.index), { message: "An index file (.tbi/.csi) must be provided for compressed VCF (.vcf.gz) input.", path: ["index"], }).refine(data => { if (!data.index) return true; return data.index.endsWith('.tbi') || data.index.endsWith('.csi'); }, { message: "Index file must end with .tbi or .csi.", path: ["index"],});
const ALL_SAREK_STEPS = ["mapping", "markduplicates", "prepare_recalibration", "recalibrate", "variant_calling", "annotation"] as const;
type SarekStep = typeof ALL_SAREK_STEPS[number];
const SAREK_TOOLS = ["strelka", "mutect2", "freebayes", "mpileup", "vardict", "manta", "cnvkit"];
const SAREK_PROFILES = ["docker", "singularity", "conda", "podman"];
const SAREK_GENOMES = [ { value: "GATK.GRCh38", label: "GRCh38 (GATK Bundle)" }, { value: "GATK.GRCh37", label: "GRCh37 (GATK Bundle)" }, { value: "hg38", label: "hg38 (UCSC)" }, { value: "hg19", label: "hg19 (UCSC)" }, ];
const VALID_GENOME_VALUES = SAREK_GENOMES.map(g => g.value) as [string, ...string[]];
const SAREK_ALIGNERS = ["bwa-mem", "dragmap"];
const SOMATIC_TOOLS = ["mutect2", "strelka"];
const STEPS_FOR_INPUT_TYPE: Record<'fastq' | 'bam_cram' | 'vcf', SarekStep[]> = { fastq: ["mapping"], bam_cram: ["markduplicates", "prepare_recalibration", "recalibrate", "variant_calling"], vcf: ["annotation"], };
const fastqPipelineSchemaBase = z.object({ input_type: z.literal('fastq'), samples: z.array(fastqSampleSchema).min(1, "At least one sample is required for FASTQ input."), genome: z.enum(VALID_GENOME_VALUES, { required_error: "Genome build is required" }), step: z.enum(['mapping'], { required_error: "Starting step is required for FASTQ input." }), intervals_file: z.string().optional().refine((val) => !val || val === "" || val.endsWith('.bed') || val.endsWith('.list') || val.endsWith('.interval_list'), { message: "Intervals file must end with .bed, .list, or .interval_list" }), dbsnp: z.string().optional(), known_indels: z.string().optional(), pon: z.string().optional(), tools: z.array(z.string()).default([]), profile: z.enum(SAREK_PROFILES as [string, ...string[]]).default("docker"), aligner: z.enum(SAREK_ALIGNERS as [string, ...string[]]).optional().default("bwa-mem"), joint_germline: z.boolean().default(false), wes: z.boolean().default(false), trim_fastq: z.boolean().default(false), skip_qc: z.boolean().default(false), skip_annotation: z.boolean().default(false), skip_baserecalibrator: z.boolean().default(false), description: z.string().optional(), });
const bamCramPipelineSchemaBase = z.object({ input_type: z.literal('bam_cram'), samples: z.array(bamCramSampleSchema).min(1, "At least one sample is required for BAM/CRAM input."), genome: z.enum(VALID_GENOME_VALUES, { required_error: "Genome build is required" }), step: z.enum(["markduplicates", "prepare_recalibration", "recalibrate", "variant_calling"]), intervals_file: z.string().optional().refine((val) => !val || val === "" || val.endsWith('.bed') || val.endsWith('.list') || val.endsWith('.interval_list'), { message: "Intervals file must end with .bed, .list, or .interval_list" }), dbsnp: z.string().optional(), known_indels: z.string().optional(), pon: z.string().optional(), tools: z.array(z.string()).default([]), profile: z.enum(SAREK_PROFILES as [string, ...string[]]).default("docker"), aligner: z.union([z.string().length(0), z.null(), z.undefined()]).optional(), joint_germline: z.boolean().default(false), wes: z.boolean().default(false), trim_fastq: z.boolean().default(false), skip_qc: z.boolean().default(false), skip_annotation: z.boolean().default(false), skip_baserecalibrator: z.boolean().default(false), description: z.string().optional(), });
const vcfPipelineSchemaBase = z.object({ input_type: z.literal('vcf'), samples: z.array(vcfSampleSchema).min(1, "At least one sample is required for VCF input."), genome: z.enum(VALID_GENOME_VALUES, { required_error: "Genome build is required" }), step: z.enum(['annotation'], { required_error: "Starting step is required for VCF input." }), intervals_file: z.string().optional().refine((val) => !val || val === "" || val.endsWith('.bed') || val.endsWith('.list') || val.endsWith('.interval_list'), { message: "Intervals file must end with .bed, .list, or .interval_list" }), dbsnp: z.string().optional(), known_indels: z.string().optional(), pon: z.string().optional(), tools: z.array(z.string()).default([]), profile: z.enum(SAREK_PROFILES as [string, ...string[]]).default("docker"), aligner: z.union([z.string().length(0), z.null(), z.undefined()]).optional(), joint_germline: z.boolean().default(false), wes: z.boolean().default(false), trim_fastq: z.boolean().default(false), skip_qc: z.boolean().default(false), skip_annotation: z.boolean().default(false), skip_baserecalibrator: z.boolean().default(false), description: z.string().optional(), });
const pipelineInputSchema = z.discriminatedUnion("input_type", [ fastqPipelineSchemaBase, bamCramPipelineSchemaBase, vcfPipelineSchemaBase, ]) .superRefine((data, ctx) => { const isBqsrRelevant = data.input_type !== 'vcf' && data.step !== 'variant_calling' && data.step !== 'annotation'; const isBqsrEnabled = !data.skip_baserecalibrator; const missingBqsrFiles = !data.dbsnp && !data.known_indels; if (isBqsrRelevant && isBqsrEnabled && missingBqsrFiles) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "dbSNP or Known Indels file required if BQSR not skipped.", path: ["dbsnp"] }); ctx.addIssue({ code: z.ZodIssueCode.custom, message: "dbSNP or Known Indels file required.", path: ["skip_baserecalibrator"] }); } if (data.step !== 'annotation') { const toolsToCheck = data.tools ?? []; const selectedSomaticTools = toolsToCheck.filter(tool => SOMATIC_TOOLS.includes(tool)); if (selectedSomaticTools.length > 0) { const hasTumorSample = data.samples.some(sample => sample.status === 1); if (!hasTumorSample) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Somatic tool(s) selected (${selectedSomaticTools.join(', ')}) require at least one sample with Status = 1 (Tumor).`, path: ["tools"] }); ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Tumor sample required for selected somatic tool(s).`, path: ["samples"] }); } } } if (data.input_type === 'fastq') { if (data.aligner && !SAREK_ALIGNERS.includes(data.aligner)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid aligner selected.", path: ["aligner"] }); } } if (data.input_type === 'bam_cram') { if (data.trim_fastq) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Trim FASTQ' not applicable for BAM/CRAM input", path: ["trim_fastq"] }); } if (data.aligner && data.aligner.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Aligner not applicable for BAM/CRAM input", path: ["aligner"] }); } if (data.skip_baserecalibrator && (data.step === 'variant_calling')) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Base Recalibration' not applicable when starting at variant calling.", path: ["skip_baserecalibrator"] }); } } if (data.input_type === 'vcf') { if (data.trim_fastq) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Trim FASTQ' not applicable for VCF input", path: ["trim_fastq"] }); } if (data.aligner && data.aligner.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Aligner not applicable for VCF input", path: ["aligner"] }); } if (data.skip_baserecalibrator) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Base Recalibration' not applicable for VCF input", path: ["skip_baserecalibrator"] }); } if (data.tools.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Variant calling tools not applicable for VCF input", path: ["tools"] }); } if (data.skip_annotation) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Skip Annotation' not applicable when starting at annotation", path: ["skip_annotation"] }); } if (data.joint_germline) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'Joint Germline' not applicable when starting at annotation", path: ["joint_germline"] }); } } });
type PipelineFormValues = z.infer<typeof pipelineInputSchema>;
type InputType = PipelineFormValues['input_type'];
const ADVANCED_FIELD_NAMES: (keyof PipelineFormValues)[] = [ 'tools', 'profile', 'aligner', 'pon', 'trim_fastq', 'joint_germline', 'skip_qc', 'skip_annotation'];
// --- End Zod Schema & Constants ---

export default function InputPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isSaveProfileOpen, setIsSaveProfileOpen] = useState(false);
  const [currentProfileName, setCurrentProfileName] = useState<string | null>(null);
  const [selectedInputType, setSelectedInputType] = useState<InputType>('fastq');
  const formRef = useRef<HTMLFormElement>(null);
  const [advancedAccordionValue, setAdvancedAccordionValue] = useState<string | undefined>(undefined);

  const form = useForm<PipelineFormValues>({
    resolver: zodResolver(pipelineInputSchema),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: {
      input_type: 'fastq', samples: [{ patient: "", sample: "", sex: undefined, status: undefined, lane: "L001", fastq_1: "", fastq_2: "" }], genome: "GATK.GRCh38", step: "mapping", intervals_file: "", dbsnp: "", known_indels: "", pon: "", tools: [], profile: "docker", aligner: "bwa-mem", joint_germline: false, wes: false, trim_fastq: false, skip_qc: false, skip_annotation: false, skip_baserecalibrator: false, description: "",
    },
  });

  useEffect(() => { /* console.log("Initial form values:", form.getValues()); console.log("Initial step value:", form.getValues('step')); */ }, [form]);

  const watchedInputType = form.watch('input_type');
  const watchedStep = form.watch('step');
  const watchedSkipBqsr = form.watch('skip_baserecalibrator');
  const watchedDbsnp = form.watch('dbsnp');
  const watchedKnownIndels = form.watch('known_indels');
  const watchedTools = form.watch('tools');
  const watchedSamples = form.watch('samples');

  useEffect(() => {
      if (watchedInputType !== selectedInputType) {
          setSelectedInputType(watchedInputType);
          let defaultSample: Partial<ApiSampleInfo> = {};
          if (watchedInputType === 'fastq') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, lane: "L001", fastq_1: "", fastq_2: "" }; }
          else if (watchedInputType === 'bam_cram') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, bam_cram: "", index: "" }; }
          else if (watchedInputType === 'vcf') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, vcf: "", index: "" }; }
          const currentValues = form.getValues();
          const newDefaultValues: Partial<PipelineFormValues> = { genome: currentValues.genome || "GATK.GRCh38", profile: currentValues.profile || "docker", wes: currentValues.wes || false, skip_qc: currentValues.skip_qc || false, description: currentValues.description || "", intervals_file: currentValues.intervals_file || "", dbsnp: currentValues.dbsnp || "", known_indels: currentValues.known_indels || "", pon: currentValues.pon || "", input_type: watchedInputType, samples: [defaultSample as ApiSampleInfo], step: STEPS_FOR_INPUT_TYPE[watchedInputType][0], aligner: watchedInputType === 'fastq' ? (currentValues.aligner || 'bwa-mem') : '', trim_fastq: watchedInputType === 'fastq' ? (currentValues.trim_fastq || false) : false, tools: watchedInputType === 'vcf' ? [] : (currentValues.tools || []), skip_annotation: watchedInputType === 'vcf' ? false : (currentValues.skip_annotation || false), skip_baserecalibrator: watchedInputType === 'vcf' ? false : (currentValues.skip_baserecalibrator || false), joint_germline: watchedInputType === 'vcf' ? false : (currentValues.joint_germline || false), };
          form.reset(newDefaultValues as PipelineFormValues);
          setCurrentProfileName(null);
          setAdvancedAccordionValue(undefined);
      }
  }, [watchedInputType, form, selectedInputType]);

  const { fields, append, remove } = useFieldArray({ control: form.control, name: "samples", });
  const availableSteps = useMemo(() => STEPS_FOR_INPUT_TYPE[selectedInputType] || [], [selectedInputType]);

  const showAligner = selectedInputType === 'fastq';
  const showTrimFastq = selectedInputType === 'fastq';
  const showSkipBaserecalibrator = selectedInputType !== 'vcf' && watchedStep !== 'variant_calling' && watchedStep !== 'annotation';
  const showTools = selectedInputType !== 'vcf' && watchedStep !== 'annotation';
  const showSkipAnnotation = selectedInputType !== 'vcf' && watchedStep !== 'annotation';
  const showJointGermline = selectedInputType !== 'vcf' && watchedStep !== 'annotation';

  const stageMutation = useMutation({ mutationFn: (values: PipelineInput) => api.stagePipelineJob(values), onSuccess: (data) => { toast.success(`Job staged successfully: ${data.staged_job_id}`); queryClient.invalidateQueries({ queryKey: ['jobsList'] }); form.reset(); setSelectedInputType('fastq'); setCurrentProfileName(null); setAdvancedAccordionValue(undefined); router.push('/jobs'); }, onError: (error) => { let message = `Failed to stage job: ${error.message}`; const detail = (error as any).originalError?.response?.data?.detail; if (detail) { message = `Failed to stage job: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`; } else { message = `Failed to stage job: ${error.message}`; } toast.error(message, { duration: 10000 }); scrollToFirstError(form.formState.errors); } });
  const saveProfileMutation = useMutation({ mutationFn: ({ name, data }: { name: string; data: ProfileData }) => api.saveProfile(name, data), onSuccess: (data) => { toast.success(`Profile '${data.profile_name}' saved successfully.`); queryClient.invalidateQueries({ queryKey: ['profilesList'] }); setCurrentProfileName(data.profile_name); setIsSaveProfileOpen(false); }, onError: (error: Error, variables) => { toast.error(`Failed to save profile '${variables.name}': ${error.message}`); }, });
  const isBqsrRelevantForButton = watchedInputType !== 'vcf' && watchedStep !== 'variant_calling' && watchedStep !== 'annotation';
  const isBqsrEnabledForButton = !watchedSkipBqsr;
  const missingBqsrFilesForButton = !watchedDbsnp && !watchedKnownIndels;
  const isBqsrCheckFailedForButton = isBqsrRelevantForButton && isBqsrEnabledForButton && missingBqsrFilesForButton;
  const isSomaticToolSelected = watchedTools?.some(tool => SOMATIC_TOOLS.includes(tool)) ?? false;
  const hasTumorSample = watchedSamples?.some(sample => sample.status === 1) ?? false;
  const isSomaticTumorCheckFailedForButton = isSomaticToolSelected && !hasTumorSample && watchedStep !== 'annotation';
  const isStagingDisabled = stageMutation.isPending || saveProfileMutation.isPending || isBqsrCheckFailedForButton || isSomaticTumorCheckFailedForButton;
  const getDisabledButtonTooltip = (): string | undefined => { if (isBqsrCheckFailedForButton) { return "BQSR requires dbSNP or Known Indels file unless skipped."; } if (isSomaticTumorCheckFailedForButton) { return "Selected somatic tool(s) require at least one Tumor sample (Status=1)."; } if (stageMutation.isPending || saveProfileMutation.isPending) { return "Operation in progress..."; } return undefined; };

  function onSubmit(values: PipelineFormValues) { const apiPayload: PipelineInput = { input_type: values.input_type, samples: values.samples.map((s): ApiSampleInfo => ({ patient: s.patient, sample: s.sample, sex: s.sex!, status: s.status!, lane: s.lane || null, fastq_1: s.fastq_1 || null, fastq_2: s.fastq_2 || null, bam_cram: s.bam_cram || null, index: s.index || null, vcf: s.vcf || null, })), genome: values.genome, step: values.step, intervals_file: values.intervals_file || undefined, dbsnp: values.dbsnp || undefined, known_indels: values.known_indels || undefined, pon: values.pon || undefined, tools: showTools && values.tools && values.tools.length > 0 ? values.tools : undefined, profile: values.profile, aligner: showAligner ? (values.aligner || undefined) : undefined, joint_germline: showJointGermline ? values.joint_germline : undefined, wes: values.wes, trim_fastq: showTrimFastq ? values.trim_fastq : undefined, skip_qc: values.skip_qc, skip_annotation: showSkipAnnotation ? values.skip_annotation : undefined, skip_baserecalibrator: showSkipBaserecalibrator ? values.skip_baserecalibrator : undefined, description: values.description || undefined, }; stageMutation.mutate(apiPayload); }
  const isAdvancedField = (fieldName: string): boolean => ADVANCED_FIELD_NAMES.some(advField => fieldName.startsWith(advField as string));
  const scrollToFirstError = (errors: FieldErrors<PipelineFormValues>) => { const errorKeys = Object.keys(errors); if (errorKeys.length > 0) { let firstErrorKey = errorKeys[0] as keyof PipelineFormValues | 'samples'; let fieldNameToQuery = firstErrorKey as string; if (firstErrorKey === 'samples') { const samplesCardHeader = formRef.current?.querySelector('#samples-card-header'); if (samplesCardHeader && errors.samples?.root) { samplesCardHeader.scrollIntoView({ behavior: "smooth", block: "center" }); return; } if (Array.isArray(errors.samples)) { const firstSampleErrorIndex = errors.samples.findIndex(s => s && Object.keys(s).length > 0); if (firstSampleErrorIndex !== -1) { const sampleErrors = errors.samples[firstSampleErrorIndex]; if (sampleErrors) { const firstSampleFieldError = Object.keys(sampleErrors)[0] as keyof ApiSampleInfo; fieldNameToQuery = `samples.${firstSampleErrorIndex}.${firstSampleFieldError}`; } } } else { fieldNameToQuery = 'samples.0.patient';} } const attemptScroll = () => { let element = formRef.current?.querySelector(`[name="${fieldNameToQuery}"]`); if (!element) { const errorPathParts = fieldNameToQuery.split('.'); let selector = `#${errorPathParts.join('-')}-form-item`; element = formRef.current?.querySelector(selector); if (!element) { element = formRef.current?.querySelector(`label[for="${fieldNameToQuery}"]`);} if (!element && fieldNameToQuery === 'step') { element = formRef.current?.querySelector('button[role="combobox"][aria-controls*="radix"][id*="step"]'); } if (!element && fieldNameToQuery.startsWith('samples.')) { const sampleIndexMatch = fieldNameToQuery.match(/samples\.(\d+)\./); if (sampleIndexMatch && sampleIndexMatch[1]) { const errorSampleIndex = parseInt(sampleIndexMatch[1], 10); const sampleCard = formRef.current?.querySelectorAll('div[class*="relative border border-border pt-8"]')[errorSampleIndex]; if(sampleCard) element = sampleCard as HTMLElement;} } } if (element) { element.scrollIntoView({ behavior: "smooth", block: "center" }); } else { formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); } }; if (isAdvancedField(fieldNameToQuery) && advancedAccordionValue !== "advanced-sarek-options") { setAdvancedAccordionValue("advanced-sarek-options"); requestAnimationFrame(attemptScroll); } else { attemptScroll(); } } };
  const onFormError: SubmitErrorHandler<PipelineFormValues> = (errorsArgument) => { console.warn("Form validation failed."); toast.error("Please fix the validation errors.", { duration: 5000 }); scrollToFirstError(errorsArgument); };
  const toggleCheckboxValue = (fieldName: keyof PipelineFormValues | 'tools', tool?: string) => { if (fieldName === 'tools' && tool) { const currentVal = form.getValues("tools") ?? []; const newVal = currentVal.includes(tool) ? currentVal.filter((t) => t !== tool) : [...currentVal, tool]; form.setValue("tools", newVal, { shouldValidate: true, shouldDirty: true }); } else if (fieldName !== 'tools') { const fieldKey = fieldName as keyof PipelineFormValues; if (fieldKey in form.getValues()) { const currentVal = form.getValues(fieldKey); form.setValue(fieldKey, !currentVal, { shouldValidate: true, shouldDirty: true }); } } };
  const handleProfileLoaded = (name: string | null, data: ProfileData | null) => { setCurrentProfileName(name); let shouldOpenAdvanced = false; const currentFormDefaults = form.formState.defaultValues || {}; if (data) { let loadedInputType: InputType = 'fastq'; if (data.step === 'mapping') loadedInputType = 'fastq'; else if (STEPS_FOR_INPUT_TYPE.bam_cram.includes(data.step as SarekStep)) loadedInputType = 'bam_cram'; else if (data.step === 'annotation') loadedInputType = 'vcf'; const currentFormInputType = form.getValues('input_type'); if (loadedInputType !== currentFormInputType) { toast.info(`Profile '${name}' uses ${loadedInputType.toUpperCase()} input. Switching input type and applying settings.`); (formRef.current as any)._profileToApplyAfterReset = data; form.setValue('input_type', loadedInputType, { shouldValidate: true }); } else { Object.entries(data).forEach(([key, value]) => { const fieldKey = key as keyof ProfileData; if (fieldKey in form.getValues()) { form.setValue(fieldKey as any, value !== null ? value : (currentFormDefaults as any)[fieldKey], { shouldValidate: true, shouldDirty: true }); if (ADVANCED_FIELD_NAMES.includes(fieldKey as keyof PipelineFormValues) && value !== null) { const defaultValueForField = (currentFormDefaults as any)[fieldKey]; if (Array.isArray(value) && Array.isArray(defaultValueForField)) { if (value.length !== defaultValueForField.length || !value.every(v => defaultValueForField.includes(v))) { shouldOpenAdvanced = true; } } else if (value !== defaultValueForField) { shouldOpenAdvanced = true; } } } }); setAdvancedAccordionValue(shouldOpenAdvanced ? "advanced-sarek-options" : undefined); } } else { form.reset(); setSelectedInputType('fastq'); setAdvancedAccordionValue(undefined); } };
  useEffect(() => { if ((formRef.current as any)?._profileToApplyAfterReset) { const dataToApply = (formRef.current as any)._profileToApplyAfterReset as ProfileData; let shouldOpenAdvancedAfterReset = false; const currentFormDefaultsAfterReset = form.formState.defaultValues || {}; Object.entries(dataToApply).forEach(([key, value]) => { const fieldKey = key as keyof ProfileData; if (fieldKey in form.getValues()) { form.setValue(fieldKey as any, value !== null ? value : (currentFormDefaultsAfterReset as any)[fieldKey], { shouldValidate: true, shouldDirty: true }); if (ADVANCED_FIELD_NAMES.includes(fieldKey as keyof PipelineFormValues) && value !== null) { const defaultValueForField = (currentFormDefaultsAfterReset as any)[fieldKey]; if (Array.isArray(value) && Array.isArray(defaultValueForField)) { if (value.length !== defaultValueForField.length || !value.every(v => defaultValueForField.includes(v))) { shouldOpenAdvancedAfterReset = true; } } else if (value !== defaultValueForField) { shouldOpenAdvancedAfterReset = true; } } } }); setAdvancedAccordionValue(shouldOpenAdvancedAfterReset ? "advanced-sarek-options" : undefined); delete (formRef.current as any)._profileToApplyAfterReset; } }, [form.formState.isSubmitSuccessful]);
  const handleSaveProfile = async (profileName: string) => { const currentValues = form.getValues(); const profileData: ProfileData = { genome: currentValues.genome, step: currentValues.step, intervals_file: currentValues.intervals_file || null, dbsnp: currentValues.dbsnp || null, known_indels: currentValues.known_indels || null, pon: currentValues.pon || null, tools: (showTools && currentValues.tools && currentValues.tools.length > 0 ? currentValues.tools : null), profile: currentValues.profile, aligner: (showAligner ? (currentValues.aligner || null) : null), joint_germline: (showJointGermline ? currentValues.joint_germline : null), wes: currentValues.wes, trim_fastq: (showTrimFastq ? currentValues.trim_fastq : null), skip_qc: currentValues.skip_qc, skip_annotation: (showSkipAnnotation ? currentValues.skip_annotation : null), skip_baserecalibrator: (showSkipBaserecalibrator ? currentValues.skip_baserecalibrator : null), description: currentValues.description || null, }; await saveProfileMutation.mutateAsync({ name: profileName, data: profileData }); };
  const addSample = () => { let defaultSample: Partial<ApiSampleInfo> = {}; if (selectedInputType === 'fastq') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, lane: "L001", fastq_1: "", fastq_2: "" }; } else if (selectedInputType === 'bam_cram') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, bam_cram: "", index: "" }; } else if (selectedInputType === 'vcf') { defaultSample = { patient: "", sample: "", sex: undefined, status: undefined, vcf: "", index: "" }; } append(defaultSample); };

  return (
    <FormProvider {...form}>
      <Form {...form}>
        <form ref={formRef} onSubmit={form.handleSubmit(onSubmit, onFormError)} className="space-y-8">
          <h1 className="text-3xl font-bold mb-6 ml-2">Stage New Sarek Run</h1>

           <Card>
             <CardHeader> <CardTitle className="text-xl">Input & Configuration</CardTitle> <CardDescription>Select the type of input data and load any saved configurations.</CardDescription> </CardHeader>
             <CardContent className="space-y-6">
                 <FormField control={form.control} name="input_type" render={({ field }) => ( <FormItem> <FormLabel>Input Data Type</FormLabel> <Select onValueChange={field.onChange} value={field.value}> <FormControl> <SelectTrigger className="w-full sm:w-64"> <SelectValue placeholder="Select input data type..." /> </SelectTrigger> </FormControl> <SelectContent> <SelectItem value="fastq">Raw Reads (FASTQ)</SelectItem> <SelectItem value="bam_cram">Aligned Reads (BAM/CRAM)</SelectItem> <SelectItem value="vcf">Variant Calls (VCF)</SelectItem> </SelectContent> </Select> <FormDescription>Determines the required sample information and available starting steps.</FormDescription> <FormMessage /> </FormItem> )} />
                 <ProfileLoader form={form} currentProfileName={currentProfileName} onProfileLoad={handleProfileLoaded} currentInputType={selectedInputType} />
             </CardContent>
           </Card>

          <Card>
            <CardHeader id="samples-card-header"> <CardTitle className="text-xl">Sample Information</CardTitle> <CardDescription> {selectedInputType === 'fastq' && "Provide FASTQ file pairs and lane information."} {selectedInputType === 'bam_cram' && "Provide coordinate-sorted BAM or CRAM files (and index for CRAM)."} {selectedInputType === 'vcf' && "Provide VCF files (and index for compressed VCFs)."} {" Status 0 = Normal, 1 = Tumor. IDs cannot contain spaces."} </CardDescription> </CardHeader>
            <CardContent className="space-y-4">
              {fields.map((field, index) => { if (selectedInputType === 'fastq') { return <SampleInputGroup key={field.id} index={index} remove={remove} control={form.control as Control<any>} />; } else if (selectedInputType === 'bam_cram') { return <BamCramSampleInputGroup key={field.id} index={index} remove={remove} control={form.control as Control<any>} />; } else if (selectedInputType === 'vcf') { return <VcfSampleInputGroup key={field.id} index={index} remove={remove} control={form.control as Control<any>} />; } return null; })}
               <Button type="button" variant="outline" size="sm" onClick={addSample} className="mt-2 cursor-pointer" > <PlusCircle className="mr-2 h-4 w-4" /> Add Sample </Button>
               <FormMessage>{form.formState.errors.samples?.root?.message}</FormMessage>
               {Array.isArray(form.formState.errors.samples) && form.formState.errors.samples.map((sampleError, index) => (sampleError && Object.values(sampleError).map((err: any, i) => ( err?.message && <FormMessage key={`${index}-${i}`} className="text-xs pl-2">{`Sample ${index + 1}: ${err.message}`}</FormMessage> )) ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader> <CardTitle className="text-xl">Core Pipeline Setup</CardTitle> <CardDescription>Essential parameters for the Sarek pipeline run.</CardDescription> </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-6">
                <FormField control={form.control} name="description" render={({ field }) => ( <FormItem className="md:col-span-2"> <FormLabel>Run Description <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <Input placeholder="e.g., Initial somatic analysis for Cohort X" {...field} value={field.value ?? ''}/> </FormControl> <FormMessage /> </FormItem> )} />
                <FormField control={form.control} name="genome" render={({ field }) => ( <FormItem> <FormLabel>Reference Genome Build <span className="text-destructive">*</span></FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select genome build" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_GENOMES.map(g => ( <SelectItem key={g.value} value={g.value}> {g.label} </SelectItem> ))} </SelectContent> </Select> <FormDescription className="italic"> Select the genome assembly key. </FormDescription> <FormMessage /> </FormItem> )} />
                <FormField control={form.control} name="step" render={({ field }) => ( <FormItem id="step-form-item"> <FormLabel>Starting Step <span className="text-destructive">*</span></FormLabel> <Select onValueChange={field.onChange} value={field.value} disabled={availableSteps.length <= 1} > <FormControl> <SelectTrigger id="step"> <SelectValue placeholder="Select starting step" /> </SelectTrigger> </FormControl> <SelectContent> {availableSteps.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic">Pipeline execution starting point.</FormDescription> <FormMessage /> </FormItem> )} />
                <FormItem className="flex flex-row items-center space-x-3 space-y-0 rounded-md border p-4 md:col-span-2 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-wes" className="flex flex-row items-center space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-center"> <Checkbox id="flag-wes" checked={form.watch('wes')} onCheckedChange={() => toggleCheckboxValue('wes')} /> </FormControl> <div className="space-y-1 leading-none"> <span>Whole Exome Sequencing (WES)</span> <FormDescription className="italic mt-1"> Check if data is WES/targeted. Providing an Intervals file is recommended. </FormDescription> </div> </FormLabel> <FormField control={form.control} name="wes" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem>
                <FormField control={form.control} name="intervals_file" render={({ field }) => ( <FormItem className="md:col-span-2"> <FormLabel> Intervals File <span className="text-muted-foreground text-xs"> (Optional for WES/Targeted)</span> </FormLabel> <FormControl> <FileSelector fileTypeLabel="Intervals" fileType="intervals" extensions={[".bed", ".list", ".interval_list"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select intervals file..." allowNone required={false} /> </FormControl> <FormDescription className="italic"> Target regions. </FormDescription> <FormMessage /> </FormItem> )} />
                {showSkipBaserecalibrator && ( <FormItem className="flex flex-row items-center space-x-3 space-y-0 rounded-md border p-4 md:col-span-2 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-skip_baserecalibrator" className="flex flex-row items-center space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-center"> <Checkbox id="flag-skip_baserecalibrator" checked={form.watch('skip_baserecalibrator')} onCheckedChange={() => toggleCheckboxValue('skip_baserecalibrator')} /> </FormControl> <div className="space-y-1 leading-none"> <span>Skip Base Recalibration (BQSR)</span> <FormDescription className="italic mt-1"> (If unchecked, dbSNP or Known Indels file is required below). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="skip_baserecalibrator" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem> )}
                {showSkipBaserecalibrator && !form.watch('skip_baserecalibrator') && ( <> <FormField control={form.control} name="dbsnp" render={({ field }) => ( <FormItem> <FormLabel>dbSNP (VCF/VCF.GZ) <span className={cn(!watchedSkipBqsr && "text-destructive")}>*</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="dbSNP" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select dbSNP file..." allowNone /> </FormControl> <FormMessage /> </FormItem> )} /> <FormField control={form.control} name="known_indels" render={({ field }) => ( <FormItem> <FormLabel>Known Indels (VCF/VCF.GZ) <span className={cn(!watchedSkipBqsr && "text-destructive")}>*</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="Known Indels" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select known indels file..." allowNone /> </FormControl> <FormMessage /> </FormItem> )} /> <FormDescription className="md:col-span-2 text-xs italic -mt-4">At least one (dbSNP or Known Indels) is required for BQSR.</FormDescription> </> )}
            </CardContent>
          </Card>

          {/* Advanced Sarek Parameters Card with Accordion */}
            <Card className="overflow-hidden">
                <Accordion type="single" collapsible className="w-full" value={advancedAccordionValue} onValueChange={setAdvancedAccordionValue}>
                    <AccordionItem value="advanced-sarek-options" className="border-0">
                        <AccordionTrigger className="flex w-full items-center justify-between p-6 hover:bg-accent/50 hover:no-underline data-[state=open]:border-b data-[state=open]:pb-[calc(1.5rem-1px)] data-[state=closed]:pb-6 cursor-pointer">
                            {/* Content for the trigger */}
                            <div className="flex-grow text-left">
                                <h3 className="text-xl font-semibold leading-none tracking-tight">Advanced Sarek Parameters</h3>
                                <p className="text-sm text-muted-foreground mt-1">Optional parameters to fine-tune the pipeline. Click to expand.</p>
                            </div>
                            {/* Chevron Icon - Manually controlled for rotation to ensure it's part of the trigger's flex layout */}
                            <ChevronDown
                                className={cn(
                                    "h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 ml-4", // Added ml-4 for spacing
                                    advancedAccordionValue === "advanced-sarek-options" && "rotate-180"
                                )}
                            />
                        </AccordionTrigger>
                        <AccordionContent>
                            <div className="p-6 pt-4 space-y-6 border-t">
                                {showTools && (
                                    <div>
                                        <div className="mb-4">
                                            <FormLabel className="text-base font-medium">Variant Calling Tools</FormLabel>
                                            <FormDescription className="text-sm text-muted-foreground">Select tools to run (not applicable when starting at annotation).</FormDescription>
                                        </div>
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                                            {SAREK_TOOLS.map((tool) => { const uniqueId = `tool-${tool}`; const currentTools: string[] = form.watch("tools") || []; const isChecked = currentTools.includes(tool); return ( <FormItem key={uniqueId} className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-3 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor={uniqueId} className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id={uniqueId} checked={isChecked} onCheckedChange={() => toggleCheckboxValue('tools', tool)} /> </FormControl> <span className="pt-px">{tool}</span> </FormLabel> </FormItem> ); })}
                                        </div>
                                        <FormField control={form.control} name="tools" render={() => <FormMessage className="pt-2" />} />
                                    </div>
                                )}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-6">
                                    <FormField control={form.control} name="profile" render={({ field }) => ( <FormItem> <FormLabel>Execution Profile</FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select execution profile" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_PROFILES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Container or environment system. </FormDescription> <FormMessage /> </FormItem> )} />
                                    {showAligner && ( <FormField control={form.control} name="aligner" render={({ field }) => ( <FormItem> <FormLabel>Aligner</FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value || ""}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select aligner" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_ALIGNERS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Alignment algorithm (only for FASTQ input). </FormDescription> <FormMessage /> </FormItem> )} /> )}
                                    <FormField control={form.control} name="pon" render={({ field }) => ( <FormItem className="md:col-span-2"> <FormLabel>Panel of Normals (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="Panel of Normals" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select Panel of Normals file..." allowNone /> </FormControl> <FormDescription className="italic"> Recommended for Mutect2 somatic variant calling. </FormDescription> <FormMessage /> </FormItem> )} />
                                </div>
                                <div className="space-y-4">
                                    {showTrimFastq && ( <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-adv-trim_fastq" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-adv-trim_fastq" checked={form.watch('trim_fastq')} onCheckedChange={() => toggleCheckboxValue('trim_fastq')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Trim FASTQ</span> <FormDescription className="italic mt-1"> Enable adapter trimming (only for FASTQ input). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="trim_fastq" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem> )}
                                    {showJointGermline && ( <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-adv-joint_germline" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-adv-joint_germline" checked={form.watch('joint_germline')} onCheckedChange={() => toggleCheckboxValue('joint_germline')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Joint Germline Calling</span> <FormDescription className="italic mt-1"> Enable joint calling (not applicable if starting at annotation). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="joint_germline" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem> )}
                                    <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-adv-skip_qc" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-adv-skip_qc" checked={form.watch('skip_qc')} onCheckedChange={() => toggleCheckboxValue('skip_qc')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Skip QC</span> <FormDescription className="italic mt-1"> Skip quality control steps (FastQC, Samtools stats, etc.). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="skip_qc" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem>
                                    {showSkipAnnotation && ( <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor="flag-adv-skip_annotation" className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id="flag-adv-skip_annotation" checked={form.watch('skip_annotation')} onCheckedChange={() => toggleCheckboxValue('skip_annotation')} /> </FormControl> <div className="space-y-1 leading-none pt-px"> <span>Skip Annotation</span> <FormDescription className="italic mt-1"> Skip variant annotation steps (not applicable if starting at annotation). </FormDescription> </div> </FormLabel> <FormField control={form.control} name="skip_annotation" render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />} /> </FormItem> )}
                                </div>
                            </div>
                        </AccordionContent>
                    </AccordionItem>
                </Accordion>
            </Card>

            {/* Action Buttons */}
            <div className="flex justify-start items-center gap-4 pt-4">
                 <TooltipProvider delayDuration={100}>
                    <Tooltip>
                        <TooltipTrigger asChild>
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
                        </TooltipTrigger>
                        {isStagingDisabled && getDisabledButtonTooltip() && (
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
