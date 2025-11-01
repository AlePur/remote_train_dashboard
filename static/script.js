// Global variables
let tempChart, powerChart, memoryChart;
let tensorboardCharts = {};
let gpuMonitoringInterval;
let tensorboardMonitoringInterval;
let selectedExperiment = null;
let isTensorboardMonitoring = false;

// Initialize charts on page load
document.addEventListener('DOMContentLoaded', function() {
    initializeCharts();
    setupEventListeners();
    // Start GPU monitoring automatically on page load
    startGPUMonitoring();
});

// Console logging function
function logToConsole(message, type = 'info') {
    const consoleEl = document.getElementById('console');
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    
    const timestamp = new Date().toLocaleTimeString();
    line.innerHTML = `<span class="timestamp">[${timestamp}]</span>${message}`;
    
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

// Clear console
function clearConsole() {
    document.getElementById('console').innerHTML = '';
}

// Initialize Chart.js charts
function initializeCharts() {
    const chartConfig = {
        type: 'line',
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: {
                duration: 300
            },
            scales: {
                x: {
                    display: true,
                    title: {
                        display: true,
                        text: 'Time'
                    }
                },
                y: {
                    display: true,
                    beginAtZero: true
                }
            },
            plugins: {
                legend: {
                    display: false
                }
            }
        }
    };

    // Temperature chart
    tempChart = new Chart(document.getElementById('tempChart'), {
        ...chartConfig,
        data: {
            labels: [],
            datasets: [{
                label: 'Temperature (°C)',
                data: [],
                borderColor: 'rgb(231, 76, 60)',
                backgroundColor: 'rgba(231, 76, 60, 0.1)',
                tension: 0.4
            }]
        }
    });

    // Power chart
    powerChart = new Chart(document.getElementById('powerChart'), {
        ...chartConfig,
        data: {
            labels: [],
            datasets: [{
                label: 'Power (W)',
                data: [],
                borderColor: 'rgb(243, 156, 18)',
                backgroundColor: 'rgba(243, 156, 18, 0.1)',
                tension: 0.4
            }]
        }
    });

    // Memory chart
    memoryChart = new Chart(document.getElementById('memoryChart'), {
        ...chartConfig,
        data: {
            labels: [],
            datasets: [{
                label: 'Memory Used (MB)',
                data: [],
                borderColor: 'rgb(52, 152, 219)',
                backgroundColor: 'rgba(52, 152, 219, 0.1)',
                tension: 0.4
            }]
        }
    });
}

// Setup event listeners
function setupEventListeners() {
    document.getElementById('loadExperiments').addEventListener('click', loadExperiments);
    document.getElementById('experimentSelect').addEventListener('change', onExperimentSelect);
    document.getElementById('startMonitoring').addEventListener('click', startMonitoring);
    document.getElementById('stopMonitoring').addEventListener('click', stopMonitoring);
    document.getElementById('syncImages').addEventListener('click', syncImages);
    document.getElementById('viewImages').addEventListener('click', viewImages);
    document.getElementById('syncOutput').addEventListener('click', syncOutput);
    document.getElementById('viewOutput').addEventListener('click', viewOutput);
    document.getElementById('closeGallery').addEventListener('click', closeGallery);
    document.getElementById('closeOutput').addEventListener('click', closeOutput);
    document.getElementById('clearConsole').addEventListener('click', clearConsole);
}

