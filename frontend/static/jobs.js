// frontend/static/jobs.js
document.addEventListener('DOMContentLoaded', function() {
    const jobsTableBody = document.querySelector('#jobs-table tbody');
    const globalStatusDiv = document.getElementById('jobs-status-global');
    const refreshButton = document.getElementById('refresh-jobs-btn');
    const loadingRow = document.getElementById('loading-jobs-row');
    const noJobsRow = document.getElementById('no-jobs-row');
    const errorJobsRow = document.getElementById('error-jobs-row');
    const errorModal = document.getElementById('error-modal');
    const errorModalText = document.getElementById('error-modal-text');

    // --- State ---
    let jobPollingIntervals = {}; // Store polling intervals {jobId: intervalId}
    const POLLING_INTERVAL_MS = 5000; // Poll every 5 seconds
    const TERMINAL_STATUSES = ['finished', 'failed', 'stopped', 'canceled']; // Job statuses that don't need further polling

    // --- CSS Classes (makes changes easier) ---
    const BUTTON_CLASS_START = 'btn-start-job';
    const BUTTON_CLASS_STOP = 'btn-stop-job';
    const BUTTON_CLASS_RERUN = 'btn-rerun-job';
    const BUTTON_CLASS_RESULTS = 'btn-view-results';
    const BUTTON_CLASS_ERROR_DETAILS = 'btn-error-details';

    // --- Helper Functions ---
     /** Formats a timestamp (seconds since epoch) into a locale string, or returns 'N/A' */
     function formatTimestamp(timestamp) {
        if (!timestamp) return 'N/A';
        try {
            return new Date(timestamp * 1000).toLocaleString();
        } catch (e) {
            return 'Invalid Date';
        }
    }

     /** Formats duration in seconds into H:MM:SS or M:SS */
     function formatDuration(seconds) {
        if (seconds === null || seconds === undefined || seconds < 0) return 'N/A';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        let str = "";
        if (h > 0) str += `${h}:`;
        str += `${m.toString().padStart(h > 0 ? 2 : 1, '0')}:`; // Pad minutes if hours present
        str += s.toString().padStart(2, '0');
        return str;
    }

    /** Calculates duration between two timestamps */
    function calculateDuration(start, end) {
        if (!start || !end || end < start) return null;
        return end - start;
    }

    /** Shows a global status message */
    function showGlobalStatus(message, type = 'info') {
        globalStatusDiv.innerHTML = message;
        globalStatusDiv.className = `alert alert-${type} mb-3`;
        globalStatusDiv.style.display = 'block';
    }

    /** Clears the global status message */
    function clearGlobalStatus() {
         globalStatusDiv.textContent = '';
         globalStatusDiv.style.display = 'none';
         globalStatusDiv.className = '';
    }

    /** Safely get nested property */
    function getNested(obj, path, defaultValue = null) {
        try {
            return path.split('.').reduce((o, k) => (o || {})[k], obj) || defaultValue;
        } catch (e) {
            return defaultValue;
        }
    }


    // --- Job Rendering and Updating ---

    /** Creates a NEW job row and appends it */
    function createAndAppendJobRow(job) {
        const row = jobsTableBody.insertRow(-1); // Append at the end of tbody
        row.dataset.jobId = job.id;

        // --- Basic Info Cell (ID / Description) ---
        let cellInfo = row.insertCell();
        cellInfo.innerHTML = `
            <strong title="${job.id}">${job.id.substring(0, 15)}...</strong>
            <div class="text-muted" style="font-size: 0.9em;">${job.description || 'No Description'}</div>
        `;

        // --- Parameters Cell ---
        let cellParams = row.insertCell();
        // Prioritize meta.input_params.input_filenames if available (for rerunning/displaying original selection)
        let displayParams = getNested(job, 'meta.input_params.input_filenames', getNested(job, 'meta.input_params', {}));
        // If it's a staged job, the params are directly in meta.input_params
        if (job.status === 'staged' && Object.keys(displayParams).length === 0) {
            displayParams = getNested(job, 'meta.input_params', {});
        }

        let paramsHtml = '<div class="job-parameters">';
        if (Object.keys(displayParams).length > 0) {
            paramsHtml += Object.entries(displayParams)
                 // Adjust key display for 'input_filenames' structure if present
                 .map(([key, value]) => {
                      const displayKey = key.replace(/_/g, ' ');
                      // Handle both direct paths/values and nested structure
                      const displayValue = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : (value || 'None');
                      return `<div><small>${displayKey}:</small> <kbd>${displayValue}</kbd></div>`;
                  })
                 .join('');
        } else {
             paramsHtml += '<span>N/A</span>';
        }
         paramsHtml += '</div>';
        cellParams.innerHTML = paramsHtml;


        // --- Time Info Cell ---
        let cellTime = row.insertCell();
        updateTimeCell(cellTime, job); // Use helper for time

        // --- Status / Action Cell ---
        let cellAction = row.insertCell();
        cellAction.className = 'action-cell'; // Ensure class is set
        updateActionCell(cellAction, job); // Use helper for actions

        // --- Row Styling based on Status ---
        row.className = `job-state-${job.status || 'unknown'}`; // Apply class for styling

        // --- Manage Polling ---
        // Decide whether to start polling based on the initial status
        // --- MODIFIED: Only poll if the job is NOT staged AND NOT terminal ---
        if (job.status !== 'staged' && !TERMINAL_STATUSES.includes(job.status)) {
            console.log(`[Polling Check] Job ${job.id} has status ${job.status}, starting polling.`); // Optional debug log
            startPolling(job.id);
        } else {
            console.log(`[Polling Check] Job ${job.id} has status ${job.status}, NOT starting polling.`); // Optional debug log
        }
    }

     /** Updates the time cell content */
    function updateTimeCell(cell, job) {
        const durationSec = calculateDuration(job.started_at, job.ended_at);
        cell.innerHTML = `
            <div style="font-size: 0.85em;">
                ${job.status === 'staged' ? 'Staged:' : 'Enqueued:'} ${formatTimestamp(job.enqueued_at || job.staged_at)}<br>
                Started: ${formatTimestamp(job.started_at)}<br>
                Ended: ${formatTimestamp(job.ended_at)}<br>
                Duration: ${formatDuration(durationSec)}
            </div>
        `;
    }


    /** Updates the content of the Action Cell based on job status */
    function updateActionCell(cell, job) {
        let statusHtml = '';
        let buttonsHtml = '';

        // Determine status icon and text
        switch (job.status) {
            case 'staged':
                statusHtml = `<span class="job-status-text text-secondary"><i class="bi bi-pause-circle"></i> Staged</span>`;
                break;
            case 'queued':
                statusHtml = `<span class="job-status-text text-primary"><i class="bi bi-hourglass-split"></i> Queued</span>`;
                break;
            case 'started':
                statusHtml = `<span class="job-status-text text-info"><i class="fas fa-sync-alt fa-spin"></i> Running</span>`;
                const progress = getNested(job, 'meta.progress', null);
                if (progress !== null) {
                     statusHtml += `<div class="progress mt-1" style="height: 5px;"><div class="progress-bar" role="progressbar" style="width: ${progress}%;" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"></div></div>`;
                }
                break;
            case 'finished':
                statusHtml = `<span class="job-status-text text-success"><i class="bi bi-check-circle-fill"></i> Finished</span>`;
                break;
            case 'failed':
                statusHtml = `<span class="job-status-text text-danger"><i class="bi bi-x-octagon-fill"></i> Failed</span>`;
                break;
            case 'stopped':
            case 'canceled':
                 statusHtml = `<span class="job-status-text text-muted"><i class="bi bi-stop-circle"></i> ${job.status.charAt(0).toUpperCase() + job.status.slice(1)}</span>`;
                 break;
            default:
                statusHtml = `<span class="job-status-text text-muted"><i class="bi bi-question-circle"></i> ${job.status || 'Unknown'}</span>`;
        }

        // Determine buttons based on status
         if (job.status === 'staged') {
             buttonsHtml = `<button class="btn btn-success btn-sm ${BUTTON_CLASS_START}" data-staged-id="${job.id}">Start</button>`;
         } else if (job.status === 'queued' || job.status === 'started') {
             buttonsHtml = `<button class="btn btn-danger btn-sm ${BUTTON_CLASS_STOP}" data-job-id="${job.id}">Stop</button>`;
         } else if (job.status === 'finished') {
             const resultsPath = getNested(job, 'result.results_path', null);
             if (resultsPath) {
                  const dirName = resultsPath.split('/').pop();
                  buttonsHtml = `<a href="/results?highlight=${encodeURIComponent(dirName)}" class="btn btn-info btn-sm ${BUTTON_CLASS_RESULTS}" title="View results folder">Results</a>`;
             }
         } else if (job.status === 'failed') {
             buttonsHtml = `<button class="btn btn-secondary btn-sm ${BUTTON_CLASS_ERROR_DETAILS}" data-error="${job.error || 'No details available.'}">Details</button>`;
             // Check if we have the necessary params to enable rerun
             const rerunParams = getNested(job, 'meta.input_params.input_filenames', getNested(job, 'meta.input_params', {}));
             if (Object.keys(rerunParams).length > 0 && rerunParams.forward_reads) { // Basic check for presence of essential param
                 buttonsHtml += ` <button class="btn btn-warning btn-sm ${BUTTON_CLASS_RERUN}" data-job-id="${job.id}">Rerun</button>`;
             }
         } else if (job.status === 'stopped' || job.status === 'canceled') {
             // Optionally add Rerun button for stopped/canceled jobs
             const rerunParams = getNested(job, 'meta.input_params.input_filenames', getNested(job, 'meta.input_params', {}));
             if (Object.keys(rerunParams).length > 0 && rerunParams.forward_reads) {
                 buttonsHtml += ` <button class="btn btn-warning btn-sm ${BUTTON_CLASS_RERUN}" data-job-id="${job.id}">Rerun</button>`;
             }
         }


        cell.innerHTML = statusHtml + '<br>' + buttonsHtml;
    }

    /** Updates an existing row with new job data */
    function updateJobRow(row, job) {
        // Update parameters cell (useful if meta could change, though unlikely for inputs)
        // const paramsCell = row.cells[1];
        // updateParamsCell(paramsCell, job); // You'd need to create this helper if needed

        // Update time cell
        updateTimeCell(row.cells[2], job);
        // Update action cell
        updateActionCell(row.cells[3], job);
        // Update row styling class
        row.className = `job-state-${job.status || 'unknown'}`;

         // --- Manage Polling ---
         // Stop polling if the job has reached a terminal state
         if (TERMINAL_STATUSES.includes(job.status)) {
            // console.log(`Detected terminal state (${job.status}) for ${job.id}. Stopping polling.`); // Debug
            stopPolling(job.id);
         } else if (!jobPollingIntervals[job.id]) {
             // This case should ideally not happen if polling was managed correctly
             // but as a safeguard, start polling if it's active but not polling.
             console.warn(`Job ${job.id} is active (${job.status}) but was not polling. Restarting polling.`);
             startPolling(job.id);
         }
    }


    // --- API Calls ---

    /** Fetches the combined list of jobs from the backend */
    async function fetchJobsList() {
        clearGlobalStatus();
        loadingRow.style.display = '';
        noJobsRow.style.display = 'none';
        errorJobsRow.style.display = 'none';

        // --- FIX FOR ORDERING & REFRESH ---
        // 1. Store IDs of jobs currently being polled BEFORE clearing
        const currentlyPollingIds = new Set(Object.keys(jobPollingIntervals));

        // 2. Clear ALL existing job rows (excluding placeholders)
        jobsTableBody.querySelectorAll('tr[data-job-id]').forEach(row => row.remove());

        try {
            const response = await fetch('/jobs_list'); // Fetches sorted list (newest first)
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                throw new Error(`Failed to fetch jobs list (${response.status}): ${errorData.detail}`);
            }
            const jobs = await response.json(); // jobs[0] is the newest
            loadingRow.style.display = 'none';

            if (!jobs || jobs.length === 0) {
                noJobsRow.style.display = '';
                // Stop polling for any jobs that might have been polling before clear
                currentlyPollingIds.forEach(stopPolling);
                return;
            }

            const activeJobIdsThisFetch = new Set();
            // 3. Create and Append rows IN THE RECEIVED ORDER
            jobs.forEach(job => {
                createAndAppendJobRow(job); // This now appends, preserving backend sort order
                 if (job.status !== 'staged' && !TERMINAL_STATUSES.includes(job.status)) { // Use updated polling logic here too
                     activeJobIdsThisFetch.add(job.id);
                 }
            });

            // 4. Stop polling for jobs that were polling but are now gone or terminal or staged
            currentlyPollingIds.forEach(jobId => {
                if (!activeJobIdsThisFetch.has(jobId)) {
                     // Find the job in the fetched list to double-check its status
                     const fetchedJob = jobs.find(j => j.id === jobId);
                     if (fetchedJob && fetchedJob.status === 'staged') {
                         // Don't log stopping for staged, it's expected
                     } else {
                        // console.log(`Stopping polling for ${jobId} as it's no longer active or present.`); // Debug
                     }
                    stopPolling(jobId);
                }
            });

             // Check if table is empty after updates (shouldn't be if jobs.length > 0)
             if (jobsTableBody.querySelectorAll('tr[data-job-id]').length === 0) {
                  noJobsRow.style.display = '';
             }

        } catch (error) {
            console.error('Error fetching jobs list:', error);
            showGlobalStatus(`Error loading jobs: ${error.message}`, 'danger');
            loadingRow.style.display = 'none';
            errorJobsRow.style.display = '';
            // Stop any previously active polling on error
            Object.keys(jobPollingIntervals).forEach(stopPolling);
        }
    }

    /** Polls the status of a single job */
    async function pollJobStatus(jobId) {
         // console.log(`Polling job ${jobId}...`); // Debug logging
        try {
            const response = await fetch(`/job_status/${jobId}`);
            const row = jobsTableBody.querySelector(`tr[data-job-id="${jobId}"]`);

            if (!response.ok) {
                 if (response.status === 404) {
                     console.warn(`Job ${jobId} not found during polling. Stopping polling.`);
                     stopPolling(jobId);
                      // Do NOT mark as "Not Found" in the UI here, as the job might just be transitioning
                      // from staged to queued and the refresh hasn't caught up yet. Let fetchJobsList handle it.
                      // if(row) {
                      //     row.cells[3].innerHTML = `<span class="text-danger">Not Found</span>`;
                      //     row.className = 'job-state-unknown';
                      // }
                 } else {
                     const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                     console.error(`Error polling job ${jobId} (${response.status}): ${errorData.detail}`);
                     // Optionally add logic to stop polling after multiple consecutive errors
                 }
                 return;
            }

            const job = await response.json();

            if (row) {
                // console.log(`Updating row for ${jobId} with status: ${job.status}`); // Debug
                updateJobRow(row, job); // Update existing row
            } else {
                 // Job appeared during polling but wasn't in initial list? Stop polling.
                 console.warn(`Polled job ${jobId} but no row found (likely removed/refreshed). Stopping polling.`);
                 stopPolling(jobId);
             }

        } catch (error) {
            console.error(`Network error polling job ${jobId}:`, error);
            // Optionally add logic to stop polling if network fails repeatedly
        }
    }

    /** Starts polling for a specific job ID if not already polling */
    function startPolling(jobId) {
        if (!jobPollingIntervals[jobId]) {
            // console.log(`Starting polling for ${jobId}`); // Debug
            // Poll immediately once to get initial running state faster
            pollJobStatus(jobId);
            jobPollingIntervals[jobId] = setInterval(() => pollJobStatus(jobId), POLLING_INTERVAL_MS);
        }
    }

    /** Stops polling for a specific job ID */
    function stopPolling(jobId) {
        if (jobPollingIntervals[jobId]) {
             // console.log(`Stopping polling for ${jobId}`); // Debug
            clearInterval(jobPollingIntervals[jobId]);
            delete jobPollingIntervals[jobId];
        }
    }


    // --- Button Click Handlers ---
    /** Handle Start Button Click */
    async function handleStartClick(button) {
        const stagedJobId = button.dataset.stagedId;
        if (!stagedJobId) return;

        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';

        try {
            const response = await fetch(`/start_job/${stagedJobId}`, { method: 'POST', headers: { 'Accept': 'application/json' } });
            const result = await response.json();

            if (!response.ok) { // Check status code (e.g., 202 Accepted is OK)
                throw new Error(result.detail || `Failed to start job (${response.status})`);
            }

            showGlobalStatus(`Job ${result.job_id} enqueued successfully. Refreshing list...`, 'success');
            // Trigger a refresh to show the newly enqueued job correctly
             await fetchJobsList(); // Make sure refresh completes before potentially re-enabling button

        } catch (error) {
            console.error(`Error starting job ${stagedJobId}:`, error);
            showGlobalStatus(`Error starting job ${stagedJobId}: ${error.message}`, 'danger');
            // Re-enable button only if the row still exists and shows the start button
            const existingButton = jobsTableBody.querySelector(`button[data-staged-id="${stagedJobId}"]`);
            if (existingButton) {
                existingButton.disabled = false;
                existingButton.innerHTML = 'Start';
            }
        }
    }

    /** Handle Stop Button Click */
    async function handleStopClick(button) {
        const jobId = button.dataset.jobId;
        if (!jobId) return;

        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Stopping...';

        try {
            const response = await fetch(`/stop_job/${jobId}`, { method: 'POST', headers: { 'Accept': 'application/json' } });
            const result = await response.json();

             if (!response.ok) { // Check status code (e.g., 200 OK is fine)
                 throw new Error(result.detail || `Failed to stop job (${response.status})`);
             }

            showGlobalStatus(`Stop request for ${jobId}: ${result.message}`, 'info');
            // Poll will eventually update the status, or force an immediate poll:
            await pollJobStatus(jobId); // Request immediate update and wait for it

        } catch (error) {
            console.error(`Error stopping job ${jobId}:`, error);
            showGlobalStatus(`Error stopping job ${jobId}: ${error.message}`, 'danger');
             // Re-enable button only if the row still exists and shows the stop button
            const existingButton = jobsTableBody.querySelector(`button[data-job-id="${jobId}"].${BUTTON_CLASS_STOP}`);
            if(existingButton){
                existingButton.disabled = false;
                existingButton.innerHTML = 'Stop';
            }
        }
    }

     /** Handle Rerun Button Click */
     async function handleRerunClick(button) {
        const jobId = button.dataset.jobId;
        if (!jobId) return;

         button.disabled = true;
         button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Re-staging...';

        try {
             // Fetch the specific job details again to ensure we have the latest meta
             const response = await fetch(`/job_status/${jobId}`);
             if (!response.ok) throw new Error(`Could not fetch job details for rerun (${response.status})`);
             const jobDetails = await response.json();

             // Look for the original input filenames stored during staging/enqueueing
             const inputParams = getNested(jobDetails, 'meta.input_params.input_filenames', getNested(jobDetails, 'meta.input_params', {}));

             if (!inputParams || !inputParams.forward_reads) { // Check for at least one essential parameter
                 throw new Error("Original input parameters not found for this job, cannot rerun automatically.");
             }

             // Prepare the payload for the /run_pipeline (staging) endpoint
             const payload = {
                 forward_reads_file: inputParams.forward_reads,
                 reverse_reads_file: inputParams.reverse_reads,
                 reference_genome_file: inputParams.reference_genome,
                 target_regions_file: inputParams.target_regions,
                 known_variants_file: inputParams.known_variants || null // Send null if undefined/null/empty
             };

             // Call the staging endpoint
             const stageResponse = await fetch('/run_pipeline', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                 body: JSON.stringify(payload)
             });
             const stageResult = await stageResponse.json();

             if (!stageResponse.ok) { // Check for 200 OK on staging
                 throw new Error(stageResult.detail || `Failed to re-stage job (${stageResponse.status})`);
             }

             showGlobalStatus(`Job successfully re-staged with ID: ${stageResult.staged_job_id}. Refreshing list...`, 'success');
             await fetchJobsList(); // Refresh to show the newly staged job

         } catch (error) {
             console.error(`Error rerunning job ${jobId}:`, error);
             showGlobalStatus(`Error rerunning job ${jobId}: ${error.message}`, 'danger');
             // Re-enable button only if the row still exists and shows the rerun button
             const existingButton = jobsTableBody.querySelector(`button[data-job-id="${jobId}"].${BUTTON_CLASS_RERUN}`);
             if(existingButton){
                existingButton.disabled = false;
                existingButton.innerHTML = 'Rerun';
             }
         }
     }

     /** Handle Error Details Button Click */
     function handleErrorDetailsClick(button) {
         const errorMsg = button.dataset.error || "No specific error message provided.";
         errorModalText.textContent = errorMsg;
         errorModal.style.display = "block";
     }


    // --- Event Listeners ---
    jobsTableBody.addEventListener('click', function(event) {
        const button = event.target.closest('button');
        if (!button) return;

        if (button.classList.contains(BUTTON_CLASS_START)) {
            handleStartClick(button);
        } else if (button.classList.contains(BUTTON_CLASS_STOP)) {
            handleStopClick(button);
        } else if (button.classList.contains(BUTTON_CLASS_RERUN)) {
            handleRerunClick(button);
        } else if (button.classList.contains(BUTTON_CLASS_ERROR_DETAILS)) {
            handleErrorDetailsClick(button);
        }
        // Note: View Results is an anchor tag <a>, not handled here
    });

    refreshButton.addEventListener('click', fetchJobsList);

     // Close modal if user clicks outside of it
     window.onclick = function(event) {
        if (event.target == errorModal) {
            errorModal.style.display = "none";
        }
    }
    // Add listener for modal close button (X)
     const closeModalButton = errorModal.querySelector('.close-modal');
        if (closeModalButton) {
            closeModalButton.onclick = function() {
            errorModal.style.display = "none";
        }
    }


    // --- Initial Load ---
    fetchJobsList();

    // Optional: Refresh the whole list periodically less frequently than polling
    // setInterval(fetchJobsList, 30000); // e.g., every 30 seconds

});
