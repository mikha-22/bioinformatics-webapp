--- START FILE: ./frontend/static/run_pipeline.js ---
document.addEventListener('DOMContentLoaded', function() {
    // --- DOM Element References ---
    const forwardReadsSelect = document.getElementById('forwardReads');
    const reverseReadsSelect = document.getElementById('reverseReads');
    const referenceGenomeSelect = document.getElementById('referenceGenome');
    const targetRegionsSelect = document.getElementById('targetRegions');
    const knownVariantsSelect = document.getElementById('knownVariants');
    // *** Updated button ID ***
    const addToQueueBtn = document.getElementById('addToQueueBtn');
    const pipelineStatusDiv = document.getElementById('pipeline-status');
    const mandatorySelects = [forwardReadsSelect, reverseReadsSelect, referenceGenomeSelect, targetRegionsSelect];

    // --- State Variables ---
    // *** No longer need currentJobId or pollingInterval here for RQ polling ***
    // let currentJobId = null;
    // let pollingInterval = null;

    // --- Helper Functions ---

    /**
     * Populates a dropdown select element with files matching given extensions.
     * @param {HTMLSelectElement} selectElement The <select> element to populate.
     * @param {Array<Object>} files Array of file objects {name: string, type: string}.
     * @param {Array<string>} extensions Array of allowed file extensions (e.g., ['.fastq', '.fq.gz']).
     */
    function populateDropdown(selectElement, files, extensions) {
        // Clear existing options except the placeholder
        selectElement.length = 1; // Keep the first disabled option

        if (!files || files.length === 0) return; // Exit if no files

        files.forEach(file => {
            // Check if file name ends with any of the allowed extensions
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
     * @returns {boolean} True if all mandatory fields are selected, false otherwise.
     */
    function checkMandatoryFiles() {
        return mandatorySelects.every(select => select.value !== "");
    }

    /**
     * Updates the UI elements (button, status text) based on the current state.
     * @param {boolean} isSubmitting Is a job currently being submitted?
     * @param {string} statusMessage The message to display in the status div.
     * @param {string} messageType 'info', 'success', 'error' for styling (optional)
     */
    function updateUI(isSubmitting, statusMessage, messageType = 'info') {
        pipelineStatusDiv.textContent = statusMessage;
        pipelineStatusDiv.className = `mt-3 alert alert-${messageType === 'info' ? 'secondary' : messageType}`; // Add Bootstrap alert classes

        addToQueueBtn.disabled = isSubmitting || !checkMandatoryFiles(); // Disable if submitting or files not selected
        addToQueueBtn.textContent = isSubmitting ? 'Adding...' : 'Add to Queue';
    }

    // *** Polling functions (pollJobStatus, stopPolling) are removed from this file ***
    // *** as polling is not initiated from here anymore.              ***

    // --- Initial Setup ---

    // Fetch the list of files from the backend on page load
    fetch('/get_data')
        .then(response => response.json())
        .then(data => {
            // Populate dropdowns with appropriate file types
            populateDropdown(forwardReadsSelect, data, ['.fastq', '.fastq.gz', '.fq', '.fq.gz']);
            populateDropdown(reverseReadsSelect, data, ['.fastq', '.fastq.gz', '.fq', '.fq.gz']);
            populateDropdown(referenceGenomeSelect, data, ['.fasta', '.fasta.gz', '.fa', '.fa.gz']);
            populateDropdown(targetRegionsSelect, data, ['.bed']);
            // Populate optional variants, adding a "None" option
            const noneOption = document.createElement('option');
            noneOption.value = ""; // Use empty string for "None"
            noneOption.textContent = "None";
            knownVariantsSelect.appendChild(noneOption); // Add "None" after the placeholder
            populateDropdown(knownVariantsSelect, data, ['.vcf', '.vcf.gz']);

            // Initial check to enable button if selections might be pre-filled
             addToQueueBtn.disabled = !checkMandatoryFiles();
        })
        .catch(error => {
            console.error('Error fetching file list:', error);
            updateUI(false, 'Error fetching file list. Cannot run pipeline.', 'error');
            addToQueueBtn.disabled = true; // Keep button disabled
        });

    // Add event listeners to mandatory selects to enable/disable the run button
    mandatorySelects.forEach(select => {
        select.addEventListener('change', () => {
            // Enable button only if mandatory files are selected and not currently submitting
            const isSubmitting = addToQueueBtn.textContent === 'Adding...';
            addToQueueBtn.disabled = isSubmitting || !checkMandatoryFiles();
            if (!isSubmitting) {
                pipelineStatusDiv.textContent = ''; // Clear status on selection change if not submitting
                pipelineStatusDiv.className = 'mt-3'; // Reset classes
            }
        });
    });


    // --- Add to Queue Button Event Listener ---
    addToQueueBtn.addEventListener('click', function() {
        if (!checkMandatoryFiles()) {
            updateUI(false, 'Please select all mandatory input files.', 'warning');
            return; // Exit if mandatory files aren't selected
        }

        // Update UI to indicate job submission
        updateUI(true, 'Adding job to queue...', 'info');

        // Prepare payload for the backend API
        const payload = {
            forward_reads_file: forwardReadsSelect.value,
            reverse_reads_file: reverseReadsSelect.value,
            reference_genome_file: referenceGenomeSelect.value,
            target_regions_file: targetRegionsSelect.value,
            // Send null if "None" (empty string) is selected, otherwise send the filename
            known_variants_file: knownVariantsSelect.value === "" ? null : knownVariantsSelect.value
        };

        // Send the request to the backend to STAGE the job
        fetch('/run_pipeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(response => {
            // Check for successful staging (status code 200) or errors
            if (response.ok) { // Status 200-299
                return response.json(); // Job was likely staged successfully
            } else {
                 // Handle errors like 400 (Bad Request), 500 (Server Error), 503 (Service Unavailable)
                return response.json().then(errData => {
                     throw new Error(`Failed to stage job (${response.status}): ${errData.detail || response.statusText}`);
                });
            }
        })
        .then(data => {
            // Job was successfully staged by the backend
            if (data.staged_job_id) {
                updateUI(false, `Success! Job staged with ID: ${data.staged_job_id}. Go to the 'Jobs Queue' page to start it.`, 'success');
                // *** DO NOT START POLLING HERE ***
                // Clear form selections? Optional.
                // forwardReadsSelect.value = "";
                // reverseReadsSelect.value = "";
                // referenceGenomeSelect.value = "";
                // targetRegionsSelect.value = "";
                // knownVariantsSelect.value = "";
                // addToQueueBtn.disabled = true; // Disable button again after success until new selections
            } else {
                // Should not happen if status is 200 and backend logic is correct
                updateUI(false, data.message || 'Failed to stage job (no staged job ID received).', 'error');
            }
        })
        .catch(error => {
            console.error('Error submitting pipeline job for staging:', error);
            updateUI(false, `Error staging job: ${error.message}`, 'error');
        });
    });
});
--- END FILE: ./frontend/static/run_pipeline.js ---
