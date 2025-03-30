document.addEventListener('DOMContentLoaded', function() {
    // --- DOM Element References ---
    const forwardReadsSelect = document.getElementById('forwardReads');
    const reverseReadsSelect = document.getElementById('reverseReads');
    const referenceGenomeSelect = document.getElementById('referenceGenome');
    const targetRegionsSelect = document.getElementById('targetRegions');
    const knownVariantsSelect = document.getElementById('knownVariants');
    const runPipelineBtn = document.getElementById('runPipelineBtn');
    const pipelineStatusDiv = document.getElementById('pipeline-status');
    const mandatorySelects = [forwardReadsSelect, reverseReadsSelect, referenceGenomeSelect, targetRegionsSelect];

    // --- State Variables ---
    let currentJobId = null;    // Store the ID of the currently running/polling job
    let pollingInterval = null; // Store the interval timer for polling

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
     * @param {boolean} isRunning Is a job currently running or being polled?
     * @param {string} statusMessage The message to display in the status div.
     */
    function updateUI(isRunning, statusMessage) {
        pipelineStatusDiv.textContent = statusMessage;
        runPipelineBtn.disabled = isRunning;
        runPipelineBtn.textContent = isRunning ? 'Pipeline Running...' : 'Run Pipeline';
    }

    /**
     * Stops the periodic polling for job status.
     */
    function stopPolling() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
            console.log("Stopped polling for job status.");
            // Reset UI only if the job is confirmed finished/failed by pollJobStatus
        }
        currentJobId = null; // Clear current job ID when stopping
    }

    /**
     * Fetches the status for a given job ID from the backend API.
     * Updates the UI based on the fetched status.
     * Stops polling if the job is finished or failed.
     * @param {string} jobId The ID of the job to check.
     */
    function pollJobStatus(jobId) {
        console.log(`Polling status for job ${jobId}...`);
        if (!jobId) {
            console.warn("pollJobStatus called without a job ID.");
            stopPolling(); // Should not happen, but safety check
            updateUI(false, "Error: No job ID to track.");
            return;
        }

        fetch(`/job_status/${jobId}`)
            .then(response => {
                if (!response.ok) {
                    // Handle server errors (like 404 Not Found, 500 Server Error)
                    return response.json().then(errData => {
                        throw new Error(`HTTP error ${response.status}: ${errData.detail || response.statusText}`);
                    });
                }
                return response.json();
            })
            .then(data => {
                console.log("Job Status Data:", data);
                let statusMessage = `Job ${data.job_id}: ${data.status}`;
                let jobFinished = false;

                switch (data.status) {
                    case 'queued':
                        statusMessage += ' - Waiting for worker...';
                        break;
                    case 'started':
                        statusMessage += ' - Running...';
                        // Future: Could update a progress bar based on job.meta if implemented
                        break;
                    case 'finished':
                        statusMessage += ' - Completed!';
                        if (data.result) {
                            if (data.result.status === 'success') {
                                statusMessage += data.result.results_path ? ` Results: ${data.result.results_path}` : '';
                                // Optional: Automatically refresh results page or show link
                                // window.location.href = '/results'; // Or update dynamically
                            } else { // Handle non-success results if task returns them
                                statusMessage += ` Status: ${data.result.message || 'Finished with issues.'}`;
                            }
                        }
                        jobFinished = true;
                        break;
                    case 'failed':
                        statusMessage += ' - Failed!';
                        // Show a user-friendly error. Detailed error logged by server & visible in RQ dashboard.
                        statusMessage += ' Check server logs for details.';
                        console.error("Job Failed:", data.error || "No error details provided.");
                        jobFinished = true;
                        break;
                    case 'deferred':
                        statusMessage += ' - Deferred. Waiting for dependency.';
                        break;
                     case 'scheduled':
                        statusMessage += ' - Scheduled for later execution.';
                        break;
                    default:
                        statusMessage += ' - Unknown status.';
                        break;
                }

                // Update UI only if the polling is still for the *current* job
                if (currentJobId === jobId) {
                    updateUI(!jobFinished, statusMessage);
                    if (jobFinished) {
                        stopPolling(); // Stop polling if job is finished or failed
                    }
                } else {
                     console.log(`Received status for old job ${jobId}, but current job is ${currentJobId}. Ignoring.`);
                }
            })
            .catch(error => {
                console.error('Error polling job status:', error);
                // Update UI only if the polling is still for the *current* job
                 if (currentJobId === jobId) {
                    updateUI(false, `Error checking job status: ${error.message}. Please try again later.`);
                    stopPolling(); // Stop polling on error
                 }
            });
    }

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
             runPipelineBtn.disabled = !checkMandatoryFiles();
        })
        .catch(error => {
            console.error('Error fetching file list:', error);
            updateUI(false, 'Error fetching file list. Cannot run pipeline.');
            runPipelineBtn.disabled = true; // Keep button disabled
        });

    // Add event listeners to mandatory selects to enable/disable the run button
    mandatorySelects.forEach(select => {
        select.addEventListener('change', () => {
            runPipelineBtn.disabled = !checkMandatoryFiles();
        });
    });


    // --- Run Pipeline Button Event Listener ---
    runPipelineBtn.addEventListener('click', function() {
        if (!checkMandatoryFiles()) {
            updateUI(false, 'Please select all mandatory input files.');
            return; // Exit if mandatory files aren't selected
        }

        // Stop any previous polling before starting a new job
        stopPolling();

        // Update UI to indicate job submission
        updateUI(true, 'Sending job to queue...');

        // Prepare payload for the backend API
        const payload = {
            forward_reads_file: forwardReadsSelect.value,
            reverse_reads_file: reverseReadsSelect.value,
            reference_genome_file: referenceGenomeSelect.value,
            target_regions_file: targetRegionsSelect.value,
            // Send null if "None" (empty string) is selected, otherwise send the filename
            known_variants_file: knownVariantsSelect.value === "" ? null : knownVariantsSelect.value
        };

        // Send the request to the backend to enqueue the job
        fetch('/run_pipeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(response => {
            // Check if the request was accepted (status code 202) or if there was an error
            if (response.status === 202) {
                return response.json(); // Job was likely queued successfully
            } else {
                 // Handle other statuses like 400 (Bad Request), 500 (Server Error), 503 (Service Unavailable)
                return response.json().then(errData => {
                     throw new Error(`Failed to queue job (${response.status}): ${errData.detail || response.statusText}`);
                });
            }
        })
        .then(data => {
            if (data.job_id) {
                currentJobId = data.job_id; // Store the new job ID
                updateUI(true, `Job ${currentJobId} queued. Waiting for status...`);
                // Start polling immediately and then periodically
                pollJobStatus(currentJobId); // Initial poll
                pollingInterval = setInterval(() => pollJobStatus(currentJobId), 5000); // Poll every 5 seconds
            } else {
                // Should not happen if status is 202, but handle defensively
                updateUI(false, data.message || 'Failed to queue job (no job ID received).');
            }
        })
        .catch(error => {
            console.error('Error submitting pipeline job:', error);
            updateUI(false, `Error submitting job: ${error.message}`);
        });
    });
});
