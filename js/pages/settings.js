// Settings management for Game Behaviour and other tabs

// =========================
// Settings Manager
// =========================

class SettingsManager {
    constructor() {
        this.settings = this.loadSettings();
        this.init();
    }

    // =========================
    // Initialization
    // =========================

    // Initialize the settings page
    init() {
        this.setupTabNavigation();
        this.loadCheckboxStates();
        this.setupEventListeners();
    }

    // =========================
    // Settings Data
    // =========================

    // Load settings from localStorage
    loadSettings() {
        const saved = localStorage.getItem('gameSettings');
        const defaultSettings = this.getDefaultSettings();
    
        if (saved) {
            return {
                ...defaultSettings,
                ...JSON.parse(saved)
            };
        }
    
        return defaultSettings;
    }
    
    // Get default settings
    getDefaultSettings() {
        return {
            autoDraw: false,
            autoSkipBlock: false,
            autoSkipTrigger: false,
            autoSelectMaxValue: false,
            confirmEndTurn: true,
            confirmCounter: true,
            confirmTrigger: true,
    
            soundEffects: true,
            audioEnabled: true
        };
    }

    // Save settings to localStorage
    saveSettings() {
        localStorage.setItem('gameSettings', JSON.stringify(this.settings));
        this.showSaveNotification();
    }

    // Get current settings
    getSettings() {
        return this.settings;
    }

    // Get specific setting
    getSetting(key) {
        return this.settings[key] || null;
    }

    // Update specific setting
    updateSetting(key, value) {
        if (this.settings.hasOwnProperty(key)) {
            this.settings[key] = value;
            const checkbox = document.getElementById(key);
            if (checkbox) {
                checkbox.checked = value;
            }
        }
    }

    // Reset all settings to default
    resetToDefaults() {
        if (confirm('Are you sure you want to reset all settings to default?')) {
            this.settings = this.getDefaultSettings();
            this.loadCheckboxStates();
            this.saveSettings();
        }
    }

    // =========================
    // Tab Navigation
    // =========================

    // Setup tab navigation functionality
    setupTabNavigation() {
        const tabButtons = document.querySelectorAll('.tab-button');
        const tabContents = document.querySelectorAll('.tab-content');

        tabButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const tabName = button.getAttribute('data-tab');
                
                // Remove active class from all buttons and contents
                tabButtons.forEach(btn => btn.classList.remove('active'));
                tabContents.forEach(content => content.classList.remove('active'));
                
                // Add active class to clicked button and corresponding content
                button.classList.add('active');
                document.getElementById(tabName).classList.add('active');
            });
        });
    }

    // =========================
    // Checkbox State
    // =========================

    // Load checkbox states from saved settings
    loadCheckboxStates() {
        const checkboxes = document.querySelectorAll('.setting-checkbox');
        
        checkboxes.forEach(checkbox => {
            const setting = checkbox.getAttribute('data-setting');
            if (this.settings.hasOwnProperty(setting)) {
                checkbox.checked = this.settings[setting];
            }
        });
    }

    // =========================
    // Event Listeners
    // =========================

    // Setup event listeners for checkboxes and save button
    setupEventListeners() {
        const checkboxes = document.querySelectorAll('.setting-checkbox');
        const saveButton = document.getElementById('saveButton');

        // Update settings when checkbox is changed
        checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const setting = e.target.getAttribute('data-setting');
                this.settings[setting] = e.target.checked;
            });
        });

        // Save settings when save button is clicked
        saveButton.addEventListener('click', () => {
            this.saveSettings();
        });
    }

    // =========================
    // Save Feedback
    // =========================

    // Show save notification feedback
    showSaveNotification() {
        const saveButton = document.getElementById('saveButton');
        const originalText = saveButton.textContent;
        
        // Change button text to indicate save
        saveButton.textContent = '✓ Settings Saved!';
        saveButton.style.background = 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)';
        
        // Revert after 2 seconds
        setTimeout(() => {
            saveButton.textContent = originalText;
            saveButton.style.background = '';
        }, 2000);
    }
}

// =========================
// Page Load
// =========================

// Initialize settings manager when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new SettingsManager();
});