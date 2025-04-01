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
    const BUTTON_CLASS_REMOVE = 'btn-remove-job'; // Unified remove class

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
        globalStatusDiv.innerHTML = message; // Use innerHTML to allow basic tags like <code>
        globalStatusDiv.className = `alert alert-${type} mb-3`;
        globalStatusDiv.style.display = 'block';
    }

    /** Clears the global status message */
    function clearGlobalStatus() {
         globalStatusDiv.textContent = '';
         globalStatusDiv.style.display = 'none';
         globalStatusDiv.className = '';
    }

    // +++ ADDED MISSING HELPER FUNCTION +++
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
            console.warn(`Error accessing nested property '${path}':`, e); // Log warning
            return defaultValue;
        }
    }
    // +++++++++++++++++++++++++++++++++++++++

     /** Checks if the jobs table body is empty (excluding placeholder rows) */
     function isTableEmpty() {
        return jobsTableBody.querySelectorAll('tr[data-job-id]').length === 0;
    }

    // --- Job Rendering and Updating ---

    /** Creates a NEW job row and appends it */
    function createAndAppendJobRow(job) {
        const row = jobsTableBody.insertRow(-1); // Append at the end of tbody
        row.dataset.jobId = job.id; // Use job.id (from /jobs_list response) for the row identifier

        // --- Basic Info Cell (ID / Description) ---
        let cellInfo = row.insertCell();
        cellInfo.innerHTML = `
            <strong title="${job.id}">${job.id.substring(0, 15)}...</strong>
            <div class="text-muted" style="font-size: 0.9em;">${job.description || 'No Description'}</div>
        `;

        // --- Parameters Cell ---
        let cellParams = row.insertCell();
        // Uses getNested - ensure it exists!
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
                      return `<div><small>${displayKey}:</small> <kbd style="word-wrap: break-word; white-space: normal;">${displayValue}</kbd></div>`;
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
        if (job.status !== 'staged' && !TERMINAL_STATUSES.includes(job.status)) {
            console.log(`[Polling Check] Job ${job.id} has status ${job.status}, starting polling.`);
            startPolling(job.id);
        } else {
            console.log(`[Polling Check] Job ${job.id} has status ${job.status}, NOT starting polling.`);
        }
    }

    /** Updates the time cell content, now including resource usage */
    function updateTimeCell(cell, job) {
         // Uses getNested - ensure it exists!
         const metaDuration = getNested(job, 'meta.duration_seconds', null);
         const calculatedDuration = calculateDuration(job.started_at, job.ended_at);
         let durationSec = (typeof metaDuration === 'number') ? metaDuration : ((typeof calculatedDuration === 'number') ? calculatedDuration : null);

         const resources = job?.resources ?? job?.meta ?? {}; // Use 'resources' field if present
         const peakMem = resources.peak_memory_mb;
         const avgCpu = resources.average_cpu_percent;

         let resourceHtml = '';
         if (job.status === 'finished' || job.status === 'failed') {
              resourceHtml += `Peak Mem: ${(typeof peakMem === 'number' ? peakMem.toFixed(1) + ' MB' : 'N/A')}<br>`;
              resourceHtml += `Avg CPU: ${(typeof avgCpu === 'number' ? avgCpu.toFixed(1) + '%' : 'N/A')}<br>`;
         }
          else if (job.status === 'started') {
              resourceHtml = `<i class="fas fa-cogs fa-spin fa-fw text-muted" title="Monitoring Resources..."></i> Monitoring...<br>`;
          }
          else {
              resourceHtml = '<span class="text-muted">-</span><br>';
          }

         let finalHtml = `
             <div style="font-size: 0.85em;">
                 ${job.status === 'staged' ? 'Staged:' : 'Enqueued:'} ${formatTimestamp(job.enqueued_at || job.staged_at)}<br>
                 Started: ${formatTimestamp(job.started_at)}<br>
                 Ended: ${formatTimestamp(job.ended_at)}<br>
         `;

         if (job.started_at || durationSec !== null || job.status === 'finished' || job.status === 'failed') {
              finalHtml += `<hr class="my-1">`;
              finalHtml += `Duration: ${formatDuration(durationSec)}<br>`;
              finalHtml += resourceHtml;
         } else if (job.status === 'staged') {
             finalHtml += '<hr class="my-1"><span class="text-muted">-</span><br>';
         }

         finalHtml += `</div>`;
         cell.innerHTML = finalHtml;
    }


    /** Updates the content of the Action Cell based on job status */
    function updateActionCell(cell, job) {
        const currentJobId = job.job_id || job.id; // Prioritize job_id if present (from /job_status)

        let statusHtml = '';
        let buttonsHtml = '';

        // Determine status icon and text (using job.status)
        switch (job.status) {
            case 'staged':
                statusHtml = `<span class="job-status-text text-secondary"><i class="bi bi-pause-circle"></i> Staged</span>`;
                break;
            case 'queued':
                statusHtml = `<span class="job-status-text text-primary"><i class="bi bi-hourglass-split"></i> Queued</span>`;
                break;
            case 'started':
                statusHtml = `<span class="job-status-text text-info"><i class="fas fa-sync-alt fa-spin"></i> Running</span>`;
                // Uses getNested - ensure it exists!
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

        // Determine OTHER action buttons based on status (using job.status and currentJobId)
        // Uses getNested - ensure it exists!
        if (job.status === 'staged') {
             buttonsHtml += `<button class="btn btn-success btn-sm ${BUTTON_CLASS_START}" data-staged-id="${currentJobId}">Start</button>`;
         } else if (job.status === 'queued' || job.status === 'started') {
             buttonsHtml += `<button class="btn btn-danger btn-sm ${BUTTON_CLASS_STOP}" data-job-id="${currentJobId}">Stop</button>`;
         } else if (job.status === 'finished') {
             const resultsPath = getNested(job, 'result.results_path', null);
             if (resultsPath) {
                  const dirName = resultsPath.split('/').pop();
                  buttonsHtml += `<a href="/results?highlight=${encodeURIComponent(dirName)}" class="btn btn-info btn-sm ${BUTTON_CLASS_RESULTS}" title="View results folder">Results</a>`;
             } else {
                  buttonsHtml += `<span class="text-muted small">No results link</span>`;
             }
             const rerunParams = getNested(job, 'meta.input_params.input_filenames', getNested(job, 'meta.input_params', {}));
             if (rerunParams && Object.keys(rerunParams).length > 0 && rerunParams.forward_reads) {
                 buttonsHtml += ` <button class="btn btn-warning btn-sm ${BUTTON_CLASS_RERUN}" data-job-id="${currentJobId}" title="Re-stage job with same inputs">Rerun</button>`;
             }

         } else if (job.status === 'failed') {
             buttonsHtml += `<button class="btn btn-secondary btn-sm ${BUTTON_CLASS_ERROR_DETAILS}" data-error="${job.error || 'No details available.'}" title="Show Error Details">Details</button>`;
             const rerunParams = getNested(job, 'meta.input_params.input_filenames', getNested(job, 'meta.input_params', {}));
             if (rerunParams && Object.keys(rerunParams).length > 0 && rerunParams.forward_reads) {
                 buttonsHtml += ` <button class="btn btn-warning btn-sm ${BUTTON_CLASS_RERUN}" data-job-id="${currentJobId}" title="Re-stage job with same inputs">Rerun</button>`;
             }
         } else if (job.status === 'stopped' || job.status === 'canceled') {
             const rerunParams = getNested(job, 'meta.input_params.input_filenames', getNested(job, 'meta.input_params', {}));
             if (rerunParams && Object.keys(rerunParams).length > 0 && rerunParams.forward_reads) {
                 buttonsHtml += ` <button class="btn btn-warning btn-sm ${BUTTON_CLASS_RERUN}" data-job-id="${currentJobId}" title="Re-stage job with same inputs">Rerun</button>`;
             }
         }

        // --- ALWAYS Add the Remove Button (last) ---
        buttonsHtml += ` <button class="btn btn-outline-danger btn-sm ${BUTTON_CLASS_REMOVE}" data-job-id="${currentJobId}" title="Remove Job Data"><i class="fas fa-trash"></i></button>`;

        cell.innerHTML = statusHtml + '<br>' + buttonsHtml;
    }

    /** Updates an existing row with new job data from /job_status endpoint */
    function updateJobRow(row, job) { // job here is from /job_status, has 'job_id'
        const jobId = job.job_id;

        updateTimeCell(row.cells[2], job);
        updateActionCell(row.cells[3], job);
        row.className = `job-state-${job.status || 'unknown'}`;

         if (TERMINAL_STATUSES.includes(job.status)) {
            stopPolling(jobId);
         } else if (!jobPollingIntervals[jobId]) {
             if (job.status !== 'staged' && !TERMINAL_STATUSES.includes(job.status)) {
                console.warn(`Job ${jobId} is active (${job.status}) but was not polling. Restarting polling.`);
                startPolling(jobId);
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

        const currentlyPollingIds = new Set(Object.keys(jobPollingIntervals));
        // Clear ONLY job rows, not placeholders
        jobsTableBody.querySelectorAll('tr[data-job-id]').forEach(row => row.remove());

        try {
            const response = await fetch('/jobs_list');
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                throw new Error(`Failed to fetch jobs list (${response.status}): ${errorData.detail}`);
            }
            const jobs = await response.json();
            loadingRow.style.display = 'none';

            if (!jobs || jobs.length === 0) {
                noJobsRow.style.display = '';
                currentlyPollingIds.forEach(stopPolling);
                return;
            }

            const activeJobIdsThisFetch = new Set();
            jobs.forEach(job => {
                createAndAppendJobRow(job); // Uses getNested - ensure it exists!
                 if (job.status !== 'staged' && !TERMINAL_STATUSES.includes(job.status)) {
                     activeJobIdsThisFetch.add(job.id);
                 }
            });

            // Stop polling for jobs that were polling but are now gone or terminal/staged
            currentlyPollingIds.forEach(jobId => {
                if (!activeJobIdsThisFetch.has(jobId)) {
                     const fetchedJob = jobs.find(j => j.id === jobId);
                     if (!fetchedJob || fetchedJob.status === 'staged' || TERMINAL_STATUSES.includes(fetchedJob.status)) {
                         stopPolling(jobId);
                     }
                }
            });

            // Final check if empty after potential stops
             if (isTableEmpty()) {
                  noJobsRow.style.display = '';
             }

        } catch (error) {
            console.error('Error fetching jobs list:', error); // Log the actual error
            showGlobalStatus(`Error loading jobs: ${error.message}`, 'danger');
            loadingRow.style.display = 'none';
            errorJobsRow.style.display = '';
            Object.keys(jobPollingIntervals).forEach(stopPolling);
        }
    }

    /** Polls the status of a single job */
    async function pollJobStatus(jobId) {
       if (!jobPollingIntervals[jobId]) return;

        try {
            const response = await fetch(`/job_status/${jobId}`);
            const row = jobsTableBody.querySelector(`tr[data-job-id="${jobId}"]`);

            if (!row) {
                 console.warn(`Row for ${jobId} disappeared during poll request. Stopping polling.`);
                 stopPolling(jobId);
                 return;
            }

            if (!response.ok) {
                 if (response.status === 404) {
                     console.warn(`Job ${jobId} not found during polling (404). Assuming completed/deleted. Stopping polling.`);
                     stopPolling(jobId);
                 } else {
                     const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                     console.error(`Error polling job ${jobId} (${response.status}): ${errorData.detail}`);
                 }
                 return;
            }

            const job = await response.json();
            updateJobRow(row, job); // Uses getNested - ensure it exists!

        } catch (error) {
            console.error(`Network error polling job ${jobId}:`, error);
        }
    }

    /** Starts polling for a specific job ID if not already polling */
    function startPolling(jobId) {
        if (!jobId) {
             console.warn("Attempted to start polling with invalid jobId:", jobId);
             return;
        }
        if (!jobPollingIntervals[jobId]) {
            pollJobStatus(jobId); // Poll immediately
            jobPollingIntervals[jobId] = setInterval(() => pollJobStatus(jobId), POLLING_INTERVAL_MS);
            console.log(`Started polling for job ${jobId}`);
        }
    }

    /** Stops polling for a specific job ID */
    function stopPolling(jobId) {
        if (!jobId) {
            console.warn("Attempted to stop polling with invalid jobId:", jobId);
            return;
        }
        if (jobPollingIntervals[jobId]) {
            clearInterval(jobPollingIntervals[jobId]);
            delete jobPollingIntervals[jobId];
            console.log(`Stopped polling for job ${jobId}`);
        }
    }


    // --- Button Click Handlers ---

    /** Handle Start Button Click */
    async function handleStartClick(button) {
        const stagedJobId = button.dataset.stagedId;
        if (!stagedJobId) return;

        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';
        const removeButton = button.closest('td').querySelector(`.${BUTTON_CLASS_REMOVE}`);
        if (removeButton) removeButton.disabled = true;

        try {
            const response = await fetch(`/start_job/${stagedJobId}`, { method: 'POST', headers: { 'Accept': 'application/json' } });
            const result = await response.json();

            if (!response.ok || response.status !== 202) {
                throw new Error(result.detail || `Failed to start job (${response.status})`);
            }

            showGlobalStatus(`Job <code>${result.job_id}</code> enqueued successfully. Refreshing list...`, 'success');
            setTimeout(fetchJobsList, 1500);

        } catch (error) {
            console.error(`Error starting job ${stagedJobId}:`, error);
            showGlobalStatus(`Error starting job <code>${stagedJobId}</code>: ${error.message}`, 'danger');
            const actionCell = jobsTableBody.querySelector(`tr[data-job-id="${stagedJobId}"] .action-cell`);
            if (actionCell) {
                const startBtn = actionCell.querySelector(`.${BUTTON_CLASS_START}`);
                const removeBtn = actionCell.querySelector(`.${BUTTON_CLASS_REMOVE}`);
                 if (startBtn) {
                    startBtn.disabled = false;
                    startBtn.innerHTML = 'Start';
                 }
                 if (removeBtn) {
                     removeBtn.disabled = false;
                 }
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

             if (!response.ok) {
                 throw new Error(result.detail || `Failed to stop job (${response.status})`);
             }

            showGlobalStatus(`Stop request for job <code>${jobId}</code>: ${result.message}. Status will update shortly.`, 'info');
            await pollJobStatus(jobId);

        } catch (error) {
            console.error(`Error stopping job ${jobId}:`, error);
            showGlobalStatus(`Error stopping job <code>${jobId}</code>: ${error.message}`, 'danger');
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
        if (!jobId) {
            console.error("Rerun button clicked but data-job-id is missing or invalid:", button);
            showGlobalStatus("Cannot rerun: Job ID is missing.", "danger");
            return;
        }

         button.disabled = true;
         button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Re-staging...';

        try {
             const response = await fetch(`/job_status/${jobId}`);
             if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Error rerunning job ${jobId}: Could not fetch job details for rerun (${response.status} - ${errorText})`);
             }
             const jobDetails = await response.json();

             // Uses getNested - ensure it exists!
             const inputParams = getNested(jobDetails, 'meta.input_params.input_filenames', getNested(jobDetails, 'meta.input_params', {}));

             if (!inputParams || !inputParams.forward_reads) {
                 throw new Error("Original input parameters not found for this job, cannot rerun automatically.");
             }

             const payload = {
                 forward_reads_file: inputParams.forward_reads,
                 reverse_reads_file: inputParams.reverse_reads,
                 reference_genome_file: inputParams.reference_genome,
                 target_regions_file: inputParams.target_regions,
                 known_variants_file: inputParams.known_variants || null
             };

             const stageResponse = await fetch('/run_pipeline', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                 body: JSON.stringify(payload)
             });
             const stageResult = await stageResponse.json();

             if (!stageResponse.ok) {
                 throw new Error(stageResult.detail || `Failed to re-stage job (${stageResponse.status})`);
             }

             showGlobalStatus(`Job successfully re-staged with ID: <code>${stageResult.staged_job_id}</code>. Refreshing list...`, 'success');
             setTimeout(fetchJobsList, 1500);

         } catch (error) {
             console.error(`Error rerunning job ${jobId}:`, error);
             showGlobalStatus(`Error rerunning job <code>${jobId}</code>: ${error.message}`, 'danger');
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
         let extraDetails = "";

         errorModalText.textContent = errorMsg + extraDetails;
         errorModal.style.display = "block";
     }

    /** Handle Remove Button Click */
    async function handleRemoveClick(button) {
        const jobId = button.dataset.jobId;
        if (!jobId) {
             console.error("Remove button clicked but data-job-id missing.");
             return;
        }

        const jobDesc = jobId.startsWith("staged_") ? `staged job '${jobId.substring(0, 15)}...'` : `job '${jobId}'`;
        const confirmation = confirm(`Are you sure you want to permanently remove ${jobDesc} and its data? This cannot be undone.`);
        if (!confirmation) return;

        stopPolling(jobId); // Stop polling if active

        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        try {
            const response = await fetch(`/remove_job/${jobId}`, {
                 method: 'DELETE',
                 headers: { 'Accept': 'application/json' }
            });
            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.detail || `Failed to remove job (${response.status})`);
            }

            showGlobalStatus(result.message || `Job <code>${jobId}</code> removed successfully.`, 'success');
            const rowToRemove = button.closest('tr');
            if (rowToRemove) rowToRemove.remove();

            if (isTableEmpty()) {
                noJobsRow.style.display = '';
                loadingRow.style.display = 'none';
                errorJobsRow.style.display = 'none';
            }

        } catch (error) {
            console.error(`Error removing job ${jobId}:`, error);
            showGlobalStatus(`Error removing job <code>${jobId}</code>: ${error.message}`, 'danger');
             const existingButton = jobsTableBody.querySelector(`button[data-job-id="${jobId}"].${BUTTON_CLASS_REMOVE}`);
             if(existingButton){
                 existingButton.disabled = false;
                 existingButton.innerHTML = '<i class="fas fa-trash"></i>';
             }
        }
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
        } else if (button.classList.contains(BUTTON_CLASS_REMOVE)) {
            handleRemoveClick(button);
        }
    });

    refreshButton.addEventListener('click', fetchJobsList);

     // Modal close logic
     window.onclick = function(event) {
        if (event.target == errorModal) {
            errorModal.style.display = "none";
        }
    }
     const closeModalButton = errorModal.querySelector('.close-modal');
     if (closeModalButton) {
         closeModalButton.onclick = function() {
            errorModal.style.display = "none";
         }
     }

    // --- Initial Load ---
    fetchJobsList();

});
