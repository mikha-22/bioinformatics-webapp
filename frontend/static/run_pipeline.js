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
    const allSelects = [forwardReadsSelect, reverseReadsSelect, referenceGenomeSelect, targetRegionsSelect, knownVariantsSelect];

    // --- Helper Functions ---

    /**
     * Populates a select dropdown with files matching given extensions,
     * preserving the first (placeholder) option.
     * @param {HTMLSelectElement} selectElement - The dropdown element.
     * @param {Array<Object>} files - Array of file objects (e.g., { name: "file.txt" }).
     * @param {Array<string>} extensions - Array of valid file extensions (e.g., ['.txt', '.csv']).
     */
    function populateDropdown(selectElement, files, extensions) {
        // Keep the first option (placeholder)
        // selectElement.length = 1; // Use this if you need to clear previous dynamic options first
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

    /**
     * Checks if all mandatory select elements have a value selected.
     * @returns {boolean} True if all mandatory files are selected, false otherwise.
     */
    function checkMandatoryFiles() {
        return mandatorySelects.every(select => select.value !== "");
    }

    /**
     * Resets all form select elements to their initial state (value="").
     * Disables the staging button.
     * NOTE: Does NOT clear the pipeline status message, allowing success/error messages to persist.
     */
    function resetForm() {
        allSelects.forEach(select => {
            select.value = ""; // Reset to the option with value="" (placeholder or "None")
        });
        // Explicitly disable the button after resetting
        addToStagingBtn.disabled = true;
        // The status message is intentionally NOT cleared here.
        // It will be cleared by user interaction via the 'change' listeners.
    }

    /**
     * Updates the UI elements: status message, button text, and button disabled state.
     * @param {boolean} isSubmitting - Whether the form is currently being submitted.
     * @param {string} statusMessage - The message to display (HTML allowed).
     * @param {string} [messageType='info'] - The Bootstrap alert type ('info', 'success', 'warning', 'danger').
     */
    function updateUI(isSubmitting, statusMessage, messageType = 'info') {
        pipelineStatusDiv.innerHTML = statusMessage;
        // Show/hide the status div based on whether there's a message
        pipelineStatusDiv.className = `mt-3 alert alert-${messageType} ${statusMessage ? '' : 'd-none'}`;

        // Button should be disabled if submitting OR if mandatory files aren't selected
        addToStagingBtn.disabled = isSubmitting || !checkMandatoryFiles();
        addToStagingBtn.textContent = isSubmitting ? 'Staging...' : 'Add to Staging';
    }


    // --- Initial Setup: Fetch file list and populate dropdowns ---
    fetch('/get_data')
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response.json();
        })
        .then(data => {
            // Populate mandatory dropdowns
            populateDropdown(forwardReadsSelect, data, ['.fastq', '.fastq.gz', '.fq', '.fq.gz']);
            populateDropdown(reverseReadsSelect, data, ['.fastq', '.fastq.gz', '.fq', '.fq.gz']);
            populateDropdown(referenceGenomeSelect, data, ['.fasta', '.fasta.gz', '.fa', '.fa.gz']);
            populateDropdown(targetRegionsSelect, data, ['.bed']);

            // Setup optional dropdown (Known Variants)
            knownVariantsSelect.length = 1; // Keep only the placeholder
            const noneOption = document.createElement('option');
            noneOption.value = ""; // Value matches resetForm logic and placeholder
            noneOption.textContent = "None (Optional)";
            noneOption.selected = true; // Make this the default selectable option
            knownVariantsSelect.appendChild(noneOption);
            populateDropdown(knownVariantsSelect, data, ['.vcf', '.vcf.gz']); // Add actual VCF files

            // Ensure all selects start at their placeholder/None state
            allSelects.forEach(select => {
                 select.value = "";
            });

            // Set initial button state based on mandatory fields
            addToStagingBtn.disabled = !checkMandatoryFiles();
        })
        .catch(error => {
            console.error('Error fetching file list:', error);
            updateUI(false, `Error fetching file list: ${error.message}. Cannot stage job.`, 'danger');
            addToStagingBtn.disabled = true;
            allSelects.forEach(s => s.disabled = true); // Disable selects if file list fails
        });

    // --- Event Listeners for Select Changes ---

    // Update button state and clear status message when mandatory fields change
    mandatorySelects.forEach(select => {
        select.addEventListener('change', () => {
            const isSubmitting = addToStagingBtn.textContent === 'Staging...';
            addToStagingBtn.disabled = isSubmitting || !checkMandatoryFiles();
            // Clear status message on user interaction (unless already submitting)
            if (!isSubmitting) {
                 updateUI(false, '', 'info'); // Reset message but maintain button state logic
            }
        });
    });

    // Clear status message when optional field changes (button state doesn't depend on it)
    knownVariantsSelect.addEventListener('change', () => {
        const isSubmitting = addToStagingBtn.textContent === 'Staging...';
        if (!isSubmitting) {
             updateUI(false, '', 'info'); // Reset message
        }
    });

    // --- Add to Staging Button Event Listener ---
    addToStagingBtn.addEventListener('click', function() {
        if (!checkMandatoryFiles()) {
            updateUI(false, 'Please select all mandatory input files.', 'warning');
            return; // Stop if validation fails
        }

        // Update UI to indicate submission is in progress
        updateUI(true, 'Staging job...', 'info');

        const payload = {
            forward_reads_file: forwardReadsSelect.value,
            reverse_reads_file: reverseReadsSelect.value,
            reference_genome_file: referenceGenomeSelect.value,
            target_regions_file: targetRegionsSelect.value,
            // Send null if "None" or placeholder is selected, otherwise send the file name
            known_variants_file: knownVariantsSelect.value === "" ? null : knownVariantsSelect.value
        };

        // Send the request to the backend
        fetch('/run_pipeline', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json' // Indicate we expect JSON back
            },
            body: JSON.stringify(payload)
        })
        .then(async response => { // Use async to easily await potential error JSON
            if (response.ok) {
                return response.json(); // Success case (e.g., 200 OK)
            }
            // Handle HTTP errors (e.g., 400, 422, 500)
            let errorDetail = `HTTP ${response.status}: ${response.statusText}`;
            try {
                // Try to parse JSON error detail from backend
                const errData = await response.json();
                errorDetail = `Failed to stage job (${response.status}): ${errData.detail || response.statusText}`;
            } catch (e) {
                // Ignore if response body isn't JSON or parsing fails
            }
            throw new Error(errorDetail); // Throw an error to be caught by .catch()
        })
        .then(data => {
            // Handle successful staging response
            if (data.staged_job_id) {
                const successMessage = `Success! Job staged with ID: <code>${data.staged_job_id}</code>. <br>Go to the <a href="/jobs" class="alert-link">Jobs Dashboard</a> to monitor and start the job.`;
                // Show success message (button will be re-enabled by updateUI)
                updateUI(false, successMessage, 'success');
                // Reset the form selections and disable the button again
                resetForm();
            } else {
                // Handle unexpected success response (e.g., missing job ID)
                updateUI(false, data.message || 'Job staged, but no ID received. Check Jobs Dashboard.', 'warning');
                // Don't reset form in this case, user might need to see selections or retry
            }
        })
        .catch(error => {
            // Handle fetch errors or errors thrown from .then(response => ...)
            console.error('Error submitting pipeline job for staging:', error);
            // Show error message (button will be re-enabled by updateUI if mandatory files are still selected)
            updateUI(false, `Error staging job: ${error.message}`, 'danger');
        });
    });
});
