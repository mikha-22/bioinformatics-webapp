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

    /** Formats duration in seconds into Hh Mm Ss or Mm Ss */
    function formatDuration(seconds) {
        if (seconds === null || seconds === undefined || seconds < 0) return 'N/A';
        if (seconds < 1) return "< 1s"; // Handle very short durations
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        let str = "";
        if (h > 0) str += `${h}h `;
        if (m > 0 || h > 0) str += `${m.toString().padStart(h > 0 ? 2 : 1, '0')}m `; // Pad minutes if hours present
        str += `${s.toString().padStart(2, '0')}s`;
        return str.trim(); // Trim trailing space if only seconds
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
            // Handle cases where obj might be null or undefined early
            if (!obj) return defaultValue;
            // Reduce the path
            const result = path.split('.').reduce((o, k) => (o || {})[k], obj);
            // Return the result if it's not undefined, otherwise return defaultValue
            // Important: Check for undefined specifically, as 0 or false are valid values
            return result !== undefined ? result : defaultValue;
        } catch (e) {
            // Catch potential errors during reduction (e.g., accessing property of null)
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
        if (job.status === 'staged' && Object.keys(displayParams || {}).length === 0) {
            displayParams = getNested(job, 'meta.input_params', {});
        }

        let paramsHtml = '<div class="job-parameters">';
        if (displayParams && Object.keys(displayParams).length > 0) {
            paramsHtml += Object.entries(displayParams)
                 .map(([key, value]) => {
                      const displayKey = key.replace(/_/g, ' ');
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
        // Only poll if the job is NOT staged AND NOT terminal
        if (job.status !== 'staged' && !TERMINAL_STATUSES.includes(job.status)) {
            console.log(`[Polling Check] Job ${job.id} has status ${job.status}, starting polling.`); // Optional debug log
            startPolling(job.id);
        } else {
            console.log(`[Polling Check] Job ${job.id} has status ${job.status}, NOT starting polling.`); // Optional debug log
        }
    }

    /** Updates the time cell content, now including resource usage - CORRECTED */
    function updateTimeCell(cell, job) {
        // Try to get duration from meta first (more precise), fallback to calculated
        // Ensure meta exists before accessing duration_seconds
        const metaDuration = getNested(job, 'meta.duration_seconds', null); // Use getNested for safety
        const calculatedDuration = calculateDuration(job.started_at, job.ended_at);
        // Use metaDuration if it's a valid number, otherwise use calculated if it's valid, else null
        let durationSec = (typeof metaDuration === 'number') ? metaDuration : ((typeof calculatedDuration === 'number') ? calculatedDuration : null);

        // --- Get resource stats from the new 'resources' field or fallback to meta ---
        // Use optional chaining and nullish coalescing for safer access
        const resources = job?.resources ?? job?.meta ?? {};
        const peakMem = resources.peak_memory_mb; // Access directly, check validity below
        const avgCpu = resources.average_cpu_percent;

        let resourceHtml = '';
        // Check if the job status indicates completion where stats should exist
        if (job.status === 'finished' || job.status === 'failed') {
             // Display value if it's a number, otherwise show 'N/A'
             resourceHtml += `Peak Mem: ${(typeof peakMem === 'number' ? peakMem + ' MB' : 'N/A')}<br>`;
             resourceHtml += `Avg CPU: ${(typeof avgCpu === 'number' ? avgCpu + '%' : 'N/A')}<br>`;
        }
         // Show placeholder if running
         else if (job.status === 'started') {
             resourceHtml = `<i class="fas fa-cogs fa-spin fa-fw text-muted" title="Monitoring Resources..."></i> Monitoring...<br>`;
         }
         // Default for other states (queued, staged, etc.)
         else {
             resourceHtml = '<span class="text-muted">-</span><br>';
         }

        // --- CORRECTED INNERHTML CONSTRUCTION ---
        // Build the final HTML string step-by-step
        let finalHtml = `
            <div style="font-size: 0.85em;">
                ${job.status === 'staged' ? 'Staged:' : 'Enqueued:'} ${formatTimestamp(job.enqueued_at || job.staged_at)}<br>
                Started: ${formatTimestamp(job.started_at)}<br>
                Ended: ${formatTimestamp(job.ended_at)}<br>
        `;

        // Only add the horizontal rule and duration/resources if the job has at least started
        if (job.started_at || durationSec !== null) {
             finalHtml += `<hr class="my-1">`; // Add the divider
             finalHtml += `Duration: ${formatDuration(durationSec)}<br>`; // Add duration
             finalHtml += resourceHtml; // Add the resource info string
        } else {
             // For staged jobs, maybe show nothing extra or just a placeholder
             finalHtml += '<hr class="my-1"><span class="text-muted">-</span><br>';
        }

        finalHtml += `</div>`; // Close the main div

        // Set the cell's content to the fully constructed HTML
        cell.innerHTML = finalHtml;
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
                // Use progress from meta if available
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
                // Display error summary directly if available
                // The 'error' field in the response should now contain the summary
                if (job.error) {
                     statusHtml += `<br><small class="text-danger" title="${job.error}">Error: ${job.error.substring(0, 50)}${job.error.length > 50 ? '...' : ''}</small>`;
                 }
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
             // Use optional chaining for safer access
             const resultsPath = getNested(job, 'result.results_path', null);
             if (resultsPath) {
                  const dirName = resultsPath.split('/').pop();
                  buttonsHtml = `<a href="/results?highlight=${encodeURIComponent(dirName)}" class="btn btn-info btn-sm ${BUTTON_CLASS_RESULTS}" title="View results folder">Results</a>`;
             } else {
                  buttonsHtml = `<span class="text-muted small">No results link</span>`; // Handle case where path isn't returned
             }
         } else if (job.status === 'failed') {
             // Use the summarized error from the job data for the button dataset
             buttonsHtml = `<button class="btn btn-secondary btn-sm ${BUTTON_CLASS_ERROR_DETAILS}" data-error="${job.error || 'No details available.'}" title="Show Error Details">Details</button>`;
             // Check if we have the necessary params to enable rerun (using meta)
             const rerunParams = getNested(job, 'meta.input_params.input_filenames', getNested(job, 'meta.input_params', {}));
             if (rerunParams && Object.keys(rerunParams).length > 0 && rerunParams.forward_reads) { // Basic check
                 buttonsHtml += ` <button class="btn btn-warning btn-sm ${BUTTON_CLASS_RERUN}" data-job-id="${job.id}" title="Re-stage job with same inputs">Rerun</button>`;
             }
         } else if (job.status === 'stopped' || job.status === 'canceled') {
             // Optionally add Rerun button for stopped/canceled jobs (using meta)
             const rerunParams = getNested(job, 'meta.input_params.input_filenames', getNested(job, 'meta.input_params', {}));
             if (rerunParams && Object.keys(rerunParams).length > 0 && rerunParams.forward_reads) {
                 buttonsHtml += ` <button class="btn btn-warning btn-sm ${BUTTON_CLASS_RERUN}" data-job-id="${job.id}" title="Re-stage job with same inputs">Rerun</button>`;
             }
         }


        cell.innerHTML = statusHtml + '<br>' + buttonsHtml;
    }

    /** Updates an existing row with new job data */
    function updateJobRow(row, job) {
        // Update time cell (includes resources now)
        updateTimeCell(row.cells[2], job);
        // Update action cell (includes error summary now)
        updateActionCell(row.cells[3], job);
        // Update row styling class
        row.className = `job-state-${job.status || 'unknown'}`;

         // --- Manage Polling ---
         // Stop polling if the job has reached a terminal state
         if (TERMINAL_STATUSES.includes(job.status)) {
            stopPolling(job.id);
         } else if (!jobPollingIntervals[job.id]) {
             // This case should ideally not happen if polling was managed correctly
             // but as a safeguard, start polling if it's active but not polling.
             // Only start if it's actually in a pollable state
             if (job.status !== 'staged' && !TERMINAL_STATUSES.includes(job.status)) {
                console.warn(`Job ${job.id} is active (${job.status}) but was not polling. Restarting polling.`);
                startPolling(job.id);
             }
         }
    }


    // --- API Calls ---

    /** Fetches the combined list of jobs from the backend */
    async function fetchJobsList() {
        clearGlobalStatus();
        loadingRow.style.display = '';
        noJobsRow.style.display = 'none';
        errorJobsRow.style.display = 'none';

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
                     if (!fetchedJob || fetchedJob.status === 'staged' || TERMINAL_STATUSES.includes(fetchedJob.status)) {
                         // console.log(`Stopping polling for ${jobId} as it's no longer active or present.`); // Debug
                         stopPolling(jobId);
                     }
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
        // Check if still polling before making the request
        if (!jobPollingIntervals[jobId]) {
            // console.log(`Polling interval for ${jobId} already cleared, skipping fetch.`);
            return;
        }

        try {
            const response = await fetch(`/job_status/${jobId}`);
            const row = jobsTableBody.querySelector(`tr[data-job-id="${jobId}"]`);

            // If row disappeared before fetch completed, stop polling
            if (!row) {
                 console.warn(`Row for ${jobId} disappeared during poll request. Stopping polling.`);
                 stopPolling(jobId);
                 return;
            }

            if (!response.ok) {
                 if (response.status === 404) {
                     console.warn(`Job ${jobId} not found during polling (404). Stopping polling and removing row.`);
                     stopPolling(jobId);
                     row.remove(); // Remove the row as job is gone
                 } else {
                     const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                     console.error(`Error polling job ${jobId} (${response.status}): ${errorData.detail}`);
                     // Optionally stop polling after multiple consecutive errors -> Maybe add a counter?
                     // For now, let it continue trying unless it's a 404
                 }
                 return;
            }

            const job = await response.json();

            // Row still exists, update it
            updateJobRow(row, job); // Update existing row with new data (including resources)


        } catch (error) {
            console.error(`Network error polling job ${jobId}:`, error);
            // Optionally stop polling if network fails repeatedly
            // stopPolling(jobId); // Uncomment to stop on network errors
        }
    }

    /** Starts polling for a specific job ID if not already polling */
    function startPolling(jobId) {
        if (!jobPollingIntervals[jobId]) {
            // Poll immediately once to get initial running state faster
            pollJobStatus(jobId); // Fire off the first poll
            // Then set the interval
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

            // Expecting 202 Accepted on success
            if (!response.ok || response.status !== 202) {
                throw new Error(result.detail || `Failed to start job (${response.status})`);
            }

            showGlobalStatus(`Job ${result.job_id} enqueued successfully. Refreshing list...`, 'success');
            // Trigger a refresh to show the newly enqueued job correctly
             await fetchJobsList(); // Make sure refresh completes

        } catch (error) {
            console.error(`Error starting job ${stagedJobId}:`, error);
            showGlobalStatus(`Error starting job ${stagedJobId}: ${error.message}`, 'danger');
            // Re-enable button only if the row still exists and shows the start button
            // (Could have been removed by a concurrent refresh)
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

             if (!response.ok) { // Check status code (e.g., 200 OK is expected)
                 throw new Error(result.detail || `Failed to stop job (${response.status})`);
             }

            showGlobalStatus(`Stop request for ${jobId}: ${result.message}`, 'info');
            // Force an immediate poll to update status quicker
            await pollJobStatus(jobId);

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

             // Call the staging endpoint (which now returns 200 OK on success)
             const stageResponse = await fetch('/run_pipeline', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                 body: JSON.stringify(payload)
             });
             const stageResult = await stageResponse.json();

             if (!stageResponse.ok) { // Check for non-2xx status
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
         // Get the error from the button's data attribute
         // Use the full error message from job.error (passed via updateActionCell)
         const errorMsg = button.dataset.error || "No specific error message provided.";

         // Get additional details from meta if available (example: stderr snippet)
         // This part is simplified as getting full meta client-side is tricky without extra storage
         // We rely on the summary provided in job.error from the backend status response.
         let extraDetails = "";
         // Potential future enhancement: If backend included stderr_snippet directly in job.error or a separate field...
         // const stderrSnippet = button.dataset.stderr; // If we added data-stderr="..."
         // if (stderrSnippet) extraDetails = `\n\nStderr Snippet:\n${stderrSnippet}`;

         errorModalText.textContent = errorMsg + extraDetails; // Display error summary
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
