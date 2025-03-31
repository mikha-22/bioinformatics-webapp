document.addEventListener('DOMContentLoaded', function() {
    // --- DOM Element References ---
    const forwardReadsSelect = document.getElementById('forwardReads');
    const reverseReadsSelect = document.getElementById('reverseReads');
    const referenceGenomeSelect = document.getElementById('referenceGenome');
    const targetRegionsSelect = document.getElementById('targetRegions');
    const knownVariantsSelect = document.getElementById('knownVariants');
    // *** Use the NEW Button ID from HTML ***
    const addToStagingBtn = document.getElementById('addToStagingBtn');
    const pipelineStatusDiv = document.getElementById('pipeline-status');
    const mandatorySelects = [forwardReadsSelect, reverseReadsSelect, referenceGenomeSelect, targetRegionsSelect];
    const allSelects = [...mandatorySelects, knownVariantsSelect]; // Helper array for reset

    // --- Helper Functions ---

    function populateDropdown(selectElement, files, extensions) {
        selectElement.length = 1;
        if (!files || files.length === 0) return;
        const sortedFiles = files.sort((a, b) => a.name.localeCompare(b.name));
        sortedFiles.forEach(file => {
            if (extensions.some(ext => file.name.toLowerCase().endsWith(ext.toLowerCase()))) {
                const option = document.createElement('option');
                option.value = file.name;
                option.textContent = file.name;
                selectElement.appendChild(option);
            }
        });
    }

    function checkMandatoryFiles() {
        return mandatorySelects.every(select => select.value !== "");
    }

    /**
     * Resets all form select elements to their initial state.
     */
    function resetForm() {
        allSelects.forEach(select => {
            select.value = ""; // Set value to empty string to select the placeholder/None option
        });
        // Explicitly disable the button after resetting
        addToStagingBtn.disabled = true;
        // Optionally clear the status message immediately, or let the next UI update handle it
        // pipelineStatusDiv.innerHTML = '';
        // pipelineStatusDiv.className = 'mt-3 d-none';
    }


    function updateUI(isSubmitting, statusMessage, messageType = 'info') {
        pipelineStatusDiv.innerHTML = statusMessage;
        pipelineStatusDiv.className = `mt-3 alert alert-${messageType} ${statusMessage ? '' : 'd-none'}`;

        // Update button state *unless* a reset just happened (resetForm handles disabling)
        if (!isSubmitting && addToStagingBtn.textContent !== 'Add to Staging') {
             addToStagingBtn.disabled = !checkMandatoryFiles();
        } else {
             addToStagingBtn.disabled = isSubmitting || !checkMandatoryFiles();
        }

        // *** Update button text ***
        addToStagingBtn.textContent = isSubmitting ? 'Staging...' : 'Add to Staging';
    }


    // --- Initial Setup ---
    fetch('/get_data')
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response.json();
        })
        .then(data => {
            populateDropdown(forwardReadsSelect, data, ['.fastq', '.fastq.gz', '.fq', '.fq.gz']);
            populateDropdown(reverseReadsSelect, data, ['.fastq', '.fastq.gz', '.fq', '.fq.gz']);
            populateDropdown(referenceGenomeSelect, data, ['.fasta', '.fasta.gz', '.fa', '.fa.gz']);
            populateDropdown(targetRegionsSelect, data, ['.bed']);

            knownVariantsSelect.length = 1; // Clear existing options except placeholder
            const noneOption = document.createElement('option');
            noneOption.value = "";
            noneOption.textContent = "None (Optional)";
            knownVariantsSelect.appendChild(noneOption);
            populateDropdown(knownVariantsSelect, data, ['.vcf', '.vcf.gz']);
            knownVariantsSelect.value = "";

            addToStagingBtn.disabled = !checkMandatoryFiles(); // Initial check
        })
        .catch(error => {
            console.error('Error fetching file list:', error);
            updateUI(false, `Error fetching file list: ${error.message}. Cannot stage job.`, 'danger');
            addToStagingBtn.disabled = true;
            allSelects.forEach(s => s.disabled = true); // Disable selects on error
        });

    // Event listeners to enable/disable the stage button
    mandatorySelects.forEach(select => {
        select.addEventListener('change', () => {
            const isSubmitting = addToStagingBtn.textContent === 'Staging...';
            addToStagingBtn.disabled = isSubmitting || !checkMandatoryFiles();
            if (!isSubmitting) {
                 updateUI(false, '', 'info'); // Clear status message only if not submitting
            }
        });
    });

    // --- Add to Staging Button Event Listener ---
    addToStagingBtn.addEventListener('click', function() {
        if (!checkMandatoryFiles()) {
            updateUI(false, 'Please select all mandatory input files.', 'warning');
            return;
        }

        updateUI(true, 'Staging job...', 'info'); // Show submitting state

        const payload = {
            forward_reads_file: forwardReadsSelect.value,
            reverse_reads_file: reverseReadsSelect.value,
            reference_genome_file: referenceGenomeSelect.value,
            target_regions_file: targetRegionsSelect.value,
            known_variants_file: knownVariantsSelect.value === "" ? null : knownVariantsSelect.value
        };

        fetch('/run_pipeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(async response => {
            if (response.ok) return response.json();
            let errorDetail = `HTTP ${response.status}: ${response.statusText}`;
            try {
                const errData = await response.json();
                errorDetail = `Failed to stage job (${response.status}): ${errData.detail || response.statusText}`;
            } catch (e) { /* Ignore */ }
            throw new Error(errorDetail);
        })
        .then(data => {
            if (data.staged_job_id) {
                const successMessage = `Success! Job staged with ID: <code>${data.staged_job_id}</code>. <br>Go to the <a href="/jobs" class="alert-link">Jobs Dashboard</a> to monitor and start the job.`;
                // Update UI FIRST to show success message
                updateUI(false, successMessage, 'success');
                // THEN reset the form fields (this will also disable the button)
                resetForm();
            } else {
                updateUI(false, data.message || 'Job staged, but no ID received. Check Jobs Dashboard.', 'warning');
                // Don't reset form if ID wasn't received, might be a partial success/error
            }
        })
        .catch(error => {
            console.error('Error submitting pipeline job for staging:', error);
            // Show error, keep button enabled (updateUI handles this)
            updateUI(false, `Error staging job: ${error.message}`, 'danger');
        });
    });
});
