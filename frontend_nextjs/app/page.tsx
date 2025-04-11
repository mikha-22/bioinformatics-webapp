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
      </div>
    </>
  );
}