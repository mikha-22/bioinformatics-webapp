// File: frontend_app/app/(pages)/input/page.tsx
"use client";

import React from "react";
import { useForm, useFieldArray, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z, ZodType } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { PlusCircle, Loader2, Play } from "lucide-react";
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
import SampleInputGroup from "@/components/forms/SampleInputGroup";
import FileSelector from "@/components/forms/FileSelector";
import * as api from "@/lib/api";
import { PipelineInput, SampleInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Control } from "react-hook-form";

// --- Define Zod Schema for Validation ---

const sampleSchema = z.object({
  patient: z.string().min(1, "Patient ID is required"),
  sample: z.string().min(1, "Sample ID is required"),
  sex: z.enum(["XX", "XY", "X", "Y", "other"], { required_error: "Sex is required" }),
  status: z.union([z.literal(0), z.literal(1)], { required_error: "Status is required" }),
  fastq_1: z.string().min(1, "FASTQ R1 is required"),
  fastq_2: z.string().min(1, "FASTQ R2 is required"),
});

const SAREK_TOOLS = ["strelka", "mutect2", "freebayes", "mpileup", "vardict", "manta", "cnvkit"];
const SAREK_STEPS = ["mapping", "markduplicates", "prepare_recalibration", "recalibrate", "variant_calling", "annotation", "qc"];
const SAREK_PROFILES = ["docker", "singularity", "conda", "podman"];
const SAREK_GENOMES = ["GRCh38", "GRCh37", "hg38", "hg19"];
const SAREK_ALIGNERS = ["bwa-mem", "dragmap"];

const pipelineInputSchema = z.object({
  samples: z.array(sampleSchema).min(1, "At least one sample is required"),
  genome: z.enum(SAREK_GENOMES as [string, ...string[]], {
     required_error: "Genome build is required",
     invalid_type_error: "Invalid genome build selected",
  }),
  intervals_file: z.string().optional(),
  dbsnp: z.string().optional(),
  known_indels: z.string().optional(),
  pon: z.string().optional(),
  tools: z.array(z.string()).default(["strelka", "mutect2"]),
  step: z.enum(SAREK_STEPS as [string, ...string[]]).default("mapping"),
  profile: z.enum(SAREK_PROFILES as [string, ...string[]]).default("docker"),
  aligner: z.enum(SAREK_ALIGNERS as [string, ...string[]]).default("bwa-mem"),
  joint_germline: z.boolean().default(false),
  wes: z.boolean().default(false),
  trim_fastq: z.boolean().default(false),
  skip_qc: z.boolean().default(false),
  skip_annotation: z.boolean().default(false),
  description: z.string().optional(),
})
.refine(data => !data.wes || (data.wes && data.intervals_file && data.intervals_file.length > 0), {
    message: "Intervals file is required when WES is selected",
    path: ["intervals_file"],
});

type PipelineFormValues = z.infer<typeof pipelineInputSchema>;


