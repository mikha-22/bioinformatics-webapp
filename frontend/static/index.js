// frontend/static/index.js
document.addEventListener('DOMContentLoaded', function() {

    // --- DOM Elements ---
    const recentJobsList = document.getElementById('recent-jobs-list');
    const loadingRecentJobs = document.getElementById('loading-recent-jobs');
    const errorRecentJobs = document.getElementById('error-recent-jobs');
    const noRecentJobs = document.getElementById('no-recent-jobs');

    const recentResultsList = document.getElementById('recent-results-list');
    const loadingRecentResults = document.getElementById('loading-recent-results');
    const errorRecentResults = document.getElementById('error-recent-results');
    const noRecentResults = document.getElementById('no-recent-results');

    const MAX_ITEMS = 5; // Max number of recent items to display

    // --- Helper Functions ---

    /** Formats a timestamp (seconds since epoch) into a locale string, or returns 'N/A' */
    function formatTimestamp(timestamp) {
        if (!timestamp) return 'N/A';
        try {
            // Use locale string for better readability
            return new Date(timestamp * 1000).toLocaleString(undefined, {
                dateStyle: 'short',
                timeStyle: 'short'
            });
        } catch (e) {
            return 'Invalid Date';
        }
    }

     /** Gets a Bootstrap/FontAwesome icon class based on job status */
    function getJobStatusClassAndIcon(status) {
        switch (status) {
            case 'staged':   return { class: 'text-secondary', icon: 'bi bi-pause-circle' };
            case 'queued':   return { class: 'text-primary', icon: 'bi bi-hourglass-split' };
            case 'started':  return { class: 'text-info', icon: 'fas fa-sync-alt fa-spin' }; // Use spinning icon for running
            case 'finished': return { class: 'text-success', icon: 'bi bi-check-circle-fill' };
            case 'failed':   return { class: 'text-danger', icon: 'bi bi-x-octagon-fill' };
            case 'stopped':
            case 'canceled': return { class: 'text-muted', icon: 'bi bi-stop-circle' };
            default:         return { class: 'text-muted', icon: 'bi bi-question-circle' };
        }
    }

     /** Toggles visibility of list status elements */
    function showListStatus(listElement, loading, error, noData, dataFound) {
        if (loading) loading.style.display = dataFound ? 'none' : 'block';
        if (error) error.style.display = 'none';
        if (noData) noData.style.display = 'none';

        if (!dataFound) {
            if (loading) loading.style.display = 'block';
        }
    }

    function displayListError(listElement, loading, error, noData) {
         if (loading) loading.style.display = 'none';
         if (error) error.style.display = 'block';
         if (noData) noData.style.display = 'none';
         // Clear any previous data items
         listElement.querySelectorAll('.recent-job-item, .recent-result-item').forEach(item => item.remove());
    }

     function displayNoData(listElement, loading, error, noData) {
         if (loading) loading.style.display = 'none';
         if (error) error.style.display = 'none';
         if (noData) noData.style.display = 'block';
         // Clear any previous data items
         listElement.querySelectorAll('.recent-job-item, .recent-result-item').forEach(item => item.remove());
     }


    // --- Fetch and Render Functions ---

    async function fetchAndRenderRecentJobs() {
        showListStatus(recentJobsList, loadingRecentJobs, errorRecentJobs, noRecentJobs, false);

        try {
            const response = await fetch('/jobs_list');
            if (!response.ok) {
                throw new Error(`HTTP error ${response.status}`);
            }
            const jobs = await response.json();

            loadingRecentJobs.style.display = 'none'; // Hide loading indicator

            // Clear previous items
            recentJobsList.querySelectorAll('.recent-job-item').forEach(item => item.remove());

            if (!jobs || jobs.length === 0) {
                 displayNoData(recentJobsList, loadingRecentJobs, errorRecentJobs, noRecentJobs);
                return;
            }

             showListStatus(recentJobsList, loadingRecentJobs, errorRecentJobs, noRecentJobs, true);

            // Backend already sorts by time desc, just take the top N
            const recent = jobs.slice(0, MAX_ITEMS);

            recent.forEach(job => {
                const li = document.createElement('li');
                li.className = 'list-group-item recent-job-item'; // Add specific class

                const statusInfo = getJobStatusClassAndIcon(job.status);
                const displayTime = job.status === 'staged' ? job.staged_at : (job.ended_at || job.started_at || job.enqueued_at);
                const timeLabel = job.status === 'staged' ? 'Staged:' : (job.ended_at ? 'Ended:' : (job.started_at ? 'Started:' : 'Queued:'));

                li.innerHTML = `
                     <a href="/jobs" class="text-decoration-none text-dark d-flex flex-column flex-grow-1">
                         <span class="job-id" title="${job.id}">${job.id.substring(0, 18)}...</span>
                         <small class="text-muted">${job.description || 'No description'}</small>
                     </a>
                     <span class="job-status ${statusInfo.class}" title="${job.status}">
                        <i class="${statusInfo.icon}"></i>
                        <span class="ml-1 d-none d-lg-inline">${job.status.charAt(0).toUpperCase() + job.status.slice(1)}</span>
                        <div class="small text-muted">${timeLabel} ${formatTimestamp(displayTime)}</div>
                    </span>

                `;
                // Make the whole item link to jobs page for now, could refine later
                 li.addEventListener('click', () => window.location.href = '/jobs'); // Simple navigation
                recentJobsList.appendChild(li);
            });

        } catch (error) {
            console.error('Error fetching recent jobs:', error);
             displayListError(recentJobsList, loadingRecentJobs, errorRecentJobs, noRecentJobs);
        }
    }

    async function fetchAndRenderRecentResults() {
        showListStatus(recentResultsList, loadingRecentResults, errorRecentResults, noRecentResults, false);

        try {
            const response = await fetch('/get_results'); // Fetches run directories
            if (!response.ok) {
                throw new Error(`HTTP error ${response.status}`);
            }
            let runs = await response.json();

             loadingRecentResults.style.display = 'none'; // Hide loading indicator

             // Clear previous items
             recentResultsList.querySelectorAll('.recent-result-item').forEach(item => item.remove());

            if (!runs || runs.length === 0) {
                 displayNoData(recentResultsList, loadingRecentResults, errorRecentResults, noRecentResults);
                return;
            }

            showListStatus(recentResultsList, loadingRecentResults, errorRecentResults, noRecentResults, true);


            // Sort by modified time descending (most recent first) client-side
            runs.sort((a, b) => (b.modified_time || 0) - (a.modified_time || 0));

            const recent = runs.slice(0, MAX_ITEMS);

            recent.forEach(run => {
                const li = document.createElement('li');
                li.className = 'list-group-item list-group-item-action recent-result-item'; // Make it actionable

                // Create link to the specific result, highlighting it
                const resultLink = `/results?highlight=${encodeURIComponent(run.name)}`;

                li.innerHTML = `
                    <span class="result-name" title="${run.name}">${run.name}</span>
                    <span class="result-date">
                        ${formatTimestamp(run.modified_time)}
                        <i class="fas fa-chevron-right ml-2 small text-muted"></i>
                    </span>
                `;
                // Make the list item clickable
                 li.addEventListener('click', () => window.location.href = resultLink);
                recentResultsList.appendChild(li);
            });

        } catch (error) {
            console.error('Error fetching recent results:', error);
             displayListError(recentResultsList, loadingRecentResults, errorRecentResults, noRecentResults);
        }
    }

    // --- Initial Load ---
    fetchAndRenderRecentJobs();
    fetchAndRenderRecentResults();

});
