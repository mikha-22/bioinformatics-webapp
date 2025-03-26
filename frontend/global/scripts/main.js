let isPipelineRunning = false;
let currentProcessedFile = "No file";
let pipelineProgress = 0;
let websocket;

document.addEventListener('DOMContentLoaded', function() {
    const pipelineStatusIndicator = document.getElementById('pipeline-status-indicator');
    const pipelineStatusPopup = document.getElementById('pipeline-status-popup');
    const progressBar = document.createElement('div');
    progressBar.className = 'progress';
    progressBar.innerHTML = '<div class="progress-bar" role="progressbar" style="width: 0%" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">0%</div>';
    pipelineStatusPopup.appendChild(progressBar);

    function updatePipelineStatusDisplay() {
        const progressBarInner = pipelineStatusPopup.querySelector('.progress-bar');
        if (isPipelineRunning) {
            pipelineStatusIndicator.classList.remove('idle');
            pipelineStatusIndicator.querySelector('.spinner-border').style.display = 'inline-block';
            pipelineStatusIndicator.title = 'Pipeline is running. Click to see details.';
            pipelineStatusPopup.querySelector('p').textContent = `Currently processing: ${currentProcessedFile}`;
            progressBarInner.style.width = `${pipelineProgress}%`;
            progressBarInner.textContent = `${pipelineProgress}%`;
            pipelineStatusPopup.style.display = 'block'; // Show popup when running
        } else {
            pipelineStatusIndicator.classList.add('idle');
            pipelineStatusIndicator.querySelector('.spinner-border').style.display = 'none';
            pipelineStatusIndicator.title = 'No pipeline running. Click to see history (not implemented).';
            pipelineStatusPopup.querySelector('p').textContent = 'No pipeline currently running.';
            progressBarInner.style.width = `0%`;
            progressBarInner.textContent = `0%`;
            pipelineStatusPopup.style.display = 'none'; // Hide popup when idle
        }
    }

    // Initially set to idle
    updatePipelineStatusDisplay();

    function connectWebSocket() {
        websocket = new WebSocket(`ws://${window.location.host}/ws/pipeline_status`);

        websocket.onopen = function(event) {
            console.log("WebSocket connection opened");
            isPipelineRunning = false; // Reset status on connection
            updatePipelineStatusDisplay();
        };

        websocket.onmessage = function(event) {
            const status = JSON.parse(event.data);
            isPipelineRunning = status.status === 'running';
            currentProcessedFile = status.current_file;
            pipelineProgress = status.progress;
            updatePipelineStatusDisplay();
        };

        websocket.onclose = function(event) {
            console.log("WebSocket connection closed");
            // Attempt to reconnect after a delay
            setTimeout(connectWebSocket, 3000);
        };

        websocket.onerror = function(error) {
            console.error("WebSocket error:", error);
        };
    }

    connectWebSocket();

    // Toggle popup visibility on indicator click
    const pipelineStatusIndicatorElem = document.getElementById('pipeline-status-indicator');
    if (pipelineStatusIndicatorElem) {
        pipelineStatusIndicatorElem.addEventListener('click', function() {
            pipelineStatusPopup.style.display = (pipelineStatusPopup.style.display === 'none' || pipelineStatusPopup.style.display === '') ? 'block' : 'none';
        });
    }

    // Close popup if clicked outside
    document.addEventListener('click', function(event) {
        const indicatorElem = document.getElementById('pipeline-status-indicator');
        if (indicatorElem && !indicatorElem.contains(event.target)) {
            pipelineStatusPopup.style.display = 'none';
        }
    });

    // You might have other global scripts here
});

// Update run_pipeline.js to trigger pipeline start
document.addEventListener('DOMContentLoaded', function() {
    const runPipelineBtn = document.getElementById('runPipelineBtn');
    const pipelineStatusDiv = document.getElementById('pipeline-status');
    const forwardReadsSelect = document.getElementById('forwardReads');
    const reverseReadsSelect = document.getElementById('reverseReads');
    const referenceGenomeSelect = document.getElementById('referenceGenome');
    const targetRegionsSelect = document.getElementById('targetRegions');
    const knownVariantsSelect = document.getElementById('knownVariants');
    const mandatorySelects = [forwardReadsSelect, reverseReadsSelect, referenceGenomeSelect, targetRegionsSelect];

    function populateDropdown(selectElement, files, extensions) {
        files.forEach(file => {
            if (extensions.some(ext => file.name.endsWith(ext))) {
                const option = document.createElement('option');
                option.value = file.name;
                option.textContent = file.name;
                selectElement.appendChild(option);
            }
        });
    }

    fetch('/files')
        .then(response => response.json())
        .then(data => {
            populateDropdown(forwardReadsSelect, data, ['.fastq', '.fastq.gz']);
            populateDropdown(reverseReadsSelect, data, ['.fastq', '.fastq.gz']);
            populateDropdown(referenceGenomeSelect, data, ['.fasta', '.fasta.gz']);
            populateDropdown(targetRegionsSelect, data, ['.bed']);
            populateDropdown(knownVariantsSelect, data, ['.vcf', '.vcf.gz']);
        })
        .catch(error => {
            console.error('Error fetching file list:', error);
            pipelineStatusDiv.textContent = 'Error fetching the list of available files.';
        });

    function checkMandatoryFiles() {
        return mandatorySelects.every(select => select.value !== "");
    }

    mandatorySelects.forEach(select => {
        select.addEventListener('change', function() {
            runPipelineBtn.disabled = !checkMandatoryFiles();
        });
    });

    runPipelineBtn.addEventListener('click', function() {
        if (checkMandatoryFiles()) {
            runPipelineBtn.disabled = true;
            runPipelineBtn.textContent = 'Running Pipeline...';
            pipelineStatusDiv.textContent = 'Pipeline started. Please wait...';

            const payload = {
                forward_reads_file: forwardReadsSelect.value,
                reverse_reads_file: reverseReadsSelect.value,
                reference_genome_file: referenceGenomeSelect.value,
                target_regions_file: targetRegionsSelect.value,
                known_variants_file: knownVariantsSelect.value === "None" ? null : knownVariantsSelect.value
            };

            fetch('/run_pipeline', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            })
            .then(response => response.json())
            .then(data => {
                runPipelineBtn.disabled = false;
                runPipelineBtn.textContent = 'Run Pipeline';
                pipelineStatusDiv.textContent = data.message || 'Pipeline completed.';
                // WebSocket updates will handle the status
            })
            .catch(error => {
                runPipelineBtn.disabled = false;
                runPipelineBtn.textContent = 'Run Pipeline';
                pipelineStatusDiv.textContent = 'Error running the pipeline.';
                // WebSocket updates will handle the status
            });
        } else {
            pipelineStatusDiv.textContent = 'Please select all mandatory input files.';
        }
    });
});