// Load experiments from server
async function loadExperiments() {
    const btn = document.getElementById('loadExperiments');
    btn.disabled = true;
    btn.textContent = 'Loading...';

    try {
        const response = await fetch('/api/experiments');
        const data = await response.json();
        
        // Log command output
        if (data.command) {
            logToConsole(`$ ${data.command}`, 'info');
        }
        if (data.stdout) {
            logToConsole(data.stdout, 'success');
        }
        if (data.stderr) {
            logToConsole(data.stderr, 'error');
        }
        
        const select = document.getElementById('experimentSelect');
        select.innerHTML = '<option value="">Select an experiment...</option>';
        
        data.experiments.forEach(exp => {
            const option = document.createElement('option');
            option.value = exp;
            option.textContent = exp;
            select.appendChild(option);
        });
        
        select.disabled = false;
        logToConsole(`Found ${data.experiments.length} experiments`, 'success');
    } catch (error) {
        console.error('Error loading experiments:', error);
        logToConsole(`Error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Load Experiments';
    }
}

// Handle experiment selection
function onExperimentSelect(event) {
    selectedExperiment = event.target.value;
    const startBtn = document.getElementById('startMonitoring');
    startBtn.disabled = !selectedExperiment || isTensorboardMonitoring;
}

// Start monitoring
async function startMonitoring() {
    logToConsole('Starting monitoring...', 'info');
    
    try {
        const response = await fetch('/api/start-monitoring', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                experiment_path: selectedExperiment
            })
        });
        
        const data = await response.json();
        
        // Log output
        if (data.output) {
            logToConsole(data.output, data.status === 'error' ? 'error' : 'success');
        }
        
        if (data.status === 'started' || data.status === 'already_running') {
            isTensorboardMonitoring = true;
            updateMonitoringUI(true);
            startTensorboardPolling();
            logToConsole('TensorBoard monitoring active', 'success');
        } else if (data.status === 'error') {
            logToConsole(`Error: ${data.message}`, 'error');
        }
    } catch (error) {
        console.error('Error starting monitoring:', error);
        logToConsole(`Error: ${error.message}`, 'error');
    }
}

// Stop monitoring
async function stopMonitoring() {
    logToConsole('Stopping monitoring...', 'info');
    
    try {
        const response = await fetch('/api/stop-monitoring', {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.status === 'stopped') {
            isTensorboardMonitoring = false;
            updateMonitoringUI(false);
            stopTensorboardPolling();
            logToConsole('TensorBoard monitoring stopped', 'success');
        }
    } catch (error) {
        console.error('Error stopping monitoring:', error);
        logToConsole(`Error: ${error.message}`, 'error');
    }
}

// Update UI based on monitoring state
function updateMonitoringUI(monitoring) {
    const status = document.getElementById('monitoringStatus');
    const startBtn = document.getElementById('startMonitoring');
    const stopBtn = document.getElementById('stopMonitoring');
    const experimentSelect = document.getElementById('experimentSelect');
    
    if (monitoring) {
        status.textContent = 'Running';
        status.classList.add('active');
        startBtn.disabled = true;
        stopBtn.disabled = false;
        experimentSelect.disabled = true;
    } else {
        status.textContent = 'Stopped';
        status.classList.remove('active');
        startBtn.disabled = !selectedExperiment;
        stopBtn.disabled = true;
        experimentSelect.disabled = false;
    }
}

// Start GPU monitoring (always running)
function startGPUMonitoring() {
    // Poll GPU data every 5 seconds
    gpuMonitoringInterval = setInterval(async () => {
        await updateNvidiaSmiData();
    }, 5000);
    
    // Initial fetch
    updateNvidiaSmiData();
    logToConsole('GPU monitoring started (always active)', 'success');
}

// Start TensorBoard polling
function startTensorboardPolling() {
    if (selectedExperiment) {
        // Poll tensorboard data every 5 seconds
        tensorboardMonitoringInterval = setInterval(async () => {
            await updateTensorboardData();
        }, 5000);
        
        // Initial fetch
        updateTensorboardData();
    }
}

// Stop TensorBoard polling
function stopTensorboardPolling() {
    if (tensorboardMonitoringInterval) {
        clearInterval(tensorboardMonitoringInterval);
        tensorboardMonitoringInterval = null;
    }
}

// Update nvidia-smi data
async function updateNvidiaSmiData() {
    try {
        const response = await fetch('/api/nvidia-smi');
        const data = await response.json();
        
        // Log command output
        if (data.raw_output) {
            // logToConsole(`$ ${data.command}`, 'info');
            // logToConsole(data.raw_output.trim(), 'success');
        }
        
        if (data.timestamps && data.timestamps.length > 0) {
            const labels = data.timestamps.map(ts => new Date(ts).toLocaleTimeString());
            
            // Update temperature chart
            tempChart.data.labels = labels;
            tempChart.data.datasets[0].data = data.temperature;
            tempChart.update('none');
            
            // Update power chart
            powerChart.data.labels = labels;
            powerChart.data.datasets[0].data = data.power;
            powerChart.update('none');
            
            // Update memory chart
            memoryChart.data.labels = labels;
            memoryChart.data.datasets[0].data = data.memory_used;
            memoryChart.update('none');
        }
    } catch (error) {
        console.error('Error updating nvidia-smi data:', error);
        logToConsole(`Error fetching GPU data: ${error.message}`, 'error');
    }
}

// Update board data
async function updateTensorboardData() {
    try {
        const response = await fetch(`/api/tensorboard/${encodeURIComponent(selectedExperiment)}`);
        const data = await response.json();
        
        if (Object.keys(data).length > 0) {
            document.getElementById('tensorboardSection').style.display = 'block';
            renderTensorboardCharts(data);
        }
    } catch (error) {
        console.error('Error updating tensorboard data:', error);
        logToConsole(`Error fetching TensorBoard data: ${error.message}`, 'error');
    }
}

// Render tensorboard charts
function renderTensorboardCharts(data) {
    const container = document.getElementById('tensorboardCharts');
    
    Object.keys(data).forEach(tag => {
        const chartId = `tb-chart-${tag.replace(/[^a-zA-Z0-9]/g, '-')}`;
        
        // Create chart container if it doesn't exist
        if (!document.getElementById(chartId)) {
            const chartDiv = document.createElement('div');
            chartDiv.className = 'tensorboard-chart';
            chartDiv.innerHTML = `
                <h3>${tag}</h3>
                <canvas id="${chartId}"></canvas>
            `;
            container.appendChild(chartDiv);
            
            // Create new chart
            const ctx = document.getElementById(chartId);
            tensorboardCharts[tag] = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: data[tag].steps,
                    datasets: [{
                        label: tag,
                        data: data[tag].values,
                        borderColor: getColorForTag(tag),
                        backgroundColor: 'rgba(0, 0, 0, 0.1)',
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    scales: {
                        x: {
                            title: {
                                display: true,
                                text: 'Step'
                            }
                        },
                        y: {
                            title: {
                                display: true,
                                text: 'Value'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        }
                    }
                }
            });
        } else {
            // Update existing chart
            const chart = tensorboardCharts[tag];
            chart.data.labels = data[tag].steps;
            chart.data.datasets[0].data = data[tag].values;
            chart.update('none');
        }
    });
}

// Sync images from remote
async function syncImages() {
    const btn = document.getElementById('syncImages');
    btn.disabled = true;
    btn.textContent = 'Syncing...';
    
    logToConsole('Starting rsync to fetch images...', 'info');
    
    try {
        const response = await fetch('/api/sync-images', {
            method: 'POST'
        });
        const data = await response.json();
        
        // Log rsync output
        if (data.output) {
            logToConsole(data.output, data.status === 'error' ? 'error' : 'success');
        }
        
        if (data.status === 'success') {
            logToConsole(`Successfully synced ${data.images.length} images`, 'success');
            document.getElementById('viewImages').disabled = false;
        } else {
            logToConsole(`Rsync error: ${data.message}`, 'error');
        }
    } catch (error) {
        console.error('Error syncing images:', error);
        logToConsole(`Error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sync Images';
    }
}

// Parse step number from filename
function parseStepFromFilename(filename) {
    // Extract step number from format: "...garbage...000100_00_20251101103829_1.png"
    // Search from the end: find pattern like _NNNNNN_NN_timestamp_N.ext
    // The step number is the last sequence of 6 digits before the file extension
    const nameWithoutExt = filename.replace(/\.[^.]+$/, ''); // Remove extension
    const match = nameWithoutExt.match(/_(\d{6})_\d{2}_\d+_\d+$/);
    return match ? parseInt(match[1], 10) : null;
}

// Group images by step
function groupImagesByStep(images) {
    const grouped = {};
    
    images.forEach(imagePath => {
        const filename = imagePath.split('/').pop();
        const step = parseStepFromFilename(filename);
        
        if (step !== null) {
            if (!grouped[step]) {
                grouped[step] = [];
            }
            grouped[step].push(imagePath);
        }
    });
    
    return grouped;
}

// Extract timestamp from filename
function extractTimestamp(filename) {
    // Extract timestamp from format: "...000100_00_20251101103829_1.png"
    const match = filename.match(/_(\d{14})_\d+\.[^.]+$/);
    return match ? match[1] : '00000000000000';
}

// Display images for a specific step
function displayImagesForStep(step, images, batchNumber = 1) {
    const imageGrid = document.getElementById('imageGrid');
    imageGrid.innerHTML = '';
    
    // Sort images by timestamp (date)
    const sortedImages = images.slice().sort((a, b) => {
        const filenameA = a.split('/').pop();
        const filenameB = b.split('/').pop();
        const timestampA = extractTimestamp(filenameA);
        const timestampB = extractTimestamp(filenameB);
        return timestampA.localeCompare(timestampB);
    });
    
    // Calculate batch indices
    const batchSize = 3;
    const startIndex = (batchNumber - 1) * batchSize;
    const endIndex = startIndex + batchSize;
    const batchImages = sortedImages.slice(startIndex, endIndex);
    
    batchImages.forEach(imagePath => {
        const imageItem = document.createElement('div');
        imageItem.className = 'image-item';
        imageItem.innerHTML = `
            <img src="/images/${imagePath}" alt="${imagePath}">
            <div class="image-name">${imagePath.split('/').pop()}</div>
        `;
        imageGrid.appendChild(imageItem);
    });
}

// View images
async function viewImages() {
    
    try {
        const response = await fetch('/api/images');
        const data = await response.json();
        
        // Group images by step
        const groupedImages = groupImagesByStep(data.images);
        const steps = Object.keys(groupedImages).map(Number).sort((a, b) => a - b);
        
        // Create step list
        const stepList = document.getElementById('stepList');
        stepList.innerHTML = '';
        
        steps.forEach(step => {
            const stepItem = document.createElement('div');
            stepItem.className = 'step-item';
            
            const imageCount = groupedImages[step].length;
            const batchCount = Math.ceil(imageCount / 3);
            
            // Create step label
            const stepLabel = document.createElement('div');
            stepLabel.className = 'step-label';
            stepLabel.textContent = `Step ${step} (${imageCount})`;
            stepLabel.onclick = () => {
                // Remove active class from all steps
                document.querySelectorAll('.step-item').forEach(item => {
                    item.classList.remove('active');
                });
                // Add active class to clicked step
                stepItem.classList.add('active');
                // Display images for this step (batch 1 by default)
                displayImagesForStep(step, groupedImages[step], 1);
                // Highlight first batch button
                const batchButtons = stepItem.querySelectorAll('.batch-btn');
                batchButtons.forEach(btn => btn.classList.remove('active'));
                if (batchButtons.length > 0) {
                    batchButtons[0].classList.add('active');
                }
            };
            stepItem.appendChild(stepLabel);
            
            // Add batch buttons if more than 3 images
            if (imageCount > 3) {
                const batchContainer = document.createElement('div');
                batchContainer.className = 'batch-container';
                
                for (let i = 1; i <= batchCount; i++) {
                    const batchBtn = document.createElement('button');
                    batchBtn.className = 'batch-btn';
                    if (i === 1) batchBtn.classList.add('active');
                    batchBtn.textContent = i;
                    batchBtn.onclick = (e) => {
                        e.stopPropagation();
                        // Remove active class from all steps
                        document.querySelectorAll('.step-item').forEach(item => {
                            item.classList.remove('active');
                        });
                        // Add active class to this step
                        stepItem.classList.add('active');
                        // Remove active class from all batch buttons in this step
                        stepItem.querySelectorAll('.batch-btn').forEach(btn => {
                            btn.classList.remove('active');
                        });
                        // Add active class to clicked batch button
                        batchBtn.classList.add('active');
                        // Display images for this batch
                        displayImagesForStep(step, groupedImages[step], i);
                    };
                    batchContainer.appendChild(batchBtn);
                }
                
                stepItem.appendChild(batchContainer);
            }
            
            stepList.appendChild(stepItem);
        });
        
        // Display first step by default
        if (steps.length > 0) {
            const firstStep = steps[0];
            stepList.firstChild.classList.add('active');
            displayImagesForStep(firstStep, groupedImages[firstStep], 1);
        }
        
        document.getElementById('imageGallery').style.display = 'block';
    } catch (error) {
        console.error('Error loading images:', error);
        logToConsole(`Error: ${error.message}`, 'error');
    }
}

// Close image gallery
function closeGallery() {
    document.getElementById('imageGallery').style.display = 'none';
}

// Close output viewer
function closeOutput() {
    document.getElementById('outputViewer').style.display = 'none';
}

// Sync output from remote
async function syncOutput() {
    const btn = document.getElementById('syncOutput');
    btn.disabled = true;
    btn.textContent = 'Syncing...';
    
    logToConsole('Starting rsync to fetch output...', 'info');
    
    try {
        const response = await fetch('/api/sync-output', {
            method: 'POST'
        });
        const data = await response.json();
        
        // Log rsync output
        if (data.output) {
            logToConsole(data.output, data.status === 'error' ? 'error' : 'success');
        }
        
        if (data.status === 'success') {
            logToConsole('Successfully synced output file', 'success');
            document.getElementById('viewOutput').disabled = false;
        } else {
            logToConsole(`Rsync error: ${data.message}`, 'error');
        }
    } catch (error) {
        console.error('Error syncing output:', error);
        logToConsole(`Error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sync Output';
    }
}

// View output
async function viewOutput() {
    try {
        const response = await fetch('/api/output');
        const data = await response.json();
        
        if (data.status === 'success') {
            // Display output in modal
            const outputText = document.getElementById('outputText');
            outputText.textContent = data.content;
            document.getElementById('outputViewer').style.display = 'block';
            logToConsole('Output file loaded in viewer', 'success');
        } else {
            logToConsole(`Error: ${data.message}`, 'error');
        }
    } catch (error) {
        console.error('Error loading output:', error);
        logToConsole(`Error: ${error.message}`, 'error');
    }
}

// Simple hash function to generate consistent seed from string
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

// Generate consistent color for charts based on tag name
function getColorForTag(tag) {
    const colors = [
        'rgb(231, 76, 60)',      // Red
        'rgb(46, 204, 113)',     // Green
        'rgb(52, 152, 219)',     // Blue
        'rgb(243, 156, 18)',     // Orange
        'rgb(155, 89, 182)',     // Purple
        'rgb(241, 196, 15)',     // Yellow
        'rgb(230, 126, 34)',     // Dark Orange
        'rgb(149, 165, 166)'     // Gray
    ];
    
    // Use hash of tag name to consistently select a color
    const hash = hashString(tag);
    const colorIndex = hash % colors.length;
    return colors[colorIndex];
}
