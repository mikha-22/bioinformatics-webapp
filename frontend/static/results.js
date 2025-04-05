// frontend/static/results.js
document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
    const resultsContainer = document.getElementById('results-container');
    const loadingPlaceholder = document.getElementById('loading-placeholder');
    const noResultsMessage = document.getElementById('no-results-message');
    const errorMessage = document.getElementById('error-message');
    const parametersModal = document.getElementById('parameters-modal');

    // File Categories
    const FILE_CATEGORIES = {
        'bam': {
            icon: 'fa-dna',
            title: 'Aligned BAM Files',
            description: 'Binary Alignment Map files containing aligned reads'
        },
        'vcf': {
            icon: 'fa-code-branch',
            title: 'VCF Files',
            description: 'Variant Call Format files containing variant calls'
        },
        'qc': {
            icon: 'fa-chart-bar',
            title: 'Quality Control Reports',
            description: 'Quality control metrics and reports'
        },
        'multiqc': {
            icon: 'fa-tasks',
            title: 'MultiQC Reports',
            description: 'Aggregated quality control reports'
        },
        'other': {
            icon: 'fa-file',
            title: 'Other Files',
            description: 'Additional pipeline output files'
        }
    };

    // Load Results
    async function loadResults() {
        try {
            showLoading();
            const response = await fetch('/api/results');
            if (!response.ok) throw new Error('Failed to load results');
            
            const results = await response.json();
            displayResults(results);
        } catch (error) {
            console.error('Error loading results:', error);
            showError('Failed to load results. Please try again.');
        }
    }

    // Display Results
    function displayResults(results) {
        resultsContainer.innerHTML = '';

        if (!results || results.length === 0) {
            showNoResults();
            return;
        }

        results.forEach(result => {
            const resultElement = createResultElement(result);
            resultsContainer.appendChild(resultElement);
        });
    }

    // Create Result Element
    function createResultElement(result) {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'result-item';
        resultDiv.dataset.jobId = result.job_id;

        // Header
        const header = document.createElement('div');
        header.className = 'result-header';
        header.innerHTML = `
            <h3>${result.description || 'Sarek Pipeline Run'}</h3>
            <div class="result-metadata">
                <span><i class="fas fa-clock"></i> ${formatDate(result.completed_at)}</span>
                <span><i class="fas fa-hourglass-half"></i> ${formatDuration(result.duration)}</span>
                <button class="btn btn-info btn-sm view-parameters" title="View Parameters">
                    <i class="fas fa-cog"></i> Parameters
                </button>
            </div>
        `;

        // File Categories
        const categories = document.createElement('div');
        categories.className = 'result-categories';

        // BAM Files
        if (result.bam_files && result.bam_files.length > 0) {
            categories.appendChild(createFileCategory('bam', result.bam_files));
        }

        // VCF Files
        if (result.vcf_files && result.vcf_files.length > 0) {
            categories.appendChild(createFileCategory('vcf', result.vcf_files));
        }

        // QC Reports
        if (result.qc_reports && result.qc_reports.length > 0) {
            categories.appendChild(createFileCategory('qc', result.qc_reports));
        }

        // MultiQC Reports
        if (result.multiqc_reports && result.multiqc_reports.length > 0) {
            categories.appendChild(createFileCategory('multiqc', result.multiqc_reports));
        }

        // Other Files
        if (result.other_files && result.other_files.length > 0) {
            categories.appendChild(createFileCategory('other', result.other_files));
        }

        resultDiv.appendChild(header);
        resultDiv.appendChild(categories);

        // Add event listeners
        addResultEventListeners(resultDiv, result);

        return resultDiv;
    }

    // Create File Category
    function createFileCategory(category, files) {
        const categoryDiv = document.createElement('div');
        categoryDiv.className = 'file-category';
        categoryDiv.innerHTML = `
            <h4><i class="fas ${FILE_CATEGORIES[category].icon}"></i> ${FILE_CATEGORIES[category].title}</h4>
            <p class="category-description">${FILE_CATEGORIES[category].description}</p>
            <ul class="file-list">
                ${files.map(file => `
                    <li>
                        <i class="fas fa-file"></i>
                        <span class="file-name">${file.name}</span>
                        <div class="file-actions">
                            <button class="btn btn-sm btn-primary download-file" data-file="${file.path}" title="Download">
                                <i class="fas fa-download"></i>
                            </button>
                            <button class="btn btn-sm btn-info view-file" data-file="${file.path}" title="View">
                                <i class="fas fa-eye"></i>
                            </button>
                        </div>
                    </li>
                `).join('')}
            </ul>
        `;

        return categoryDiv;
    }

    // Add Result Event Listeners
    function addResultEventListeners(resultElement, result) {
        // View Parameters
        const viewParamsBtn = resultElement.querySelector('.view-parameters');
        if (viewParamsBtn) {
            viewParamsBtn.addEventListener('click', () => showParameters(result));
        }

        // File Actions
        const downloadBtns = resultElement.querySelectorAll('.download-file');
        downloadBtns.forEach(btn => {
            btn.addEventListener('click', () => downloadFile(btn.dataset.file));
        });

        const viewBtns = resultElement.querySelectorAll('.view-file');
        viewBtns.forEach(btn => {
            btn.addEventListener('click', () => viewFile(btn.dataset.file));
        });
    }

    // Show Parameters
    function showParameters(result) {
        const inputFilesList = document.getElementById('param-input-files');
        const parametersList = document.getElementById('param-pipeline-config');
        const resourcesList = document.getElementById('param-resource-usage');

        // Clear previous content
        inputFilesList.innerHTML = '';
        parametersList.innerHTML = '';
        resourcesList.innerHTML = '';

        // Input Files
        inputFilesList.innerHTML = `
            <li><strong>Input CSV:</strong> ${result.input_csv_file}</li>
            <li><strong>Reference Genome:</strong> ${result.reference_genome_file}</li>
            ${result.intervals_file ? `<li><strong>Intervals:</strong> ${result.intervals_file}</li>` : ''}
            ${result.known_variants_file ? `<li><strong>Known Variants:</strong> ${result.known_variants_file}</li>` : ''}
        `;

        // Pipeline Configuration
        parametersList.innerHTML = `
            <li><strong>Genome Build:</strong> ${result.genome}</li>
            <li><strong>Tools:</strong> ${result.tools || 'default'}</li>
            <li><strong>Step:</strong> ${result.step || 'mapping'}</li>
            <li><strong>Profile:</strong> ${result.profile || 'docker'}</li>
            <li><strong>Joint Germline:</strong> ${result.joint_germline ? 'Yes' : 'No'}</li>
            <li><strong>WES:</strong> ${result.wes ? 'Yes' : 'No'}</li>
        `;

        // Resource Usage
        if (result.resources) {
            resourcesList.innerHTML = `
                <li><strong>CPU Usage:</strong> ${result.resources.cpu_usage || 'N/A'}</li>
                <li><strong>Memory Usage:</strong> ${result.resources.memory_usage || 'N/A'}</li>
                <li><strong>Disk Usage:</strong> ${result.resources.disk_usage || 'N/A'}</li>
            `;
        }

        // Show modal
        parametersModal.style.display = 'block';
    }

    // Download File
    async function downloadFile(filePath) {
        try {
            const response = await fetch(`/api/files/download?path=${encodeURIComponent(filePath)}`);
            if (!response.ok) throw new Error('Failed to download file');
            
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filePath.split('/').pop();
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        } catch (error) {
            console.error('Error downloading file:', error);
            showError('Failed to download file. Please try again.');
        }
    }

    // View File
    function viewFile(filePath) {
        // Open file in new tab
        window.open(`/api/files/view?path=${encodeURIComponent(filePath)}`, '_blank');
    }

    // Helper Functions
    function showLoading() {
        loadingPlaceholder.style.display = 'block';
        noResultsMessage.style.display = 'none';
        errorMessage.style.display = 'none';
        resultsContainer.innerHTML = '';
    }

    function showNoResults() {
        loadingPlaceholder.style.display = 'none';
        noResultsMessage.style.display = 'block';
        errorMessage.style.display = 'none';
        resultsContainer.innerHTML = '';
    }

    function showError(message) {
        loadingPlaceholder.style.display = 'none';
        noResultsMessage.style.display = 'none';
        errorMessage.style.display = 'block';
        errorMessage.textContent = message;
        resultsContainer.innerHTML = '';
    }

    function formatDate(dateString) {
        return new Date(dateString).toLocaleString();
    }

    function formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = seconds % 60;

        const parts = [];
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (remainingSeconds > 0 || parts.length === 0) parts.push(`${remainingSeconds}s`);

        return parts.join(' ');
    }

    // Event Listeners
    window.addEventListener('click', function(event) {
        if (event.target === parametersModal) {
            parametersModal.style.display = 'none';
        }
    });

    // Initial load
    loadResults();
});
