document.addEventListener('DOMContentLoaded', function() {
    const forwardReadsSelect = document.getElementById('forwardReads');
    const reverseReadsSelect = document.getElementById('reverseReads');
    const referenceGenomeSelect = document.getElementById('referenceGenome');
    const targetRegionsSelect = document.getElementById('targetRegions');
    const knownVariantsSelect = document.getElementById('knownVariants');
    const runPipelineBtn = document.getElementById('runPipelineBtn');
    const pipelineStatusDiv = document.getElementById('pipeline-status');
    const mandatorySelects = [forwardReadsSelect, reverseReadsSelect, referenceGenomeSelect, targetRegionsSelect];

    // Function to populate the dropdown with files based on extension
    function populateDropdown(selectElement, files, extensions) {
        files.forEach(file => {
            if (extensions.some(ext => file.name.endsWith(ext))) {
                const option = document.createElement('option');
                option.value = file.name;
                option.textContent = file.name;
                selectElement.appendChild(option);
            }
        });
    }

    // Fetch the list of files from the backend
    fetch('/get_data')
        .then(response => response.json())
        .then(data => {
            populateDropdown(forwardReadsSelect, data, ['.fastq', '.fastq.gz']);
            populateDropdown(reverseReadsSelect, data, ['.fastq', '.fastq.gz']);
            populateDropdown(referenceGenomeSelect, data, ['.fasta', '.fasta.gz']);
            populateDropdown(targetRegionsSelect, data, ['.bed']);
            populateDropdown(knownVariantsSelect, data, ['.vcf', '.vcf.gz']);
        })
        .catch(error => {
            console.error('Error fetching file list:', error);
            pipelineStatusDiv.textContent = 'Error fetching the list of available files.';
        });

    // Function to check if all mandatory files are selected
    function checkMandatoryFiles() {
        return mandatorySelects.every(select => select.value !== "");
    }

    // Enable/disable the run button based on file selection
    mandatorySelects.forEach(select => {
        select.addEventListener('change', function() {
            runPipelineBtn.disabled = !checkMandatoryFiles();
        });
    });

    // Event listener for the Run Pipeline button
    runPipelineBtn.addEventListener('click', function() {
        if (checkMandatoryFiles()) {
            runPipelineBtn.disabled = true;
            runPipelineBtn.textContent = 'Running Pipeline...';
            pipelineStatusDiv.textContent = 'Pipeline started. Please wait...';

            const payload = {
                forward_reads_file: forwardReadsSelect.value,
                reverse_reads_file: reverseReadsSelect.value,
                reference_genome_file: referenceGenomeSelect.value,
                target_regions_file: targetRegionsSelect.value,
                known_variants_file: knownVariantsSelect.value === "None" ? null : knownVariantsSelect.value
            };

            fetch('/run_pipeline', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            })
            .then(response => response.json())
            .then(data => {
                runPipelineBtn.disabled = false;
                runPipelineBtn.textContent = 'Run Pipeline';
                pipelineStatusDiv.textContent = data.message || 'Pipeline completed.';
                if (data.stdout) {
                    console.log('Pipeline Output:', data.stdout);
                }
                if (data.stderr) {
                    console.error('Pipeline Errors:', data.stderr);
                }
            })
            .catch(error => {
                runPipelineBtn.disabled = false;
                runPipelineBtn.textContent = 'Run Pipeline';
                pipelineStatusDiv.textContent = 'Error running the pipeline.';
                console.error('Error running pipeline:', error);
            });
        } else {
            pipelineStatusDiv.textContent = 'Please select all mandatory input files.';
        }
    });
});
