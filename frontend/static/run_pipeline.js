document.addEventListener('DOMContentLoaded', function() {
    // --- DOM Element References ---
    const forwardReadsSelect = document.getElementById('forwardReads');
    const reverseReadsSelect = document.getElementById('reverseReads');
    const referenceGenomeSelect = document.getElementById('referenceGenome');
    const targetRegionsSelect = document.getElementById('targetRegions');
    const knownVariantsSelect = document.getElementById('knownVariants');
    const addToStagingBtn = document.getElementById('addToStagingBtn');
    const pipelineStatusDiv = document.getElementById('pipeline-status');
    const mandatorySelects = [forwardReadsSelect, reverseReadsSelect, referenceGenomeSelect, targetRegionsSelect];
    // --- MODIFIED: Include knownVariantsSelect for easier reset ---
    const allSelects = [forwardReadsSelect, reverseReadsSelect, referenceGenomeSelect, targetRegionsSelect, knownVariantsSelect];

    // --- Helper Functions ---

    function populateDropdown(selectElement, files, extensions) {
        // --- Keep the first option (the placeholder) ---
        // selectElement.length = 1; // <-- REMOVE THIS LINE or adjust if you want to rebuild placeholders too
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
     * Resets all form select elements to their initial ("None"/placeholder) state.
     * Sets the value to "" which selects the first <option> with value=""
     * (either the disabled placeholder or the added "None" option).
     * Also disables the staging button.
     */
    function resetForm() {
        allSelects.forEach(select => {
            select.value = ""; // Reset to the option with value=""
        });
        // Explicitly disable the button after resetting
        addToStagingBtn.disabled = true;
        // Optionally clear status message immediately after reset
        pipelineStatusDiv.innerHTML = '';
        pipelineStatusDiv.className = 'mt-3 d-none';
    }


    function updateUI(isSubmitting, statusMessage, messageType = 'info') {
        pipelineStatusDiv.innerHTML = statusMessage;
        // Make sure message is visible if there is content
        pipelineStatusDiv.className = `mt-3 alert alert-${messageType} ${statusMessage ? '' : 'd-none'}`;

        // Update button state
        // Button should be disabled if submitting OR if mandatory files aren't selected
        addToStagingBtn.disabled = isSubmitting || !checkMandatoryFiles();

        // Update button text
        addToStagingBtn.textContent = isSubmitting ? 'Staging...' : 'Add to Staging';
    }


    // --- Initial Setup ---
    fetch('/get_data')
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response.json();
        })
        .then(data => {
            // Populate mandatory dropdowns (keeping placeholder)
            populateDropdown(forwardReadsSelect, data, ['.fastq', '.fastq.gz', '.fq', '.fq.gz']);
            populateDropdown(reverseReadsSelect, data, ['.fastq', '.fastq.gz', '.fq', '.fq.gz']);
            populateDropdown(referenceGenomeSelect, data, ['.fasta', '.fasta.gz', '.fa', '.fa.gz']);
            populateDropdown(targetRegionsSelect, data, ['.bed']);

            // Handle optional dropdown: Clear existing options except placeholder, add "None", then files
            knownVariantsSelect.length = 1; // Keep only the placeholder initially
            const noneOption = document.createElement('option');
            // --- Ensure value is "" to match resetForm logic ---
            noneOption.value = "";
            noneOption.textContent = "None (Optional)";
            // --- Make this "None" option selected by default after population ---
            noneOption.selected = true; // Make this the default *selectable* option
            knownVariantsSelect.appendChild(noneOption);
            // Now populate the actual VCF files
            populateDropdown(knownVariantsSelect, data, ['.vcf', '.vcf.gz']);
            // --- Set value to "" to ensure the added "None" or placeholder is selected ---
            knownVariantsSelect.value = ""; // Selects the <option value="">

            // --- Ensure initial state selects the placeholder/None option for ALL selects ---
            allSelects.forEach(select => {
                 select.value = ""; // This ensures the <option value=""> is selected initially
            });

            addToStagingBtn.disabled = !checkMandatoryFiles(); // Initial check based on mandatory fields
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
            // Clear status message when user interacts (unless submitting)
            if (!isSubmitting) {
                 updateUI(false, '', 'info');
            }
        });
    });
    // Also listen to optional select change for UI consistency if needed (optional)
    knownVariantsSelect.addEventListener('change', () => {
        const isSubmitting = addToStagingBtn.textContent === 'Staging...';
        if (!isSubmitting) {
             updateUI(false, '', 'info');
        }
        // Button state depends only on mandatory fields, so no need to update disable state here
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
            // Send null if value is "", otherwise send the selected file
            known_variants_file: knownVariantsSelect.value === "" ? null : knownVariantsSelect.value
        };

        fetch('/run_pipeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(async response => {
            if (response.ok) return response.json(); // Expect 200 OK for staging success now
            // Handle potential errors (like validation errors from backend)
            let errorDetail = `HTTP ${response.status}: ${response.statusText}`;
            try {
                const errData = await response.json();
                errorDetail = `Failed to stage job (${response.status}): ${errData.detail || response.statusText}`;
            } catch (e) { /* Ignore if response body isn't JSON */ }
            throw new Error(errorDetail);
        })
        .then(data => {
            if (data.staged_job_id) {
                const successMessage = `Success! Job staged with ID: <code>${data.staged_job_id}</code>. <br>Go to the <a href="/jobs" class="alert-link">Jobs Dashboard</a> to monitor and start the job.`;
                // Update UI FIRST to show success message (keeps button disabled for a moment)
                updateUI(false, successMessage, 'success');
                // --- THEN Reset the form ---
                resetForm(); // This will set selects to "" and disable the button
            } else {
                // Handle cases where staging might succeed but not return expected ID (unlikely with current backend)
                updateUI(false, data.message || 'Job staged, but no ID received. Check Jobs Dashboard.', 'warning');
                // Don't reset form if ID wasn't received, user might want to retry
            }
        })
        .catch(error => {
            console.error('Error submitting pipeline job for staging:', error);
            // Show error, keep button enabled (updateUI handles this)
            updateUI(false, `Error staging job: ${error.message}`, 'danger');
        });
    });
});
