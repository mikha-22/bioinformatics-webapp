// File: frontend_app/app/(pages)/input/page.tsx
"use client";

// ... (all existing imports, Zod schemas, constants, and component logic up to the return statement) ...
// Ensure HelpTooltipIcon is imported:
// import HelpTooltipIcon from "@/components/forms/HelpTooltipIcon";

export default function InputPage() {
  // ... (all existing state, form setup, useEffects, functions up to the return statement) ...

  return (
    <FormProvider {...form}>
      <Form {...form}>
        <form ref={formRef} onSubmit={form.handleSubmit(onSubmit, onFormError)} className="space-y-8">
          {/* ... (Input & Configuration Card, Run Information Card, Samples Card - unchanged for this specific tooltip placement task) ... */}

          <Card>
            <CardHeader> <CardTitle className="text-xl">Core Pipeline Setup</CardTitle> <CardDescription>Essential parameters for the Sarek pipeline run.</CardDescription> </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-6">
                <FormField control={form.control} name="genome" render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center">
                      <FormLabel>Reference Genome Build <span className="text-destructive">*</span></FormLabel>
                      <HelpTooltipIcon tooltipKey="genome" />
                    </div>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select genome build" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_GENOMES.map(g => ( <SelectItem key={g.value} value={g.value}> {g.label} </SelectItem> ))} </SelectContent> </Select> <FormDescription className="italic"> Select the genome assembly key. </FormDescription> <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="step" render={({ field }) => (
                  <FormItem id="step-form-item">
                    <div className="flex items-center">
                      <FormLabel>Starting Step <span className="text-destructive">*</span></FormLabel>
                      <HelpTooltipIcon tooltipKey="step" />
                    </div>
                    <Select onValueChange={field.onChange} value={field.value} disabled={availableSteps.length <= 1} > <FormControl> <SelectTrigger id="step"> <SelectValue placeholder="Select starting step" /> </SelectTrigger> </FormControl> <SelectContent> {availableSteps.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic">Pipeline execution starting point.</FormDescription> <FormMessage />
                  </FormItem>
                )} />

                {/* MODIFIED WES Checkbox FormItem */}
                <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 md:col-span-2 hover:bg-accent/50 transition-colors select-none">
                  <FormControl className="mt-0.5">
                    <Checkbox id="flag-wes" checked={form.watch('wes')} onCheckedChange={() => toggleCheckboxValue('wes')} />
                  </FormControl>
                  <div className="space-y-1 leading-none flex-grow">
                    <FormLabel htmlFor="flag-wes" className="font-normal cursor-pointer">
                      <span className="font-medium">Whole Exome Sequencing (WES)</span>
                      <HelpTooltipIcon tooltipKey="wes" className="inline-block ml-1.5 align-middle" />
                    </FormLabel>
                    <FormDescription className="italic">
                      Check if data is WES/targeted. Providing an Intervals file is recommended.
                    </FormDescription>
                    <FormField control={form.control} name="wes" render={() => <FormMessage />} />
                  </div>
                </FormItem>

                <FormField control={form.control} name="intervals_file" render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <div className="flex items-center">
                      <FormLabel> Intervals File <span className="text-muted-foreground text-xs"> (Optional for WES/Targeted)</span> </FormLabel>
                      <HelpTooltipIcon tooltipKey="intervals_file" />
                    </div>
                    <FormControl> <FileSelector fileTypeLabel="Intervals" fileType="intervals" extensions={[".bed", ".list", ".interval_list"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select intervals file..." allowNone required={false} /> </FormControl> <FormDescription className="italic"> Target regions. </FormDescription> <FormMessage />
                  </FormItem>
                )} />

                {/* MODIFIED Skip BQSR Checkbox FormItem */}
                {showSkipBaserecalibrator && (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 md:col-span-2 hover:bg-accent/50 transition-colors select-none">
                    <FormControl className="mt-0.5">
                      <Checkbox id="flag-skip_baserecalibrator" checked={form.watch('skip_baserecalibrator')} onCheckedChange={() => toggleCheckboxValue('skip_baserecalibrator')} />
                    </FormControl>
                    <div className="space-y-1 leading-none flex-grow">
                      <FormLabel htmlFor="flag-skip_baserecalibrator" className="font-normal cursor-pointer">
                        <span className="font-medium">Skip Base Recalibration (BQSR)</span>
                        <HelpTooltipIcon tooltipKey="skip_baserecalibrator" className="inline-block ml-1.5 align-middle" />
                      </FormLabel>
                      <FormDescription className="italic">
                        (If unchecked, dbSNP or Known Indels file is required below).
                      </FormDescription>
                      <FormField control={form.control} name="skip_baserecalibrator" render={() => <FormMessage />} />
                    </div>
                  </FormItem>
                )}
                {bqsrFilesWarning && showSkipBaserecalibrator && !form.watch('skip_baserecalibrator') && ( <div className="md:col-span-2 -mt-2 mb-2"> <FormWarningDisplay message={bqsrFilesWarning} title="BQSR Configuration Notice" /> </div> )}
                {showSkipBaserecalibrator && !form.watch('skip_baserecalibrator') && (
                  <>
                    <FormField control={form.control} name="dbsnp" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center">
                          <FormLabel>dbSNP (VCF/VCF.GZ) <span className={cn(!watchedSkipBqsr && "text-destructive")}>*</span></FormLabel>
                          <HelpTooltipIcon tooltipKey="dbsnp" />
                        </div>
                        <FormControl> <FileSelector fileTypeLabel="dbSNP" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select dbSNP file..." allowNone /> </FormControl> <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="known_indels" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center">
                          <FormLabel>Known Indels (VCF/VCF.GZ) <span className={cn(!watchedSkipBqsr && "text-destructive")}>*</span></FormLabel>
                          <HelpTooltipIcon tooltipKey="known_indels" />
                        </div>
                        <FormControl> <FileSelector fileTypeLabel="Known Indels" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select known indels file..." allowNone /> </FormControl> <FormMessage />
                      </FormItem>
                    )} />
                    <FormDescription className="md:col-span-2 text-xs italic -mt-4">At least one (dbSNP or Known Indels) is required for BQSR.</FormDescription>
                  </>
                )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden p-2">
            <Accordion type="single" collapsible className="w-full" value={advancedAccordionValue} onValueChange={setAdvancedAccordionValue}>
              <AccordionItem value="advanced-sarek-options" className="border-0">
                <AccordionTrigger className={cn("flex w-full items-center justify-between hover:no-underline cursor-pointer", "px-6 py-3", "data-[state=open]:border-0 data-[state=closed]:border-transparent")}>
                  <div className="text-left"> <h3 className="text-md font-medium leading-tight tracking-tight">Advanced Sarek Parameters</h3> <p className="text-sm text-muted-foreground mt-0.5">Optional parameters to fine-tune the pipeline. Click to expand.</p> </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="px-6 pt-4 pb-6 space-y-6 border-t">
                    {showTools && (
                      <div>
                        <div className="mb-2 flex items-center"> {/* Reduced mb */}
                          <FormLabel className="text-base font-medium">Variant Calling Tools</FormLabel>
                          <HelpTooltipIcon tooltipKey="tools" />
                        </div>
                        <FormDescription className="text-sm text-muted-foreground mb-3">Select tools to run (not applicable when starting at annotation).</FormDescription>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"> {SAREK_TOOLS.map((tool) => { const uniqueId = `tool-${tool}`; const currentTools: string[] = form.watch("tools") || []; const isChecked = currentTools.includes(tool); return ( <FormItem key={uniqueId} className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-3 hover:bg-accent/50 transition-colors select-none"> <FormLabel htmlFor={uniqueId} className="flex flex-row items-start space-x-3 space-y-0 font-normal cursor-pointer w-full h-full"> <FormControl className="flex h-6 items-start"> <Checkbox id={uniqueId} checked={isChecked} onCheckedChange={() => toggleCheckboxValue('tools', tool)} /> </FormControl> <span className="pt-px">{tool}</span> </FormLabel> </FormItem> ); })} </div>
                        <FormField control={form.control} name="tools" render={() => <FormMessage className="pt-2" />} />
                        {somaticTumorWarning && ( <div className="mt-3"> <FormWarningDisplay message={somaticTumorWarning} title="Somatic Analysis Check" /> </div> )}
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-6">
                      <FormField control={form.control} name="profile" render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center">
                            <FormLabel>Execution Profile</FormLabel>
                            <HelpTooltipIcon tooltipKey="profile" />
                          </div>
                          <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select execution profile" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_PROFILES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Container or environment system. </FormDescription> <FormMessage />
                        </FormItem>
                      )} />
                      {showAligner && ( <FormField control={form.control} name="aligner" render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center">
                            <FormLabel>Aligner</FormLabel>
                            <HelpTooltipIcon tooltipKey="aligner" />
                          </div>
                          <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value || ""}> <FormControl> <SelectTrigger> <SelectValue placeholder="Select aligner" /> </SelectTrigger> </FormControl> <SelectContent> {SAREK_ALIGNERS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)} </SelectContent> </Select> <FormDescription className="italic"> Alignment algorithm (only for FASTQ input). </FormDescription> <FormMessage />
                        </FormItem>
                      )} /> )}
                      <FormField control={form.control} name="pon" render={({ field }) => (
                        <FormItem className="md:col-span-2">
                          <div className="flex items-center">
                            <FormLabel>Panel of Normals (VCF/VCF.GZ) <span className="text-muted-foreground text-xs">(Optional)</span></FormLabel>
                            <HelpTooltipIcon tooltipKey="pon" />
                          </div>
                          <FormControl> <FileSelector fileTypeLabel="Panel of Normals" fileType="vcf" extensions={[".vcf", ".vcf.gz", ".vcf.bgz"]} value={field.value || undefined} onChange={field.onChange} placeholder="Select Panel of Normals file..." allowNone /> </FormControl> <FormDescription className="italic"> Recommended for Mutect2 somatic variant calling. </FormDescription> <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="space-y-4">
                      {/* MODIFIED Trim FASTQ Checkbox FormItem */}
                      {showTrimFastq && (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                          <FormControl className="mt-0.5">
                            <Checkbox id="flag-adv-trim_fastq" checked={form.watch('trim_fastq')} onCheckedChange={() => toggleCheckboxValue('trim_fastq')} />
                          </FormControl>
                          <div className="space-y-1 leading-none flex-grow">
                            <FormLabel htmlFor="flag-adv-trim_fastq" className="font-normal cursor-pointer">
                              <span className="font-medium">Trim FASTQ</span>
                              <HelpTooltipIcon tooltipKey="trim_fastq" className="inline-block ml-1.5 align-middle" />
                            </FormLabel>
                            <FormDescription className="italic">
                              Enable adapter trimming (only for FASTQ input).
                            </FormDescription>
                            <FormField control={form.control} name="trim_fastq" render={() => <FormMessage />} />
                          </div>
                        </FormItem>
                      )}
                      {/* MODIFIED Joint Germline Checkbox FormItem */}
                      {showJointGermline && (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                          <FormControl className="mt-0.5">
                            <Checkbox id="flag-adv-joint_germline" checked={form.watch('joint_germline')} onCheckedChange={() => toggleCheckboxValue('joint_germline')} />
                          </FormControl>
                          <div className="space-y-1 leading-none flex-grow">
                            <FormLabel htmlFor="flag-adv-joint_germline" className="font-normal cursor-pointer">
                              <span className="font-medium">Joint Germline Calling</span>
                              <HelpTooltipIcon tooltipKey="joint_germline" className="inline-block ml-1.5 align-middle" />
                            </FormLabel>
                            <FormDescription className="italic">
                              Enable joint calling (not applicable if starting at annotation).
                            </FormDescription>
                            <FormField control={form.control} name="joint_germline" render={() => <FormMessage />} />
                          </div>
                        </FormItem>
                      )}
                      {/* MODIFIED Skip QC Checkbox FormItem */}
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                        <FormControl className="mt-0.5">
                          <Checkbox id="flag-adv-skip_qc" checked={form.watch('skip_qc')} onCheckedChange={() => toggleCheckboxValue('skip_qc')} />
                        </FormControl>
                        <div className="space-y-1 leading-none flex-grow">
                          <FormLabel htmlFor="flag-adv-skip_qc" className="font-normal cursor-pointer">
                            <span className="font-medium">Skip QC</span>
                            <HelpTooltipIcon tooltipKey="skip_qc" className="inline-block ml-1.5 align-middle" />
                          </FormLabel>
                          <FormDescription className="italic">
                            Skip quality control steps (FastQC, Samtools stats, etc.).
                          </FormDescription>
                          <FormField control={form.control} name="skip_qc" render={() => <FormMessage />} />
                        </div>
                      </FormItem>
                      {/* MODIFIED Skip Annotation Checkbox FormItem */}
                      {showSkipAnnotation && (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-accent/50 transition-colors select-none">
                          <FormControl className="mt-0.5">
                            <Checkbox id="flag-adv-skip_annotation" checked={form.watch('skip_annotation')} onCheckedChange={() => toggleCheckboxValue('skip_annotation')} />
                          </FormControl>
                          <div className="space-y-1 leading-none flex-grow">
                            <FormLabel htmlFor="flag-adv-skip_annotation" className="font-normal cursor-pointer">
                              <span className="font-medium">Skip Annotation</span>
                              <HelpTooltipIcon tooltipKey="skip_annotation" className="inline-block ml-1.5 align-middle" />
                            </FormLabel>
                            <FormDescription className="italic">
                              Skip variant annotation steps (not applicable if starting at annotation).
                            </FormDescription>
                            <FormField control={form.control} name="skip_annotation" render={() => <FormMessage />} />
                          </div>
                        </FormItem>
                      )}
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </Card>

          {/* ... (Submit Buttons - unchanged) ... */}
          <div className="flex justify-start items-center gap-4 pt-4">
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="submit" disabled={isStagingDisabled} className={cn("border border-primary hover:underline", isStagingDisabled ? "bg-primary/50 text-primary-foreground/70 opacity-50 cursor-not-allowed" : "bg-primary text-primary-foreground hover:bg-primary/90" )} aria-disabled={isStagingDisabled} >
                    {(stageMutation.isPending || saveProfileMutation.isPending) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" /> } Stage Pipeline Run
                  </Button>
                </TooltipTrigger>
                {isStagingDisabled && disabledButtonTooltipMessage && ( <TooltipContent side="top" align="center"> <p className="text-sm flex items-center gap-1"> <Info className="h-4 w-4"/> {disabledButtonTooltipMessage} </p> </TooltipContent> )}
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
