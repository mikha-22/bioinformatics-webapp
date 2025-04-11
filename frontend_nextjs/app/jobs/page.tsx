tsx
export default function Jobs() {
  return (
    <>
      <head>
        <title>Sarek Jobs Queue</title>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css"
        />
        <link rel="stylesheet" href="/frontend/static/jobs.css"></link>
      </head>
      <div>
        <div className="container-fluid mt-4">
          <div className="row mb-4">
            <div className="col">
              <h1 className="mb-3">
                <i className="fas fa-tasks me-2"></i>Pipeline Jobs Dashboard
              </h1>
              <div className="alert alert-info">
                <i className="fas fa-info-circle me-2"></i> Monitor your Sarek
                pipeline jobs here. View status, details, and manage running
                jobs.
              </div>
            </div>
          </div>

          {/* Job Statistics */}
          <div className="row mb-4">
            <div className="col-md-3">
              <div className="card bg-primary text-white">
                <div className="card-body">
                  <h5 className="card-title">
                    <i className="fas fa-play-circle me-2"></i>Running
                  </h5>
                  <h2 className="card-text" id="running-jobs-count">
                    0
                  </h2>
                </div>
              </div>
            </div>
            <div className="col-md-3">
              <div className="card bg-warning text-dark">
                <div className="card-body">
                  <h5 className="card-title">
                    <i className="fas fa-clock me-2"></i>Queued
                  </h5>
                  <h2 className="card-text" id="queued-jobs-count">
                    0
                  </h2>
                </div>
              </div>
            </div>
            <div className="col-md-3">
              <div className="card bg-success text-white">
                <div className="card-body">
                  <h5 className="card-title">
                    <i className="fas fa-check-circle me-2"></i>Completed
                  </h5>
                  <h2 className="card-text" id="completed-jobs-count">
                    0
                  </h2>
                </div>
              </div>
            </div>
            <div className="col-md-3">
              <div className="card bg-danger text-white">
                <div className="card-body">
                  <h5 className="card-title">
                    <i className="fas fa-exclamation-circle me-2"></i>Failed
                  </h5>
                  <h2 className="card-text" id="failed-jobs-count">
                    0
                  </h2>
                </div>
              </div>
            </div>
          </div>

          {/* Global status message placeholder */}
          <div id="jobs-status-global"></div>

          {/* Controls */}
          <div className="row mb-4">
            <div className="col-md-6">
              <div className="input-group">
                <span className="input-group-text">
                  <i className="fas fa-search"></i>
                </span>
                <input
                  type="text"
                  className="form-control"
                  id="search-jobs"
                  placeholder="Search jobs..."
                />
              </div>
            </div>
            <div className="col-md-6 text-end">
              <button className="btn btn-primary" id="refresh-jobs-btn">
                <i className="fas fa-sync-alt me-2"></i> Refresh List
              </button>
              <div className="btn-group ms-2">
                <button className="btn btn-outline-secondary" data-filter="all">
                  All Jobs
                </button>
                <button
                  className="btn btn-outline-secondary"
                  data-filter="running"
                >
                  Running
                </button>
                <button
                  className="btn btn-outline-secondary"
                  data-filter="queued"
                >
                  Queued
                </button>
                <button
                  className="btn btn-outline-secondary"
                  data-filter="completed"
                >
                  Completed
                </button>
                <button
                  className="btn btn-outline-secondary"
                  data-filter="failed"
                >
                  Failed
                </button>
              </div>
            </div>
          </div>

          {/* Jobs Table */}
          <div className="card">
            <div className="card-body p-0">
              <div className="table-responsive">
                <table className="table table-hover mb-0" id="jobs-table">
                  <thead className="table-light">
                    <tr>
                      <th scope="col" style={{ width: "25%" }}>
                        <i className="fas fa-info-circle me-2"></i>Job Details
                      </th>
                      <th scope="col" style={{ width: "20%" }}>
                        <i className="fas fa-file-alt me-2"></i>Input Files
                      </th>
                      <th scope="col" style={{ width: "20%" }}>
                        <i className="fas fa-cogs me-2"></i>Parameters
                      </th>
                      <th scope="col" style={{ width: "20%" }}>
                        <i className="fas fa-clock me-2"></i>Time & Resources
                      </th>
                      <th scope="col" style={{ width: "15%" }} className="text-center">
                        <i className="fas fa-tasks me-2"></i>Status/Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr id="loading-jobs-row" style={{ display: "none" }}>
                      <td colspan={5} className="text-center p-4">
                        <div
                          className="spinner-border text-primary"
                          role="status"
                        >
                          <span className="visually-hidden">Loading...</span>
                        </div>
                        <p className="text-muted mt-2">Loading jobs...</p>
                      </td>
                    </tr>
                    <tr id="no-jobs-row" style={{ display: "none" }}>
                      <td colspan={5} className="text-center p-4">
                        <i className="fas fa-inbox fa-3x text-muted mb-3"></i>
                        <p className="text-muted">No jobs found.</p>
                      </td>
                    </tr>
                    <tr id="error-jobs-row" style={{ display: "none" }}>
                      <td colspan={5} className="text-center p-4">
                        <i className="fas fa-exclamation-triangle fa-3x text-danger mb-3"></i>
                        <p className="text-danger">
                          Could not load jobs list.
                        </p>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* Job Details Modal */}
        <div className="modal fade" id="job-details-modal" tabIndex={-1}>
          <div className="modal-dialog modal-lg">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">
                  <i className="fas fa-info-circle me-2"></i>Job Details
                </h5>
                <button
                  type="button"
                  className="btn-close"
                  data-bs-dismiss="modal"
                ></button>
              </div>
              <div className="modal-body">
                <ul className="nav nav-tabs mb-3">
                  <li className="nav-item">
                    <a
                      className="nav-link active"
                      data-bs-toggle="tab"
                      href="#details-tab"
                    >
                      <i className="fas fa-info-circle me-2"></i>Details
                    </a>
                  </li>
                  <li className="nav-item">
                    <a
                      className="nav-link"
                      data-bs-toggle="tab"
                      href="#files-tab"
                    >
                      <i className="fas fa-file-alt me-2"></i>Files
                    </a>
                  </li>
                  <li className="nav-item">
                    <a
                      className="nav-link"
                      data-bs-toggle="tab"
                      href="#logs-tab"
                    >
                      <i className="fas fa-terminal me-2"></i>Logs
                    </a>
                  </li>
                </ul>
                <div className="tab-content">
                  <div className="tab-pane fade show active" id="details-tab">
                    <div className="row">
                      <div className="col-md-6">
                        <h6>
                          <i className="fas fa-cogs me-2"></i>Parameters
                        </h6>
                        <ul id="job-parameters" className="list-unstyled"></ul>
                      </div>
                      <div className="col-md-6">
                        <h6>
                          <i className="fas fa-chart-line me-2"></i>Resource Usage
                        </h6>
                        <ul id="job-resources" className="list-unstyled"></ul>
                      </div>
                    </div>
                    <hr />
                    <h6>
                      <i className="fas fa-history me-2"></i>Timeline
                    </h6>
                    <ul id="job-timeline" className="list-unstyled timeline"></ul>
                  </div>
                  <div className="tab-pane fade" id="files-tab">
                    <h6>
                      <i className="fas fa-file-alt me-2"></i>Input Files
                    </h6>
                    <ul id="job-input-files" className="list-unstyled"></ul>
                    <hr />
                    <h6>
                      <i className="fas fa-file-export me-2"></i>Output Files
                    </h6>
                    <ul id="job-output-files" className="list-unstyled"></ul>
                  </div>
                  <div className="tab-pane fade" id="logs-tab">
                    <div className="log-viewer">
                      <pre
                        id="job-logs"
                        className="bg-dark text-light p-3 rounded"
                      ></pre>
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-bs-dismiss="modal"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Error Modal */}
        <div className="modal fade" id="error-modal" tabIndex={-1}>
          <div className="modal-dialog">
            <div className="modal-content">
              <div className="modal-header bg-danger text-white">
                <h5 className="modal-title">
                  <i className="fas fa-exclamation-triangle me-2"></i>Error Details
                </h5>
                <button
                  type="button"
                  className="btn-close btn-close-white"
                  data-bs-dismiss="modal"
                ></button>
              </div>
              <div className="modal-body">
                <pre
                  id="error-modal-text"
                  className="bg-light p-3 rounded"
                ></pre>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-bs-dismiss="modal"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}