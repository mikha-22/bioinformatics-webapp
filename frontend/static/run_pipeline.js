document.addEventListener('DOMContentLoaded', function() {
    // Initialize tooltips
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });

    // File type definitions for Sarek
    const FILE_TYPES = {
        'inputCsv': {
            extensions: ['.csv'],
            description: 'Input CSV file with sample information'
        },
        'referenceGenome': {
            extensions: ['.fa', '.fasta', '.fa.gz', '.fasta.gz'],
            description: 'Reference genome file'
        },
        'intervals': {
            extensions: ['.bed'],
            description: 'BED file defining target regions'
        },
        'knownVariants': {
            extensions: ['.vcf', '.vcf.gz'],
            description: 'VCF file containing known variants'
        }
    };

    const form = document.getElementById('pipelineForm');
    const samplesContainer = document.getElementById('samplesContainer');
    const addSampleBtn = document.getElementById('addSampleBtn');
    const sampleTemplate = document.getElementById('sampleEntryTemplate');
    const fileSelects = {};
    const addToStagingBtn = document.getElementById('addToStagingBtn');
    const statusDiv = document.getElementById('pipeline-status');

    // Initialize file selects
    Object.keys(FILE_TYPES).forEach(fileType => {
        const select = document.getElementById(fileType);
        if (select) {
            fileSelects[fileType] = select;
            loadFiles(fileType);
        }
    });

    // Initialize multiple select for tools
    const toolCheckboxes = document.querySelectorAll('input[name="tools"]');
    toolCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', validateForm);
    });

    // Add initial sample entry
    addSampleEntry();

    // Add sample button click handler
    addSampleBtn.addEventListener('click', addSampleEntry);

    // Load files for a specific file type
    async function loadFiles(fileType) {
        const select = fileSelects[fileType];
        if (!select) return;

        try {
            const response = await fetch(`/api/files?type=${fileType}`);
            if (!response.ok) throw new Error('Failed to load files');
            
            const files = await response.json();
            
            // Clear existing options except the first one
            while (select.options.length > 1) {
                select.remove(1);
            }

            // Add files
            files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                select.appendChild(option);
            });

            // Add "None" option for optional files
            if (fileType === 'intervals' || fileType === 'knownVariants') {
                const noneOption = document.createElement('option');
                noneOption.value = 'none';
                noneOption.textContent = 'None';
                select.appendChild(noneOption);
            }

            validateForm();
        } catch (error) {
            console.error(`Error loading ${fileType} files:`, error);
            showStatus(`Error loading ${fileType} files: ${error.message}`, 'danger');
        }
    }

    // Validate form inputs
    function validateForm() {
        let isValid = true;
        
        // Check required files
        const referenceGenomeFile = document.getElementById('referenceGenomeFile');
        if (referenceGenomeFile && !referenceGenomeFile.files.length) {
            isValid = false;
            referenceGenomeFile.classList.add('is-invalid');
        } else if (referenceGenomeFile) {
            referenceGenomeFile.classList.remove('is-invalid');
        }

        // Check required parameters
        const genomeSelect = document.getElementById('genome');
        if (genomeSelect && !genomeSelect.value) {
            isValid = false;
            genomeSelect.classList.add('is-invalid');
        } else if (genomeSelect) {
            genomeSelect.classList.remove('is-invalid');
        }

        // Check tools selection
        const selectedTools = Array.from(document.querySelectorAll('input[name="tools"]:checked'));
        if (selectedTools.length === 0) {
            isValid = false;
            document.querySelector('.tool-options').classList.add('is-invalid');
        } else {
            document.querySelector('.tool-options').classList.remove('is-invalid');
        }

        // Check pipeline step
        const stepSelect = document.getElementById('step');
        if (stepSelect && !stepSelect.value) {
            isValid = false;
            stepSelect.classList.add('is-invalid');
        } else if (stepSelect) {
            stepSelect.classList.remove('is-invalid');
        }

        // Check profile
        const profileSelect = document.getElementById('profile');
        if (profileSelect && !profileSelect.value) {
            isValid = false;
            profileSelect.classList.add('is-invalid');
        } else if (profileSelect) {
            profileSelect.classList.remove('is-invalid');
        }

        // Check sample entries
        const sampleEntries = document.querySelectorAll('.sample-entry');
        sampleEntries.forEach(entry => {
            const requiredInputs = entry.querySelectorAll('[required]');
            requiredInputs.forEach(input => {
                if (!input.value) {
                    isValid = false;
                    input.classList.add('is-invalid');
                } else {
                    input.classList.remove('is-invalid');
                }
            });
        });

        addToStagingBtn.disabled = !isValid;
        return isValid;
    }

    // Add event listeners for form validation
    form.addEventListener('input', function(event) {
        if (event.target.hasAttribute('required')) {
            validateForm();
        }
    });

    // Form submission handler
    form.addEventListener('submit', async function(event) {
        event.preventDefault();
        
        if (!validateForm()) {
            event.stopPropagation();
            form.classList.add('was-validated');
            return;
        }

        try {
            const formData = new FormData();
            
            // Add reference files
            formData.append('reference_genome_file', document.getElementById('referenceGenomeFile').files[0]);
            const intervalsFile = document.getElementById('intervalsFile').files[0];
            if (intervalsFile) {
                formData.append('intervals_file', intervalsFile);
            }
            const knownVariantsFile = document.getElementById('knownVariantsFile').files[0];
            if (knownVariantsFile) {
                formData.append('known_variants_file', knownVariantsFile);
            }

            // Add pipeline parameters
            formData.append('genome', document.getElementById('genome').value);
            const selectedTools = Array.from(document.querySelectorAll('input[name="tools"]:checked')).map(cb => cb.value);
            formData.append('tools', JSON.stringify(selectedTools));
            formData.append('step', document.getElementById('step').value);
            formData.append('profile', document.getElementById('profile').value);
            formData.append('joint_germline', document.getElementById('jointGermline').checked);
            formData.append('wes', document.getElementById('wes').checked);

            // Add sample information
            const samples = [];
            document.querySelectorAll('.sample-entry').forEach(entry => {
                const sample = {
                    patient: entry.querySelector('.patient').value,
                    sample: entry.querySelector('.sample').value,
                    sex: entry.querySelector('.sex').value,
                    status: entry.querySelector('.status').value,
                    fastq_1: entry.querySelector('.fastq_1').files[0].name,
                    fastq_2: entry.querySelector('.fastq_2').files[0].name
                };
                samples.push(sample);
                formData.append('fastq_1_' + sample.sample, entry.querySelector('.fastq_1').files[0]);
                formData.append('fastq_2_' + sample.sample, entry.querySelector('.fastq_2').files[0]);
            });
            formData.append('samples', JSON.stringify(samples));

            // Submit the form
            const response = await fetch('/api/run_pipeline', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to submit pipeline job');
            }

            const result = await response.json();
            window.location.href = `/jobs?staged_job_id=${result.staged_job_id}`;

        } catch (error) {
            console.error('Error submitting pipeline job:', error);
            alert('Error submitting pipeline job: ' + error.message);
        }
    });

    // Function to add a new sample entry
    function addSampleEntry() {
        const clone = sampleTemplate.content.cloneNode(true);
        const sampleEntry = clone.querySelector('.sample-entry');
        
        // Add remove button handler
        const removeBtn = sampleEntry.querySelector('.remove-sample');
        removeBtn.addEventListener('click', function() {
            if (document.querySelectorAll('.sample-entry').length > 1) {
                sampleEntry.remove();
            } else {
                alert('At least one sample is required');
            }
        });

        // Add validation listeners to new inputs
        const requiredInputs = sampleEntry.querySelectorAll('[required]');
        requiredInputs.forEach(input => {
            input.addEventListener('input', validateForm);
        });

        samplesContainer.appendChild(sampleEntry);
    }

    // Show status message
    function showStatus(message, type = 'info') {
        statusDiv.innerHTML = `
            <div class="alert alert-${type} alert-dismissible fade show" role="alert">
                ${message}
                <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                    <span aria-hidden="true">&times;</span>
                </button>
            </div>
        `;
    }

    // Initial form validation
    validateForm();

    // Add form validation styles
    form.classList.add('needs-validation');
});
