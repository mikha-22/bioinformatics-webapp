import React from 'react';

export default function RunPipeline() {
  return (
    <>
      <head>
        <title>Stage a New Sarek Pipeline Run</title>
        <link rel="stylesheet" href="/frontend/static/run_pipeline.css"></link>
      </head>
      <div>
        <h1>Stage a Sarek Pipeline Run</h1>
        <p className="lead">
          Select the required input files and parameters for the Sarek
          pipeline. Only files located in the{' '}
          <code>bioinformatics/data</code> directory with the specified
          extensions will be shown. Once staged, you can start the job from
          the <a href="/jobs">Jobs Dashboard</a>.
        </p>

        <form id="pipeline-form">
          {/* Required Files */}
          <div className="form-group">
            <label htmlFor="inputCsv">Input CSV (CSV)</label>
            <select className="form-control" id="inputCsv" required>
              <option value="" disabled selected>
                Select Input CSV File
              </option>
            </select>
            <small className="form-text text-muted">
              CSV file containing sample information (patient, sample, sex,
              status, fastq_1, fastq_2)
            </small>
          </div>

          <div className="form-group">
            <label htmlFor="referenceGenome">
              Reference Genome (FASTA/FASTA.GZ)
            </label>
            <select className="form-control" id="referenceGenome" required>
              <option value="" disabled selected>
                Select Reference Genome File
              </option>
            </select>
          </div>

          {/* Optional Files */}
          <div className="form-group">
            <label htmlFor="intervals">Intervals (BED) (Optional)</label>
            <select className="form-control" id="intervals">
              <option value="" disabled selected>
                Select Intervals File (Optional)
              </option>
              {/* JS adds the "None" option dynamically */}
            </select>
            <small className="form-text text-muted">
              BED file defining target regions for variant calling
            </small>
          </div>

          <div className="form-group">
            <label htmlFor="knownVariants">
              Known Variants (VCF/VCF.GZ) (Optional)
            </label>
            <select className="form-control" id="knownVariants">
              <option value="" disabled selected>
                Select Known Variants File (Optional)
              </option>
              {/* JS adds the "None" option dynamically */}
            </select>
            <small className="form-text text-muted">
              VCF file containing known variants for annotation
            </small>
          </div>

          {/* Required Parameters */}
          <div className="form-group">
            <label htmlFor="genome">Genome Build</label>
            <select className="form-control" id="genome" required>
              <option value="" disabled selected>
                Select Genome Build
              </option>
              <option value="GRCh38">GRCh38</option>
              <option value="GRCh37">GRCh37</option>
              <option value="hg38">hg38</option>
              <option value="hg19">hg19</option>
            </select>
          </div>

          {/* Optional Parameters */}
          <div className="form-group">
            <label htmlFor="tools">Variant Calling Tools</label>
            <select className="form-control" id="tools" multiple>
              <option value="strelka">Strelka</option>
              <option value="mutect2">Mutect2</option>
              <option value="freebayes">FreeBayes</option>
              <option value="mpileup">mpileup</option>
              <option value="vardict">VarDict</option>
              <option value="manta">Manta</option>
              <option value="cnvkit">CNVkit</option>
            </select>
            <small className="form-text text-muted">
              Select one or more variant calling tools (default:
              strelka,mutect2)
            </small>
          </div>

          <div className="form-group">
            <label htmlFor="step">Pipeline Step</label>
            <select className="form-control" id="step">
              <option value="mapping" selected>
                Mapping
              </option>
              <option value="markduplicates">Mark Duplicates</option>
              <option value="prepare_recalibration">
                Prepare Recalibration
              </option>
              <option value="recalibrate">Recalibrate</option>
              <option value="variant_calling">Variant Calling</option>
              <option value="annotation">Annotation</option>
              <option value="qc">QC</option>
            </select>
            <small className="form-text text-muted">
              Starting step for the pipeline (default: mapping)
            </small>
          </div>

          <div className="form-group">
            <label htmlFor="profile">Profile</label>
            <select className="form-control" id="profile">
              <option value="docker" selected>
                Docker
              </option>
              <option value="singularity">Singularity</option>
              <option value="conda">Conda</option>
              <option value="podman">Podman</option>
            </select>
            <small className="form-text text-muted">
              Container system to use (default: docker)
            </small>
          </div>

          <div className="form-group">
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="jointGermline"
              />
              <label className="form-check-label" htmlFor="jointGermline">
                Joint Germline Calling
              </label>
            </div>
            <small className="form-text text-muted">
              Enable joint germline variant calling across samples
            </small>
          </div>

          <div className="form-group">
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="wes"
              />
              <label className="form-check-label" htmlFor="wes">
                Whole Exome Sequencing
              </label>
            </div>
            <small className="form-text text-muted">
              Enable if data is from whole exome sequencing
            </small>
          </div>

          <div className="form-group">
            <label htmlFor="description">Description (Optional)</label>
            <input
              type="text"
              className="form-control"
              id="description"
              placeholder="Enter a description for this run"
            />
          </div>

          <button
            type="button"
            className="btn btn-primary"
            id="addToStagingBtn"
            disabled
          >
            Add to Staging
          </button>
          <div id="pipeline-status" className="mt-3"></div>
        </form>
      </div>
    </>
  );
}