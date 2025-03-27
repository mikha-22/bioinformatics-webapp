document.addEventListener('DOMContentLoaded', function() {
    const showButton = document.getElementById('showFileBrowser');
    const closeButton = document.getElementById('closeFileBrowser');
    const overlay = document.getElementById('overlay');
    const container = document.getElementById('fileBrowserContainer');

    // Show FileBrowser
    showButton.addEventListener('click', function() {
        container.classList.add('active');
        overlay.classList.add('active');
    });

    // Hide FileBrowser
    function hideFileBrowser() {
        container.classList.remove('active');
        overlay.classList.remove('active');
    }

    closeButton.addEventListener('click', hideFileBrowser);
    overlay.addEventListener('click', hideFileBrowser);

    // Prevent clicks inside iframe from closing the container
    container.addEventListener('click', function(e) {
        e.stopPropagation();
    });
});
