# Sarek Pipeline Integration

This document provides detailed information about the integration of the Sarek Nextflow pipeline into the Bioinformatics Webapp.

## Overview

Sarek is a workflow designed to detect germline and somatic variants on whole genome, whole exome, or targeted sequencing data. The Bioinformatics Webapp provides a user-friendly interface for configuring and running Sarek jobs.

## Pipeline Components

The Sarek integration consists of the following components:

1. **Sarek Pipeline Script (`sarek_pipeline.sh`)**: A wrapper script that executes the Sarek Nextflow pipeline with the provided parameters.
2. **Pipeline Input Model**: Updated to support Sarek-specific parameters.
3. **Validation Logic**: Ensures that all inputs are valid before job submission.
4. **Task Execution**: Runs the Sarek pipeline and monitors its progress.
5. **Results Processing**: Captures and processes the pipeline output.

## Sarek Parameters

### Required Parameters

- **Input CSV**: Path to a CSV file containing sample information.
- **Reference Genome**: Path to the reference genome file.
- **Genome Build**: The genome build to use (e.g., GRCh38).

### Optional Parameters

- **Tools**: Comma-separated list of tools to use (e.g., strelka,mutect2).
- **Step**: Pipeline step to start from (e.g., mapping, variant_calling).
- **Profile**: Nextflow profile to use (e.g., docker, singularity).
- **Intervals**: Path to BED file with target regions.
- **Known Variants**: Path to VCF file with known variants.
- **Joint Germline**: Whether to perform joint germline calling.
- **WES**: Whether the data is from whole exome sequencing.

## Input CSV Format

The input CSV file should follow the Sarek format:

```
patient,sample,sex,status,fastq_1,fastq_2
patient1,sample1,XX,0,/path/to/sample1_R1.fastq.gz,/path/to/sample1_R2.fastq.gz
patient1,sample2,XX,1,/path/to/sample2_R1.fastq.gz,/path/to/sample2_R2.fastq.gz
```

Where:
- `patient`: Patient identifier
- `sample`: Sample identifier
- `sex`: Sex (XX, XY)
- `status`: 0 for normal, 1 for tumor
- `fastq_1`: Path to first FASTQ file
- `fastq_2`: Path to second FASTQ file

## Pipeline Execution Flow

1. **Job Staging**: The user submits a job with Sarek parameters through the web interface.
2. **Validation**: The application validates all inputs and parameters.
3. **Job Enqueueing**: The job is enqueued to the Redis queue.
4. **Pipeline Execution**: The Sarek pipeline is executed with the provided parameters.
5. **Progress Monitoring**: The application monitors the pipeline progress and resource usage.
6. **Results Processing**: The pipeline results are processed and made available to the user.

## Progress Reporting

The Sarek pipeline wrapper script (`sarek_pipeline.sh`) provides progress updates by parsing the Nextflow output. The progress is reported as follows:

- **FASTQC**: 10%
- **BWA_MEM**: 20%
- **MARKDUPLICATES**: 30%
- **BASERECALIBRATOR**: 40%
- **APPLYBQSR**: 50%
- **Variant Calling**: 60%
- **Annotation**: 80%
- **MULTIQC**: 90%
- **Completion**: 100%

## Resource Monitoring

The application monitors the resource usage of the Sarek pipeline, including:

- CPU usage
- Memory usage
- Duration

This information is stored in the job metadata and can be viewed in the web interface.

## Results

The Sarek pipeline produces various output files, including:

- Aligned BAM files
- Variant call files (VCF)
- Quality control reports
- MultiQC reports

These files are stored in the results directory and can be accessed through the web interface.

## Troubleshooting

### Common Issues

1. **Missing Input Files**: Ensure that all required input files are uploaded and accessible.
2. **Invalid Parameters**: Check that all parameters are valid and correctly formatted.
3. **Pipeline Failures**: Check the pipeline logs for error messages and troubleshoot accordingly.

### Logs

The Sarek pipeline logs are stored in the results directory and can be accessed through the web interface. The logs include:

- Pipeline command
- Nextflow output
- Error messages

## References

- [Sarek Pipeline Documentation](https://nf-co.re/sarek/latest/docs/usage/)
- [Nextflow Documentation](https://www.nextflow.io/docs/latest/index.html) 