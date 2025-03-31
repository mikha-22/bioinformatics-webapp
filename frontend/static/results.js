// frontend/static/results.js
document.addEventListener('DOMContentLoaded', function() {
    // --- DOM Elements ---
    const runsListContainer = document.getElementById('runs-list');
    const loadingRunsDiv = document.getElementById('loading-runs');
    const noRunsDiv = document.getElementById('no-runs');
    const errorRunsDiv = document.getElementById('error-runs');
    const filterInput = document.getElementById('filter-runs');
    const sortButtons = document.querySelectorAll('#results-controls [data-sort]');
    const sortDirectionButton = document.getElementById('sort-direction-btn');

    // --- State ---
    let allRunsData = []; // Store the fetched run data
    let currentSort = { field: 'date', direction: 'desc' }; // Default sort: newest first

    // --- Helper Functions ---

    /** Formats bytes into human-readable format */
    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0 || bytes === null || bytes === undefined) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    /** Formats a timestamp (seconds since epoch) into a locale string */
    function formatTimestamp(timestamp) {
        if (!timestamp) return 'N/A';
        try {
            return new Date(timestamp * 1000).toLocaleString();
        } catch (e) {
            return 'Invalid Date';
        }
    }

    /** Gets a Font Awesome or Bootstrap icon class based on file extension */
    function getFileIconClass(extension) {
        // Simple mapping, expand as needed
        const ext = extension ? extension.toLowerCase() : '';
        switch (ext) {
            case '.bam': case '.sam': case '.cram': return 'fas fa-dna text-primary'; // DNA icon
            case '.bai': case '.crai': return 'fas fa-barcode text-secondary'; // Index/Barcode
            case '.vcf': case '.vcf.gz': case '.gvcf': return 'fas fa-file-medical-alt text-info'; // Variant file
            case '.bed': case '.gtf': case '.gff': return 'fas fa-bed text-warning'; // Genomic intervals
            case '.fasta': case '.fa': case '.fastq': case '.fq': case '.fasta.gz': case '.fastq.gz': return 'fas fa-dna text-success'; // Sequence file
            case '.log': case '.txt': case '.out': case '.err': return 'far fa-file-alt text-muted'; // Text/Log file
            case '.tsv': case '.csv': return 'fas fa-table text-dark'; // Table
            case '.json': return 'fas fa-code text-purple'; // Code/JSON
            case '.png': case '.jpg': case '.jpeg': case '.gif': case '.svg': case '.pdf': return 'far fa-image text-danger'; // Image/PDF
            case '.zip': case '.gz': case '.tar': case '.bz2': return 'far fa-file-archive text-secondary'; // Archive
            default: return 'far fa-file'; // Generic file
        }
    }

    /** Toggles the visibility of status messages */
    function showStatus(element, show = true) {
        if (element) {
            element.style.display = show ? 'block' : 'none';
        }
    }

    // --- Core Logic ---

    /** Fetches the list of run directories from the backend */
    async function fetchRuns() {
        showStatus(loadingRunsDiv, true);
        showStatus(noRunsDiv, false);
        showStatus(errorRunsDiv, false);
        runsListContainer.innerHTML = ''; // Clear previous runs

        try {
            const response = await fetch('/get_results');
            if (!response.ok) {
                throw new Error(`Failed to fetch runs list (${response.status})`);
            }
            allRunsData = await response.json();
            showStatus(loadingRunsDiv, false);

            if (allRunsData.length === 0) {
                showStatus(noRunsDiv, true);
            } else {
                sortAndRenderRuns(); // Initial sort and render
                applyHighlight(); // Apply highlight after rendering
            }
        } catch (error) {
            console.error('Error fetching runs:', error);
            showStatus(loadingRunsDiv, false);
            showStatus(errorRunsDiv, true);
        }
    }

    /** Sorts the `allRunsData` array based on `currentSort` */
    function sortRunsData() {
        const { field, direction } = currentSort;
        allRunsData.sort((a, b) => {
            let valA, valB;
            if (field === 'name') {
                valA = a.name.toLowerCase();
                valB = b.name.toLowerCase();
            } else { // date (modified_time)
                valA = a.modified_time || 0;
                valB = b.modified_time || 0;
            }

            let comparison = 0;
            if (valA > valB) {
                comparison = 1;
            } else if (valA < valB) {
                comparison = -1;
            }
            return direction === 'asc' ? comparison : comparison * -1;
        });
    }


    /** Renders the list of runs into the container */
    function renderRuns() {
        runsListContainer.innerHTML = ''; // Clear previous content
        const fragment = document.createDocumentFragment();

        allRunsData.forEach(run => {
             // Filter logic applied here before creating the element
            const filterText = filterInput.value.toLowerCase();
             if (filterText && !run.name.toLowerCase().includes(filterText)) {
                 return; // Skip rendering if it doesn't match filter
             }

            const runItem = document.createElement('div');
            runItem.className = 'run-item card mb-2';
            runItem.dataset.runName = run.name; // Store name for filtering/fetching files

            // Construct File Browser link safely
            const fbLink = run.filebrowser_link || '#'; // Fallback link

            runItem.innerHTML = `
                <div class="card-header d-flex justify-content-between align-items-center flex-wrap">
                    <div class="d-flex align-items-center">
                        <button class="btn btn-sm btn-light mr-2 expand-btn" title="Show/Hide Files" data-target-id="files-${run.name.replace(/[^a-zA-Z0-9]/g, '-')}" aria-expanded="false">
                            <i class="fas fa-plus"></i>
                        </button>
                        <div>
                           <strong class="run-name mr-2">${run.name}</strong>
                           <small class="run-date text-muted">Modified: ${formatTimestamp(run.modified_time)}</small>
                        </div>
                    </div>
                    <a href="${fbLink}" class="btn btn-sm btn-outline-primary filebrowser-link ml-auto mt-1 mt-md-0" target="_blank" title="Open in File Browser">
                        <i class="bi bi-folder-symlink"></i> <span class="d-none d-md-inline">File Browser</span>
                    </a>
                </div>
                <div id="files-${run.name.replace(/[^a-zA-Z0-9]/g, '-')}" class="collapse">
                    <div class="card-body p-0">
                        <ul class="list-group list-group-flush file-list">
                            <li class="list-group-item file-list-loading text-muted" style="display: none;">
                                <i class="fas fa-spinner fa-spin"></i> Loading files...
                            </li>
                            <li class="list-group-item file-list-error text-danger" style="display: none;">
                                Error loading files for this run.
                            </li>
                            <!-- File items will be added here -->
                        </ul>
                    </div>
                </div>
            `;
            fragment.appendChild(runItem);
        });
        runsListContainer.appendChild(fragment);
    }

    /** Sorts the data and re-renders the list */
    function sortAndRenderRuns() {
        sortRunsData();
        renderRuns();
    }

    /** Applies highlight to a run if specified in URL */
    function applyHighlight() {
        if (window.highlightRun) {
            // Find the element using the data attribute
            const targetElement = runsListContainer.querySelector(`.run-item[data-run-name="${window.highlightRun}"]`);
            if (targetElement) {
                targetElement.classList.add('highlighted');
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Optionally auto-expand
                // const expandButton = targetElement.querySelector('.expand-btn');
                // if (expandButton && expandButton.getAttribute('aria-expanded') === 'false') {
                //    handleExpandCollapse(expandButton, window.highlightRun);
                // }
            } else {
                console.warn(`Highlight run "${window.highlightRun}" not found in the list.`);
            }
        }
    }


    /** Fetches and displays files for a specific run */
    async function fetchAndRenderFiles(runName, fileListUl, loadingLi, errorLi) {
        showStatus(loadingLi, true);
        showStatus(errorLi, false);

        // Clear previous file list items (excluding loading/error messages)
        Array.from(fileListUl.children).forEach(child => {
            if (!child.classList.contains('file-list-loading') && !child.classList.contains('file-list-error')) {
                child.remove();
            }
        });

        try {
            // Encode the run name for the URL path segment
            const encodedRunName = encodeURIComponent(runName);
            const response = await fetch(`/get_results/${encodedRunName}`);
            if (!response.ok) {
                 const errorData = await response.json().catch(() => ({detail: `HTTP ${response.status}`}));
                throw new Error(`Failed to fetch files for ${runName} (${response.status}): ${errorData.detail || 'Unknown error'}`);
            }
            const files = await response.json();
            showStatus(loadingLi, false);

            if (files.length === 0) {
                const noFilesLi = document.createElement('li');
                noFilesLi.className = 'list-group-item text-muted';
                noFilesLi.textContent = 'No files found in this run directory.';
                fileListUl.appendChild(noFilesLi);
            } else {
                const fragment = document.createDocumentFragment();
                files.sort((a, b) => a.name.localeCompare(b.name)); // Sort files alphabetically
                files.forEach(file => {
                    const fileLi = document.createElement('li');
                    fileLi.className = 'list-group-item d-flex justify-content-between align-items-center file-list-item';
                    const iconClass = getFileIconClass(file.extension);

                    fileLi.innerHTML = `
                        <div>
                           <span class="file-icon"><i class="${iconClass}"></i></span>
                           <span class="file-name">${file.name}</span>
                        </div>
                        <span class="file-meta">
                            ${file.is_dir ? '(Directory)' : formatBytes(file.size)}
                             - ${formatTimestamp(file.modified_time)}
                        </span>
                    `;
                    fragment.appendChild(fileLi);
                });
                fileListUl.appendChild(fragment);
            }

        } catch (error) {
            console.error(`Error fetching files for ${runName}:`, error);
            showStatus(loadingLi, false);
            errorLi.textContent = `Error loading files: ${error.message}`;
            showStatus(errorLi, true);
        }
    }

    /** Handles expand/collapse button clicks */
    function handleExpandCollapse(button, runName) {
        const targetId = button.dataset.targetId;
        const targetCollapse = document.getElementById(targetId);
        const fileListUl = targetCollapse.querySelector('.file-list');
        const loadingLi = targetCollapse.querySelector('.file-list-loading');
        const errorLi = targetCollapse.querySelector('.file-list-error');
        const icon = button.querySelector('i');

        const isExpanded = button.getAttribute('aria-expanded') === 'true';

        if (isExpanded) {
            // Collapse
            targetCollapse.style.maxHeight = null; // Or use Bootstrap's JS if integrated
            targetCollapse.classList.remove('show'); // For Bootstrap 4/5 JS integration
             button.setAttribute('aria-expanded', 'false');
             icon.classList.remove('fa-minus');
             icon.classList.add('fa-plus');
        } else {
            // Expand
             // Basic animation (can enhance with CSS transitions)
            targetCollapse.classList.add('show'); // For Bootstrap 4/5 JS integration
            targetCollapse.style.maxHeight = targetCollapse.scrollHeight + "px"; // Basic height animation
             button.setAttribute('aria-expanded', 'true');
             icon.classList.remove('fa-plus');
             icon.classList.add('fa-minus');

            // Fetch files only if the list hasn't been loaded yet
             // Check if files (excluding loading/error placeholders) are already present
            const hasFiles = Array.from(fileListUl.children).some(child =>
                 !child.classList.contains('file-list-loading') && !child.classList.contains('file-list-error')
            );
            if (!hasFiles) {
                fetchAndRenderFiles(runName, fileListUl, loadingLi, errorLi);
            }
        }
         // Adjust maxHeight after content is potentially loaded (or use CSS transitions)
        setTimeout(() => {
             if(button.getAttribute('aria-expanded') === 'true') {
                 targetCollapse.style.maxHeight = targetCollapse.scrollHeight + "px";
             }
         }, 300); // Delay slightly for content loading/rendering
    }


    // --- Event Listeners ---

    // Filter input
    filterInput.addEventListener('input', () => {
        renderRuns(); // Re-render applies the filter
        applyHighlight(); // Re-apply highlight if filter changes
    });

    // Sort buttons
    sortButtons.forEach(button => {
        button.addEventListener('click', () => {
            const newSortField = button.dataset.sort;
            // If clicking the same field, toggle direction, else set to default desc
            if (currentSort.field === newSortField) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.field = newSortField;
                currentSort.direction = 'desc'; // Default to descending for new field
            }
             updateSortUI();
             sortAndRenderRuns();
             applyHighlight();
        });
    });

     // Sort direction button
     sortDirectionButton.addEventListener('click', () => {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        updateSortUI();
        sortAndRenderRuns();
        applyHighlight();
    });


    // Expand/Collapse (using event delegation)
    runsListContainer.addEventListener('click', function(event) {
        const button = event.target.closest('.expand-btn');
        if (button) {
            const runItem = button.closest('.run-item');
            const runName = runItem.dataset.runName;
            handleExpandCollapse(button, runName);
        }
    });

     // --- UI Update Helpers ---
     function updateSortUI() {
        // Update active sort button
        sortButtons.forEach(btn => {
             if(btn.dataset.sort === currentSort.field) {
                 btn.classList.add('active');
             } else {
                 btn.classList.remove('active');
             }
         });
        // Update sort direction icon
        const icon = sortDirectionButton.querySelector('i');
         icon.className = `fas ${currentSort.direction === 'asc' ? 'fa-sort-up' : 'fa-sort-down'}`;
     }


    // --- Initial Load ---
    updateSortUI(); // Set initial sort button active state
    fetchRuns();

});
