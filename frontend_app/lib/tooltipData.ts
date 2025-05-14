// frontend_app/lib/tooltipData.ts

export interface TooltipContentData {
  title?: string;
  message: string;
  link?: string; // URL to relevant documentation
  linkText?: string; // Text for the link, e.g., "Learn More"
}

export const sarekParameterTooltips: Record<string, string | TooltipContentData> = {
  // Core Pipeline Setup
  genome: {
    title: "Reference Genome (--genome)",
    message: "Select the reference genome assembly key. This determines which iGenomes resources (FASTA, indices, annotation files) are used by default if specific paths are not provided. Examples: GATK.GRCh38, hg19.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#genome",
    linkText: "Sarek --genome docs"
  },
  step: {
    title: "Starting Step (--step)",
    message: "Specify the Sarek pipeline step to start from. The available steps depend on the selected 'Input Data Type'. Default for FASTQ is 'mapping'.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#step"
  },
  wes: {
    title: "Whole Exome/Targeted Sequencing (--wes)",
    message: "Enable if your input data is from Whole Exome Sequencing (WES) or other targeted sequencing approaches. This flag influences various QC metrics and variant calling parameters. Providing an 'Intervals File' is highly recommended when this is enabled.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#wes"
  },
  intervals_file: {
    title: "Intervals File (--intervals)",
    message: "Path to a BED, .list, or .interval_list file defining target regions. Crucial for WES/targeted sequencing to focus analysis on relevant genomic areas and for accurate QC metrics.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#intervals"
  },
  skip_baserecalibrator: {
    title: "Skip Base Recalibration (--skip_tools baserecalibrator)",
    message: "Check this to skip the Base Quality Score Recalibration (BQSR) step. If BQSR is performed (default), providing dbSNP and Known Indels files is strongly recommended for optimal results.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#skip_tools"
  },
  dbsnp: {
    title: "dbSNP File (--dbsnp)",
    message: "Path to a VCF file containing known polymorphic sites from dbSNP. Used by GATK BaseRecalibrator (for BQSR) and/or VariantRecalibrator (VQSR). Required if BQSR is not skipped and no Known Indels file is provided.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#dbsnp"
  },
  known_indels: {
    title: "Known Indels File (--known_indels)",
    message: "Path to a VCF file of known indels (e.g., Mills and 1000G Gold Standard Indels). Used by GATK BaseRecalibrator (for BQSR) and/or VariantRecalibrator (VQSR). Required if BQSR is not skipped and no dbSNP file is provided.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#known_indels"
  },

  // Advanced Sarek Parameters
  tools: {
    title: "Variant Calling/Annotation Tools (--tools)",
    message: "Select the variant calling tools (e.g., mutect2, strelka) or annotation tools (e.g., vep, snpeff) to be executed by the pipeline. Not applicable if starting directly at 'annotation' step with VCF input.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#tools"
  },
  profile: {
    title: "Execution Profile (-profile)",
    message: "Specify the Nextflow configuration profile (e.g., docker, singularity, conda, podman). This manages the software execution environment and resource configurations.",
    link: "https://nf-co.re/sarek/3.5.1/usage#adding-your-own-config"
  },
  aligner: {
    title: "Aligner (--aligner)",
    message: "Specify the alignment algorithm to use. Default is bwa-mem. Options include bwa-mem and dragmap. This parameter is only applicable for FASTQ input when the 'mapping' step is included.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#aligner"
  },
  pon: {
    title: "Panel of Normals (PoN) File (--pon)",
    message: "Path to a Panel of Normals (PoN) VCF file. Highly recommended for somatic variant calling with GATK Mutect2 to filter common germline variants present in the sequencing process or platform-specific artifacts.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#pon"
  },
  trim_fastq: {
    title: "Trim FASTQ (--trim_fastq)",
    message: "Enable adapter trimming and quality filtering of raw FASTQ reads using 'fastp' before alignment. This parameter is only applicable for FASTQ input.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#trim_fastq"
  },
  joint_germline: {
    title: "Joint Germline Calling (--joint_germline)",
    message: "Enable joint germline variant calling across multiple normal samples. This typically involves GATK HaplotypeCaller in GVCF mode followed by joint genotyping. Not applicable if starting with VCF input or at the annotation step.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#joint_germline"
  },
  skip_qc: {
    title: "Skip QC (--skip_qc)",
    message: "Skip various quality control steps throughout the pipeline, such as FastQC, Samtools stats, and MultiQC report generation.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#skip_qc"
  },
  skip_annotation: {
    title: "Skip Annotation (--skip_annotation)",
    message: "Skip all variant annotation steps (e.g., VEP, SnpEff). This is not applicable if the pipeline is started directly at the 'annotation' step with VCF input.",
    link: "https://nf-co.re/sarek/3.5.1/parameters#skip_annotation"
  },

  // Sample specific fields (less Sarek params, more structural)
  "samples.lane": "Lane identifier for FASTQ files, e.g., L001, L002. Helps distinguish sequencing runs.",
  "samples.fastq_1": "Path to the forward (R1) FASTQ file, relative to the designated data directory.",
  "samples.fastq_2": "Path to the reverse (R2) FASTQ file, relative to the designated data directory.",
  "samples.bam_cram": "Path to the coordinate-sorted BAM or CRAM alignment file, relative to the data directory.",
  "samples.index": "Path to the index file (.bai for BAM, .crai for CRAM, .tbi/.csi for VCF.gz), relative to the data directory. Required for CRAM and compressed VCF.",
  "samples.vcf": "Path to the Variant Call Format (VCF) file, relative to the data directory.",
};
