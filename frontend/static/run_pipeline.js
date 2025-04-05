document.addEventListener('DOMContentLoaded', function() {
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

    // Initialize form elements
    const form = document.getElementById('pipeline-form');
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
    const toolsSelect = document.getElementById('tools');
    if (toolsSelect) {
        // Set default values
        const defaultTools = ['strelka', 'mutect2'];
        defaultTools.forEach(tool => {
            const option = toolsSelect.querySelector(`option[value="${tool}"]`);
            if (option) option.selected = true;
        });
    }

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
        ['inputCsv', 'referenceGenome'].forEach(fileType => {
            const select = fileSelects[fileType];
            if (select && !select.value) {
                isValid = false;
                select.classList.add('is-invalid');
            } else if (select) {
                select.classList.remove('is-invalid');
            }
        });

        // Check required parameters
        const genomeSelect = document.getElementById('genome');
        if (genomeSelect && !genomeSelect.value) {
            isValid = false;
            genomeSelect.classList.add('is-invalid');
        } else if (genomeSelect) {
            genomeSelect.classList.remove('is-invalid');
        }

        // Check tools selection
        const toolsSelect = document.getElementById('tools');
        if (toolsSelect && toolsSelect.selectedOptions.length === 0) {
            isValid = false;
            toolsSelect.classList.add('is-invalid');
        } else if (toolsSelect) {
            toolsSelect.classList.remove('is-invalid');
        }

        addToStagingBtn.disabled = !isValid;
    }

    // Add event listeners for form validation
    Object.values(fileSelects).forEach(select => {
        select.addEventListener('change', validateForm);
    });

    document.getElementById('genome')?.addEventListener('change', validateForm);
    document.getElementById('tools')?.addEventListener('change', validateForm);

    // Handle form submission
    addToStagingBtn.addEventListener('click', async function() {
        const formData = {
            input_csv_file: fileSelects['inputCsv'].value,
            reference_genome_file: fileSelects['referenceGenome'].value,
            intervals_file: fileSelects['intervals']?.value === 'none' ? null : fileSelects['intervals']?.value,
            known_variants_file: fileSelects['knownVariants']?.value === 'none' ? null : fileSelects['knownVariants']?.value,
            genome: document.getElementById('genome').value,
            tools: Array.from(document.getElementById('tools').selectedOptions).map(opt => opt.value).join(','),
            step: document.getElementById('step').value,
            profile: document.getElementById('profile').value,
            joint_germline: document.getElementById('jointGermline').checked,
            wes: document.getElementById('wes').checked,
            description: document.getElementById('description').value
        };

        try {
            showStatus('Staging pipeline job...', 'info');
            
            const response = await fetch('/api/jobs/stage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(formData)
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to stage job');
            }

            const result = await response.json();
            showStatus(`Job staged successfully! Job ID: ${result.job_id}`, 'success');
            
            // Reset form
            form.reset();
            validateForm();
            
            // Redirect to jobs page after a short delay
            setTimeout(() => {
                window.location.href = '/jobs';
            }, 2000);
        } catch (error) {
            console.error('Error staging job:', error);
            showStatus(`Error staging job: ${error.message}`, 'danger');
        }
    });

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
});
