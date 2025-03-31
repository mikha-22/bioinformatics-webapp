// frontend/static/jobs.js
document.addEventListener('DOMContentLoaded', function() {
    const jobsTableBody = document.querySelector('#staged-jobs-table tbody');
    const statusDiv = document.getElementById('jobs-status');
    const refreshButton = document.getElementById('refresh-jobs-btn');

    // --- NEW: Constants for CSS classes ---
    const START_BUTTON_CLASS = 'btn-start-job';
    const STOP_BUTTON_CLASS = 'btn-stop-job';

    /**
     * Fetches staged jobs from the backend API.
     * NOTE: This only fetches STAGED jobs. Running jobs initiated
     * in this session will remain visually until refresh, but
     * won't be fetched again by this function.
     */
    async function fetchStagedJobs() {
        clearStatus();
        // Clear only rows that are NOT marked as running/enqueued
        Array.from(jobsTableBody.querySelectorAll('tr:not(.job-enqueued)')).forEach(row => {
            if (row.id !== 'loading-jobs-row' && row.id !== 'no-jobs-row' && row.id !== 'error-jobs-row') {
                row.remove();
            }
        });

        const loadingRow = document.getElementById('loading-jobs-row');
        const noJobsRow = document.getElementById('no-jobs-row');
        const errorJobsRow = document.getElementById('error-jobs-row');

        loadingRow.style.display = ''; // Show loading
        noJobsRow.style.display = 'none';
        errorJobsRow.style.display = 'none';


        try {
            const response = await fetch('/staged_jobs');
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                throw new Error(`Failed to fetch staged jobs (${response.status}): ${errorData.detail}`);
            }
            const stagedJobs = await response.json();
            loadingRow.style.display = 'none'; // Hide loading
            displayJobs(stagedJobs);
        } catch (error) {
            console.error('Error fetching staged jobs:', error);
            showStatus(`Error loading jobs: ${error.message}`, 'danger');
            loadingRow.style.display = 'none'; // Hide loading
            errorJobsRow.style.display = ''; // Show error row
        }
    }

    /**
     * Displays the fetched staged jobs in the table.
     * @param {Object} jobs - Dictionary of staged jobs { staged_job_id: details }
     */
    function displayJobs(jobs) {
        // Hide placeholder rows if they exist
        const noJobsRow = document.getElementById('no-jobs-row');
        const errorJobsRow = document.getElementById('error-jobs-row');
        noJobsRow.style.display = 'none';
        errorJobsRow.style.display = 'none';


        // Check if only enqueued jobs are left + no new jobs came
        const existingRows = jobsTableBody.querySelectorAll('tr:not(#loading-jobs-row):not(#no-jobs-row):not(#error-jobs-row)');
        if (Object.keys(jobs).length === 0 && existingRows.length === 0) {
            noJobsRow.style.display = ''; // Show no jobs row
            return;
        }

        // Sort jobs by staged time, newest first (optional)
        const sortedJobEntries = Object.entries(jobs).sort(([, jobA], [, jobB]) => {
            return (jobB.staged_at || 0) - (jobA.staged_at || 0);
        });

        sortedJobEntries.forEach(([stagedJobId, details]) => {
            // Avoid adding duplicates if a refresh happens while a row exists
             if (jobsTableBody.querySelector(`tr[data-staged-id="${stagedJobId}"]`)) {
                 return;
             }

            const row = jobsTableBody.insertRow(0); // Insert at the top
            row.dataset.stagedId = stagedJobId; // Add staged ID for potential reference

            const idCell = row.insertCell();
            idCell.textContent = stagedJobId.substring(0, 12) + "..."; // Shorten ID for display

            const descCell = row.insertCell();
            descCell.textContent = details.description || 'N/A'; // Display description

            const timeCell = row.insertCell();
            timeCell.textContent = details.staged_at
                ? new Date(details.staged_at * 1000).toLocaleString()
                : 'N/A';

            const actionCell = row.insertCell();
            actionCell.classList.add('action-cell');
            const startButton = document.createElement('button');
            startButton.textContent = 'Start';
            startButton.classList.add('btn', 'btn-success', 'btn-sm', START_BUTTON_CLASS);
            startButton.dataset.stagedId = stagedJobId; // Store the ID on the button
            actionCell.appendChild(startButton);
        });

        // Check again if after adding, the table is effectively empty (only placeholder rows)
         if (jobsTableBody.querySelectorAll('tr:not(#loading-jobs-row):not(#no-jobs-row):not(#error-jobs-row)').length === 0) {
              noJobsRow.style.display = ''; // Show no jobs row
         }
    }

    /**
     * Handles the click event for a "Start" button.
     * @param {HTMLButtonElement} startButton - The button element that was clicked.
     */
    async function handleStartClick(startButton) {
        const stagedJobId = startButton.dataset.stagedId;
        const row = startButton.closest('tr');
        const actionCell = startButton.parentNode;

        if (!stagedJobId || !row || !actionCell) {
            console.error('Could not find stagedJobId or table elements for starting job.');
            showStatus('Internal error: Could not process start action.', 'danger');
            return;
        }

        clearStatus();
        startButton.disabled = true; // Prevent double-clicks
        startButton.textContent = 'Starting...';
        actionCell.innerHTML = '<span class="text-muted"><i class="fas fa-spinner fa-spin"></i> Starting...</span>'; // Visual feedback

        try {
            const response = await fetch(`/start_job/${stagedJobId}`, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json' // Indicate we expect JSON back
                }
            });

            const result = await response.json(); // Try to parse JSON regardless of status

            if (response.status === 202) { // 202 Accepted - Job enqueued successfully
                const rqJobId = result.job_id;
                showStatus(`Job ${rqJobId} successfully enqueued for processing.`, 'success');

                // --- MODIFICATION START ---
                // Mark row as enqueued/running
                row.classList.add('job-enqueued');
                row.dataset.rqJobId = rqJobId; // Store RQ job ID on the row

                // Update Action Cell
                actionCell.innerHTML = ''; // Clear previous content ("Starting...")

                // Add status text
                const statusSpan = document.createElement('span');
                statusSpan.classList.add('text-info', 'mr-2', 'job-status-text');
                statusSpan.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Enqueued'; // Add spinner
                actionCell.appendChild(statusSpan);

                // Add Stop Button
                const stopButton = document.createElement('button');
                stopButton.textContent = 'Stop';
                stopButton.classList.add('btn', 'btn-danger', 'btn-sm', STOP_BUTTON_CLASS);
                stopButton.dataset.rqJobId = rqJobId; // Store RQ Job ID for stopping
                actionCell.appendChild(stopButton);
                // --- MODIFICATION END ---

            } else {
                 // Handle errors (404, 500, 503 etc.)
                 throw new Error(result.detail || `Failed to start job ${stagedJobId} (${response.status})`);
            }
        } catch (error) {
            console.error(`Error starting job ${stagedJobId}:`, error);
            showStatus(`Error starting job ${stagedJobId}: ${error.message}`, 'danger');
            // Restore the start button in the action cell on error
            actionCell.innerHTML = ''; // Clear "Starting..."
            startButton.disabled = false; // Re-enable button on error
            startButton.textContent = 'Start';
            actionCell.appendChild(startButton);
        }
    }

    /**
     * Handles the click event for a "Stop" button.
     * @param {HTMLButtonElement} stopButton - The button element that was clicked.
     */
    async function handleStopClick(stopButton) {
        const rqJobId = stopButton.dataset.rqJobId;
        const row = stopButton.closest('tr');
        const actionCell = stopButton.parentNode;
        const statusSpan = actionCell.querySelector('.job-status-text');


        if (!rqJobId || !row || !actionCell) {
            console.error('Could not find rqJobId or table elements for stopping job.');
            showStatus('Internal error: Could not process stop action.', 'danger');
            return;
        }

        clearStatus();
        stopButton.disabled = true;
        stopButton.textContent = 'Stopping...';
        if(statusSpan) statusSpan.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Stopping';

        try {
            const response = await fetch(`/stop_job/${rqJobId}`, {
                method: 'POST',
                headers: { 'Accept': 'application/json' }
            });

            const result = await response.json(); // Expect JSON back

            if (response.ok) { // 200 OK typically
                showStatus(`Stop request sent for job ${rqJobId}. Status: ${result.message}`, 'info');
                // Update UI to reflect stopped/cancelled state - e.g., change status text
                 if(statusSpan) statusSpan.innerHTML = '<i class="fas fa-stop-circle text-danger"></i> Stopped';
                 actionCell.removeChild(stopButton); // Remove the stop button
                 row.classList.remove('job-enqueued'); // No longer actively enqueued from UI perspective
                 row.classList.add('job-stopped'); // Add marker class
            } else {
                throw new Error(result.detail || `Failed to stop job ${rqJobId} (${response.status})`);
            }
        } catch (error) {
             console.error(`Error stopping job ${rqJobId}:`, error);
             showStatus(`Error stopping job ${rqJobId}: ${error.message}`, 'danger');
             stopButton.disabled = false; // Re-enable button on error
             stopButton.textContent = 'Stop';
             if(statusSpan) statusSpan.innerHTML = '<i class="fas fa-exclamation-triangle text-warning"></i> Error Stopping'; // Indicate error state
        }
    }


    /**
     * Shows a status message in the statusDiv.
     * @param {string} message - The message to display.
     * @param {string} type - Bootstrap alert type ('success', 'danger', 'warning', 'info')
     */
    function showStatus(message, type = 'info') {
        statusDiv.innerHTML = message; // Use innerHTML to allow icons etc.
        statusDiv.className = `alert alert-${type}`; // Use Bootstrap alert styles
        statusDiv.style.display = 'block'; // Make sure it's visible
    }

    /** Clears the status message area */
    function clearStatus() {
         statusDiv.textContent = '';
         statusDiv.style.display = 'none';
         statusDiv.className = ''; // Reset classes
    }

    // --- Event Listeners ---
    // Use event delegation for start AND stop buttons
    jobsTableBody.addEventListener('click', function(event) {
         if (event.target.classList.contains(START_BUTTON_CLASS)) {
             handleStartClick(event.target);
         } else if (event.target.classList.contains(STOP_BUTTON_CLASS)) {
             handleStopClick(event.target);
         }
    });

    // Refresh button listener
    refreshButton.addEventListener('click', fetchStagedJobs);

    // --- Initial Load ---
    fetchStagedJobs();
});