export default function InputPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const form = useForm<PipelineFormValues>({
    resolver: zodResolver(pipelineInputSchema as ZodType<PipelineFormValues>),
    defaultValues: {
      samples: [{ patient: "", sample: "", sex: undefined, status: undefined, fastq_1: "", fastq_2: "" }],
      genome: "GRCh38",
      intervals_file: undefined,
      dbsnp: undefined,
      known_indels: undefined,
      pon: undefined,
      tools: ["strelka", "mutect2"],
      step: "mapping",
      profile: "docker",
      aligner: "bwa-mem",
      joint_germline: false,
      wes: false,
      trim_fastq: false,
      skip_qc: false,
      skip_annotation: false,
      description: "",
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "samples",
  });

  const stageMutation = useMutation({
     mutationFn: (values: PipelineInput) => api.stagePipelineJob(values),
     onSuccess: (data) => {
        toast.success(`Job staged successfully: ${data.staged_job_id}`);
        queryClient.invalidateQueries({ queryKey: ['jobsList'] });
        form.reset();
        router.push('/jobs');
     },
     onError: (error) => {
        toast.error(`Failed to stage job: ${error.message}`);
     }
  });

  function onSubmit(values: PipelineFormValues) {
     console.log("Form Values Submitted:", values);
      const apiPayload: PipelineInput = {
          samples: values.samples.map(s => ({
                patient: s.patient,
                sample: s.sample,
                sex: s.sex,
                status: s.status,
                fastq_1: s.fastq_1,
                fastq_2: s.fastq_2,
          })),
          genome: values.genome,
          intervals_file: values.intervals_file || undefined,
          dbsnp: values.dbsnp || undefined,
          known_indels: values.known_indels || undefined,
          pon: values.pon || undefined,
          tools: values.tools && values.tools.length > 0 ? values.tools.join(',') : undefined,
          step: values.step,
          profile: values.profile,
          aligner: values.aligner,
          joint_germline: values.joint_germline,
          wes: values.wes,
          trim_fastq: values.trim_fastq,
          skip_qc: values.skip_qc,
          skip_annotation: values.skip_annotation,
          description: values.description || undefined,
      };
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
            }
        }
    };

  return (
    <FormProvider {...form}>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
          <h1 className="text-3xl font-bold mb-6 ml-2">Stage New Sarek Run</h1>
          {/* Samples Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-primary">Sample Information</CardTitle>
              <CardDescription>Define the samples to be processed in this run. Status 0 = Normal, 1 = Tumor.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {fields.map((field, index) => (
                <SampleInputGroup key={field.id} index={index} remove={remove} control={form.control} />
              ))}
               <Button
                type="button"
                variant="outline"
                size="sm"
                // --- PROVIDE DEFAULTS FOR REQUIRED FIELDS ---
                onClick={() => append({
                    patient: "",
                    sample: "",
                    sex: "XX", // Provide a default valid sex
                    status: 0, // Provide a default valid status (e.g., 0 for Normal)
                    fastq_1: "",
                    fastq_2: ""
                })}
                // -----------------------------------------
                className="mt-2 cursor-pointer"
              >
                <PlusCircle className="mr-2 h-4 w-4" />
                Add Sample
              </Button>
               <FormMessage>{form.formState.errors.samples?.message || form.formState.errors.samples?.root?.message}</FormMessage>
            </CardContent>
          </Card>

          {/* Reference & Annotation Files Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-primary">Reference & Annotation Files</CardTitle>
              <CardDescription>Select the reference genome build and optional annotation files.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField control={form.control} name="genome" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Reference Genome Build <span className="text-destructive">*</span></FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select genome build" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_GENOMES.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Select the genome assembly (e.g., GRCh38). Determines reference files used. </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="intervals_file" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default"> Intervals (BED) {form.watch("wes") && <span className="text-destructive"> *</span>} <span className="text-muted-foreground text-xs"> (Optional unless WES)</span> </FormLabel> <FormControl> <FileSelector fileTypeLabel="Intervals" fileType="bed" extensions={[".bed"]} value={field.value} onChange={field.onChange} placeholder="Select intervals file..." allowNone required={form.watch("wes")} /> </FormControl> <FormDescription className="italic"> Target regions for variant calling (e.g., exome boundaries). Required if WES is checked. </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="dbsnp" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">dbSNP (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="dbSNP" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value} onChange={field.onChange} placeholder="Select dbSNP file..." allowNone /> </FormControl> <FormDescription className="italic"> Known variants VCF for base recalibration (e.g., dbSNP). </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="known_indels" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Known Indels (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="Known Indels" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value} onChange={field.onChange} placeholder="Select known indels file..." allowNone /> </FormControl> <FormDescription className="italic"> Known indels VCF for base recalibration (e.g., Mills, 1000G). </FormDescription> <FormMessage /> </FormItem> )} />
              <FormField control={form.control} name="pon" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Panel of Normals (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel> <FormControl> <FileSelector fileTypeLabel="Panel of Normals" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value} onChange={field.onChange} placeholder="Select Panel of Normals file..." allowNone /> </FormControl> <FormDescription className="italic"> Panel of Normals VCF for somatic variant calling. </FormDescription> <FormMessage /> </FormItem> )} />
            </CardContent>
          </Card>

          {/* Parameters Section */}
           <Card>
             <CardHeader>
                 <CardTitle className="text-primary">Pipeline Parameters</CardTitle>
                 <CardDescription>Configure Sarek workflow options.</CardDescription>
             </CardHeader>
             <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 <FormField control={form.control} name="aligner" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Aligner</FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select aligner" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_ALIGNERS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Alignment algorithm (default: bwa-mem). </FormDescription> <FormMessage /> </FormItem> )} />
                 <FormField control={form.control} name="profile" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Execution Profile</FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select execution profile" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_PROFILES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Container or environment system (e.g., Docker). </FormDescription> <FormMessage /> </FormItem> )} />
                 <FormField control={form.control} name="step" render={({ field }) => ( <FormItem> <FormLabel className="cursor-default">Starting Step</FormLabel> <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select starting step" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_STEPS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Start pipeline from this step (default: mapping). </FormDescription> <FormMessage /> </FormItem> )} />

                 {/* Tools Checkboxes */}
                 <div className="md:col-span-2">
                     <div className="mb-4">
                         <div className="text-base font-medium">Variant Calling Tools</div>
                         <p className="text-sm text-muted-foreground">Select tools to run (e.g., Strelka, Mutect2).</p>
                     </div>
                     <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                         {SAREK_TOOLS.map((tool) => {
                             const uniqueId = `tool-${tool}`;
                             const currentTools: string[] = form.watch("tools") || [];
                             const isChecked = currentTools.includes(tool);
                             return (
                                 <FormItem
                                     key={uniqueId}
                                     className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-3 hover:bg-accent/50 transition-colors select-none"
                                 >
                                     <FormLabel
                                         htmlFor={uniqueId}
                                         className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"
                                     >
                                         <FormControl className="flex h-6 items-start">
                                             <Checkbox
                                                 id={uniqueId}
                                                 checked={isChecked}
                                                 onCheckedChange={() => {
                                                     toggleCheckboxValue('tools', tool);
                                                 }}
                                             />
                                         </FormControl>
                                         <span className="pt-px">{tool}</span>
                                     </FormLabel>
                                 </FormItem>
                             );
                         })}
                     </div>
                     <FormField control={form.control} name="tools" render={() => <FormMessage className="pt-2" />} />
                 </div>


                 {/* Boolean Flags Group */}
                  <div className="md:col-span-2 space-y-4">
                      {[
                          { name: 'joint_germline', label: 'Joint Germline Calling', description: 'Enable joint calling across samples (requires all samples Status=0).' },
                          { name: 'wes', label: 'Whole Exome Sequencing (WES)', description: 'Check if data is WES/targeted. Requires an Intervals file.' },
                          { name: 'trim_fastq', label: 'Trim FASTQ', description: 'Enable adapter trimming using Trim Galore!.' },
                          { name: 'skip_qc', label: 'Skip QC', description: 'Skip quality control steps (FastQC, Samtools, etc.).' },
                          { name: 'skip_annotation', label: 'Skip Annotation', description: 'Skip variant annotation steps (VEP, snpEff).' },
                      ].map((flag) => {
                            const fieldName = flag.name as keyof PipelineFormValues;
                            const uniqueId = `flag-${flag.name}`;
                            const isChecked = form.watch(fieldName) as boolean;
                            return (
                                <FormItem
                                    key={uniqueId}
                                    className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none"
                                >
                                    <FormLabel
                                        htmlFor={uniqueId}
                                        className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"
                                    >
                                        <FormControl className="flex h-6 items-start">
                                            <Checkbox
                                                id={uniqueId}
                                                checked={isChecked}
                                                onCheckedChange={() => {
                                                    toggleCheckboxValue(fieldName);
                                                }}
                                            />
                                        </FormControl>
                                        <div className="space-y-1 leading-none pt-px">
                                            <span>{flag.label}</span>
                                            <FormDescription className="italic mt-1">
                                                {flag.description}
                                            </FormDescription>
                                        </div>
                                    </FormLabel>
                                     <FormField
                                         control={form.control}
                                         name={fieldName}
                                         render={() => <FormMessage className="pt-1 pl-[calc(1rem+0.75rem)]" />}
                                     />
                                </FormItem>
                            );
                      })}
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

          {/* Submit Button */}
          <div className="flex justify-start ml-[1%]">
            <Button
               type="submit"
               disabled={stageMutation.isPending}
               className="border border-primary hover:underline cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {stageMutation.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Play className="mr-2 h-4 w-4" />
              }
              Stage Pipeline Run
            </Button>
          </div>
        </form>
      </Form>
    </FormProvider>
  );
}
