document.addEventListener('DOMContentLoaded', function() {
    const jobsTableBody = document.querySelector('#staged-jobs-table tbody');
    const loadingIndicator = document.getElementById('loading-jobs');
    const statusDiv = document.getElementById('jobs-status');
    const refreshButton = document.getElementById('refresh-jobs-btn');

    /**
     * Fetches staged jobs from the backend API.
     */
    async function fetchStagedJobs() {
        clearStatus();
        jobsTableBody.innerHTML = '<tr><td colspan="4" class="text-center">Loading staged jobs...</td></tr>'; // Show loading indicator

        try {
            const response = await fetch('/staged_jobs');
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                throw new Error(`Failed to fetch staged jobs (${response.status}): ${errorData.detail}`);
            }
            const stagedJobs = await response.json();
            displayJobs(stagedJobs);
        } catch (error) {
            console.error('Error fetching staged jobs:', error);
            showStatus(`Error loading jobs: ${error.message}`, 'danger');
            jobsTableBody.innerHTML = '<tr><td colspan="4" class="text-center text-danger">Could not load jobs.</td></tr>';
        }
    }

    /**
     * Displays the fetched staged jobs in the table.
     * @param {Object} jobs - Dictionary of staged jobs { staged_job_id: details }
     */
    function displayJobs(jobs) {
        jobsTableBody.innerHTML = ''; // Clear previous content or loading indicator

        if (Object.keys(jobs).length === 0) {
            jobsTableBody.innerHTML = '<tr><td colspan="4" class="text-center">No jobs currently staged.</td></tr>';
            return;
        }

        // Sort jobs by staged time, newest first (optional)
        const sortedJobEntries = Object.entries(jobs).sort(([, jobA], [, jobB]) => {
            return (jobB.staged_at || 0) - (jobA.staged_at || 0);
        });

        sortedJobEntries.forEach(([stagedJobId, details]) => {
            const row = jobsTableBody.insertRow();

            const idCell = row.insertCell();
            idCell.textContent = stagedJobId;

            const descCell = row.insertCell();
            descCell.textContent = details.description || 'N/A'; // Display description

            const timeCell = row.insertCell();
            // Convert timestamp (seconds) to readable date/time
            timeCell.textContent = details.staged_at
                ? new Date(details.staged_at * 1000).toLocaleString()
                : 'N/A';

            const actionCell = row.insertCell();
            actionCell.classList.add('action-cell');
            const startButton = document.createElement('button');
            startButton.textContent = 'Start';
            startButton.classList.add('btn', 'btn-success', 'btn-sm', 'btn-start-job');
            startButton.dataset.stagedId = stagedJobId; // Store the ID on the button
            actionCell.appendChild(startButton);
        });
    }

    /**
     * Handles the click event for a "Start" button.
     * @param {Event} event - The click event object.
     */
    async function handleStartClick(event) {
        if (!event.target.classList.contains('btn-start-job')) {
            return; // Ignore clicks not on a start button
        }

        const startButton = event.target;
        const stagedJobId = startButton.dataset.stagedId;

        if (!stagedJobId) {
            console.error('Could not find stagedJobId on the button.');
            showStatus('Internal error: Missing job ID.', 'danger');
            return;
        }

        clearStatus();
        startButton.disabled = true; // Prevent double-clicks
        startButton.textContent = 'Starting...';

        try {
            const response = await fetch(`/start_job/${stagedJobId}`, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json' // Indicate we expect JSON back
                }
            });

            const result = await response.json(); // Try to parse JSON regardless of status

            if (response.status === 202) { // 202 Accepted - Job enqueued successfully
                showStatus(`Job ${result.job_id || stagedJobId} successfully enqueued for processing.`, 'success');
                // Remove the row from the table visually
                startButton.closest('tr').remove();
                 // Check if table is now empty
                if (jobsTableBody.rows.length === 0) {
                     jobsTableBody.innerHTML = '<tr><td colspan="4" class="text-center">No jobs currently staged.</td></tr>';
                }
            } else {
                 // Handle errors (404, 500, 503 etc.)
                 throw new Error(result.detail || `Failed to start job ${stagedJobId} (${response.status})`);
            }
        } catch (error) {
            console.error(`Error starting job ${stagedJobId}:`, error);
            showStatus(`Error starting job ${stagedJobId}: ${error.message}`, 'danger');
            startButton.disabled = false; // Re-enable button on error
            startButton.textContent = 'Start';
        }
    }

    /**
     * Shows a status message in the statusDiv.
     * @param {string} message - The message to display.
     * @param {string} type - Bootstrap alert type ('success', 'danger', 'warning', 'info')
     */
    function showStatus(message, type = 'info') {
        statusDiv.textContent = message;
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
    // Use event delegation for start buttons
    jobsTableBody.addEventListener('click', handleStartClick);

    // Refresh button listener
    refreshButton.addEventListener('click', fetchStagedJobs);

    // --- Initial Load ---
    fetchStagedJobs();
});
