import React from 'react';

export default function Home() {
  return (
    <>
      <head>
        <title>Bioinformatics Webapp - Home</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css"></link>
        <style>{`
          .dashboard-card { margin-bottom: 1.5rem; }
          .list-group-item-action { cursor: pointer; } /* Make list items look clickable */
          .recent-job-item, .recent-result-item {
            font-size: 0.9rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.6rem 1rem; /* Adjust padding */
          }
          .recent-job-item .job-status,
          .recent-result-item .result-date {
            font-size: 0.8em;
            color: #6c757d; /* Bootstrap secondary text color */
            white-space: nowrap;
            margin-left: 1rem;
          }
          .recent-job-item .job-id {
            font-family: monospace;
            font-size: 0.85em;
          }
          .recent-job-item .job-status i {
             margin-right: 4px;
             vertical-align: middle;
          }
          .recent-result-item .result-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 70%; /* Prevent long names from pushing date off */
          }
          #loading-recent-jobs, #loading-recent-results,
          #error-recent-jobs, #error-recent-results,
          #no-recent-jobs, #no-recent-results {
            padding: 0.6rem 1rem;
            font-style: italic;
          }
        `}</style>
      </head>
      <div>
        <div className="jumbotron jumbotron-fluid bg-light p-4 mb-4 rounded">
          <div className="container">
            <h1 className="display-4">Bioinformatics Pipeline</h1>
            <p className="lead">Stage, run, and manage your bioinformatics analysis pipelines.</p>
            {/* Simple App Overview */}
            <p>Use this application to process sequencing data through a standard pipeline involving alignment, variant calling, and annotation (using files like FASTQ, FASTA, BED, and optional VCF). Monitor job progress and browse results easily.</p>
          </div>
        </div>

        <div className="row">
          {/* Quick Actions Column */}
          <div className="col-md-4">
            <div className="card dashboard-card">
              <div className="card-header">
                <i className="fas fa-rocket mr-1"></i> Quick Actions
              </div>
              <div className="list-group list-group-flush">
                <a href="/run_pipeline" className="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
                  <span><i className="fas fa-play-circle fa-fw mr-2 text-primary"></i>Stage New Run</span>
                  <i className="fas fa-chevron-right text-muted small"></i>
                </a>
                <a href="/jobs" className="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
                  <span><i className="fas fa-tasks fa-fw mr-2 text-info"></i>View Jobs Dashboard</span>
                  <i className="fas fa-chevron-right text-muted small"></i>
                </a>
                <a href="/results" className="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
                  <span><i className="fas fa-chart-bar fa-fw mr-2 text-success"></i>Browse Results</span>
                  <i className="fas fa-chevron-right text-muted small"></i>
                </a>
                {/* Button to trigger File Browser overlay */}
                <button type="button" className="list-group-item list-group-item-action d-flex justify-content-between align-items-center" id="openFileBrowserBtn">
                  <span><i className="fas fa-folder-open fa-fw mr-2 text-warning"></i>Manage Data Files</span>
                  <i className="fas fa-chevron-right text-muted small"></i>
                </button>
              </div>
            </div>
          </div>

          {/* Recent Activity Column */}
          <div className="col-md-8">
            <div className="row">
              {/* Recent Jobs Card */}
              <div className="col-lg-6">
                <div className="card dashboard-card">
                  <div className="card-header">
                    <i className="fas fa-history mr-1"></i> Recent Jobs
                  </div>
                  <ul className="list-group list-group-flush" id="recent-jobs-list">
                    <li className="list-group-item text-muted" id="loading-recent-jobs" style={{ display: 'none' }}>
                      <i className="fas fa-spinner fa-spin mr-1"></i> Loading...
                    </li>
                    <li className="list-group-item text-danger" id="error-recent-jobs" style={{ display: 'none' }}>
                      <i className="fas fa-exclamation-triangle mr-1"></i> Error loading jobs.
                    </li>
                    <li className="list-group-item text-muted" id="no-recent-jobs" style={{ display: 'none' }}>
                      No recent jobs found.
                    </li>
                    {/* Job items will be injected here by JS */}
                  </ul>
                  <div className="card-footer text-center bg-light">
                    <a href="/jobs" className="small text-muted">View All Jobs <i className="fas fa-angle-right ml-1"></i></a>
                  </div>
                </div>
              </div>

              {/* Recent Results Card */}
              <div className="col-lg-6">
                <div className="card dashboard-card">
                  <div className="card-header">
                    {/* Updated Icon Here */}
                    <i className="fas fa-folder-open mr-1 text-warning"></i> Recent Results
                  </div>
                  <ul className="list-group list-group-flush" id="recent-results-list">
                    <li className="list-group-item text-muted" id="loading-recent-results" style={{ display: 'none' }}>
                      <i className="fas fa-spinner fa-spin mr-1"></i> Loading...
                    </li>
                    <li className="list-group-item text-danger" id="error-recent-results" style={{ display: 'none' }}>
                      <i className="fas fa-exclamation-triangle mr-1"></i> Error loading results.
                    </li>
                    <li className="list-group-item text-muted" id="no-recent-results" style={{ display: 'none' }}>
                      No recent results found.
                    </li>
                    {/* Result items will be injected here by JS */}
                  </ul>
                  <div className="card-footer text-center bg-light">
                    <a href="/results" className="small text-muted">View All Results <i className="fas fa-angle-right ml-1"></i></a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <script>{`
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
        let response;
        try {
            response = await fetch('/jobs_list');
            if (!response.ok) {
                console.error('HTTP Error during fetch:', response.status);
                return [];
            }
            const jobs = await response.json() || [];
            }
            const jobs = await response?.json() || [];

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

                li.innerHTML = \`
                     <a href="/jobs" class="text-decoration-none text-dark d-flex flex-column flex-grow-1">
                         <span class="job-id" title="\${job.id}">\${job.id.substring(0, 18)}...</span>
                         <small class="text-muted">\${job.description || 'No description'}</small>
                     </a>
                     <span class="job-status \${statusInfo.class}" title="\${job.status}">
                        <i class="\${statusInfo.icon}"></i>
                        <span class="ml-1 d-none d-lg-inline">\${job.status.charAt(0).toUpperCase() + job.status.slice(1)}</span>
                        <div class="small text-muted">\${timeLabel} \${formatTimestamp(displayTime)}</div>
                    </span>

                \`;
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
        // Placeholder - Implement similar logic as fetchAndRenderRecentJobs for results
    }

    // --- Initial Load ---
    fetchAndRenderRecentJobs();
    fetchAndRenderRecentResults();

});
`}</script>
      </div>
    </>
  );
}