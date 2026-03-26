// State Management
let isTracking = false;
let watchId = null;
let totalDistance = 0; // in meters
let segmentDistance = 0; // in meters
let totalOverallDistance = 0; // tracking how much we completed for voice updates
let lastPosition = null;

// Map Management
let map = null;
let pathLine = null;
let currentMarker = null;

function initMap(lat, lon) {
    if (!map) {
        map = L.map('map', { zoomControl: false }).setView([lat, lon], 17);

        // CartoDB Dark Matter tile layer for a premium dark mode look
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OSM &copy; CARTO',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(map);

        pathLine = L.polyline([], { color: '#38BDF8', weight: 5, opacity: 0.9, smoothFactor: 1 }).addTo(map);

        const customIcon = L.divIcon({
            className: 'custom-map-marker',
            html: '<div class="marker-dot"></div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        currentMarker = L.marker([lat, lon], { icon: customIcon }).addTo(map);
    } else {
        map.setView([lat, lon]);
        currentMarker.setLatLng([lat, lon]);
    }
}

// DOM Elements
const startBtn = document.getElementById('start-btn');
const resetBtn = document.getElementById('reset-btn');
const totalDistDisplay = document.getElementById('total-distance');
const currentSpeedDisplay = document.getElementById('current-speed');
const segmentDistDisplay = document.getElementById('segment-distance');
const segmentProgress = document.getElementById('segment-progress');
const statusIndicator = document.getElementById('status-indicator');
const geoInfo = document.getElementById('geo-info');
const beepSound = document.getElementById('beep-sound');

// NEW DOM Elements
const voiceToggle = document.getElementById('voice-toggle');
const historyList = document.getElementById('history-list');
const clearHistoryBtn = document.getElementById('clear-history-btn');

// Constants
const SEGMENT_THRESHOLD = 100; // 100 meters

// --- HISTORY & VOICE UTILS ---
function loadHistory() {
    const history = JSON.parse(localStorage.getItem('meterHistory')) || [];
    renderHistory(history);
}

function saveHistory(msg) {
    const history = JSON.parse(localStorage.getItem('meterHistory')) || [];
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    history.unshift({ time, msg });

    // Keep only last 20 records
    if (history.length > 20) history.pop();

    localStorage.setItem('meterHistory', JSON.stringify(history));
    renderHistory(history);
}

function renderHistory(history) {
    if (!history || history.length === 0) {
        historyList.innerHTML = '<li class="empty-history">No history yet. Start moving!</li>';
        return;
    }
    historyList.innerHTML = history.map(item => `
        <li class="history-item">
            <span>${item.msg}</span>
            <span class="time">${item.time}</span>
        </li>
    `).join('');
}

function clearHistory() {
    if (confirm("Clear all trip history?")) {
        localStorage.removeItem('meterHistory');
        renderHistory([]);
    }
}

function speak(text) {
    if (voiceToggle.checked && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel(); // Cancel any ongoing speech
        let utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        window.speechSynthesis.speak(utterance);
    }
}

// --- UTILS ---

/**
 * Calculates distance between two GPS coordinates in meters using Haversine formula
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

function updateDisplays() {
    // Total distance in KM (fixed to 2 decimals)
    totalDistDisplay.textContent = (totalDistance / 1000).toFixed(2);

    // Segment distance in meters
    segmentDistDisplay.textContent = Math.floor(segmentDistance);

    // Progress bar (0-100%)
    const progress = (segmentDistance / SEGMENT_THRESHOLD) * 100;
    segmentProgress.style.width = `${Math.min(progress, 100)}%`;

    // Check for 100m completion
    if (segmentDistance >= SEGMENT_THRESHOLD) {
        onSegmentComplete();
    }
}

function onSegmentComplete() {
    // Alert the user
    beepSound.play().catch(e => console.log('Audio playback prevented by browser policy.'));

    // Voice and History Logging
    totalOverallDistance += SEGMENT_THRESHOLD;
    const msg = `Reached ${totalOverallDistance} meters`;
    saveHistory(msg);
    speak(msg);

    // Visual Pulse Effect
    document.querySelector('.app-container').style.background = 'rgba(244, 114, 182, 0.2)';
    setTimeout(() => {
        document.querySelector('.app-container').style.background = 'var(--bg-dark)';
    }, 500);

    // Reset segment (keep the remainder for accuracy)
    segmentDistance %= SEGMENT_THRESHOLD;
    updateDisplays();
}

function handlePosition(position) {
    const { latitude, longitude, speed, accuracy } = position.coords;
    const timestamp = position.timestamp;

    // Initialize or update map
    initMap(latitude, longitude);

    // Update status
    statusIndicator.className = 'status online';
    statusIndicator.textContent = 'TRACKING';
    geoInfo.textContent = `Accuracy: ±${Math.round(accuracy)}m`;

    // Speed display (convert m/s to km/h)
    const currentSpeed = speed ? (speed * 3.6) : 0;
    currentSpeedDisplay.textContent = currentSpeed.toFixed(1);

    // Skip points with extremely poor accuracy to prevent huge jumps
    if (accuracy > 40) return;

    if (lastPosition) {
        const delta = calculateDistance(
            lastPosition.latitude, lastPosition.longitude,
            latitude, longitude
        );

        // Time elapsed in seconds
        const timeElapsed = (timestamp - lastPosition.timestamp) / 1000;

        // Calculate speed in m/s based on coordinates if native speed is not available
        const calcSpeed = timeElapsed > 0 ? (delta / timeElapsed) : 0;
        const activeSpeedMps = speed !== null ? speed : calcSpeed;
        const activeSpeedKmh = activeSpeedMps * 3.6;

        // --- GOOGLE MAPS STYLE FILTERING ---
        // 1. Ignore very small jumps (stationary GPS drift)
        // 2. Allow large jumps for vehicle speeds

        const minDistanceToCount = Math.max(10, accuracy * 0.5); // At least 10m movement required to register when slow

        // We accept the movement if it's substantial, OR if we are clearly moving fast
        if (delta > minDistanceToCount || activeSpeedKmh > 3.0) {

            // Limit max acceptable speed to ~200 km/h (55 m/s) to filter random GPS spikes
            if (activeSpeedKmh < 200 && delta < 2000) {
                totalDistance += delta;
                segmentDistance += delta;
                updateDisplays();

                // Add to path on map
                if (pathLine && isTracking) {
                    pathLine.addLatLng([latitude, longitude]);
                }

                // Only update lastPosition if we successfully registered the movement.
                // This correctly accumulates small slow steps until they cross the threshold!
                lastPosition = { latitude, longitude, timestamp };
            }
        }
    } else {
        lastPosition = { latitude, longitude, timestamp };
        // Initial point on map
        if (pathLine && isTracking) {
            pathLine.addLatLng([latitude, longitude]);
        }
    }
}

function handleError(error) {
    console.error('Geo Error:', error);
    let msg = 'Unknown Error';
    switch (error.code) {
        case error.PERMISSION_DENIED: msg = "Location Access Denied"; break;
        case error.POSITION_UNAVAILABLE: msg = "Location Unavailable"; break;
        case error.TIMEOUT: msg = "Request Timeout"; break;
    }
    geoInfo.textContent = msg;
    statusIndicator.className = 'status offline';
    statusIndicator.textContent = 'GPS ERROR';
}

function toggleTracking() {
    if (isTracking) {
        // Stop
        navigator.geolocation.clearWatch(watchId);
        isTracking = false;
        lastPosition = null; // Prevent jumping distance when paused
        startBtn.textContent = 'START TRACKING';
        startBtn.classList.remove('stop');
        statusIndicator.className = 'status offline';
        statusIndicator.textContent = 'PAUSED';
    } else {
        // Start
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser");
            return;
        }

        // Initialize audio context for Chrome policy
        beepSound.play().then(() => beepSound.pause());

        isTracking = true;
        startBtn.textContent = 'STOP TRACKING';
        startBtn.classList.add('stop');

        watchId = navigator.geolocation.watchPosition(handlePosition, handleError, {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 0
        });
    }
}

function resetAll() {
    if (confirm("Reset all tracked data?")) {
        totalDistance = 0;
        segmentDistance = 0;
        totalOverallDistance = 0;
        lastPosition = null;
        updateDisplays();
        currentSpeedDisplay.textContent = "0.0";
        if (pathLine) {
            pathLine.setLatLngs([]);
            if (currentMarker) {
                pathLine.addLatLng(currentMarker.getLatLng());
            }
        }
        saveHistory('Counter reset');
    }
}

// Event Listeners
startBtn.addEventListener('click', toggleTracking);
resetBtn.addEventListener('click', resetAll);
clearHistoryBtn.addEventListener('click', clearHistory);

// Initialize History
loadHistory();

// Handle Online/Offline Status for PWA
window.addEventListener('online', () => {
    statusIndicator.classList.remove('offline');
    statusIndicator.classList.add('online');
    if (!isTracking) statusIndicator.textContent = 'READY';
});

window.addEventListener('offline', () => {
    statusIndicator.className = 'status offline';
    statusIndicator.textContent = 'OFFLINE MODE';
});

// Get initial location just to display the map
if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
        (position) => {
            initMap(position.coords.latitude, position.coords.longitude);
            geoInfo.textContent = "GPS Ready";
        },
        (error) => {
            console.log("Initial GPS Error", error);
            geoInfo.textContent = "Click Start to enable GPS";
        },
        { enableHighAccuracy: true }
    );
}
