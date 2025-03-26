document.addEventListener('DOMContentLoaded', function() {
    fetchOutputFiles();
});

async function fetchOutputFiles() {
    try {
        const response = await fetch('/get_results'); // Updated endpoint URL
        if (!response.ok) {
            console.error('Failed to fetch output files:', response.status);
            return;
        }
        const files = await response.json();
        displayOutputFiles(files);
    } catch (error) {
        console.error('Error fetching output files:', error);
    }
}

function displayOutputFiles(files) {
    const filesList = document.getElementById('files-list');
    filesList.innerHTML = ''; // Clear any existing list items
    if (files && files.length > 0) {
        files.forEach(file => {
            const listItem = document.createElement('li');
            listItem.textContent = file.name; // Directly set the text content (making it unclickable)
            filesList.appendChild(listItem);
        });
    } else {
        const listItem = document.createElement('li');
        listItem.textContent = 'No output files found.';
        filesList.appendChild(listItem);
    }
}
