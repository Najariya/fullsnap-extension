document.addEventListener('DOMContentLoaded', async () => {
  // OS-aware shortcut display (manifest defines Cmd+Shift on Mac, Ctrl+Shift elsewhere)
  const isMac = navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Mac');
  const sfEl = document.getElementById('shortcut-full');
  const svEl = document.getElementById('shortcut-visible');
  if (sfEl) sfEl.textContent = isMac ? '⌘⇧S' : 'Ctrl+Shift+S';
  if (svEl) svEl.textContent = isMac ? '⌘⇧V' : 'Ctrl+Shift+V';

  // Elements
  const btnFullPage = document.getElementById('btn-full-page');
  const btnVisible = document.getElementById('btn-visible');
  const btnSettings = document.getElementById('btn-settings');
  const settingsPanel = document.getElementById('settings-panel');
  const settingFormat = document.getElementById('setting-format');
  const settingQuality = document.getElementById('setting-quality');
  const qualityValue = document.getElementById('quality-value');
  const jpegQualityRow = document.getElementById('jpeg-quality-row');
  const settingTheme = document.getElementById('setting-theme');
  const statusEl = document.getElementById('status');

  // Load settings
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = stored[STORAGE_KEYS.SETTINGS] || { ...DEFAULTS };

  // Apply settings to UI
  settingFormat.value = settings.format || 'png';
  settingQuality.value = settings.jpegQuality || 90;
  qualityValue.textContent = (settings.jpegQuality || 90) + '%';
  settingTheme.value = settings.theme || 'system';
  jpegQualityRow.style.display = settings.format === 'jpeg' ? 'flex' : 'none';

  // Apply theme
  applyTheme(settings.theme || 'system');

  // Capture buttons
  btnFullPage.addEventListener('click', () => startCapture('full'));
  btnVisible.addEventListener('click', () => startCapture('visible'));

  // Settings toggle
  btnSettings.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  // Settings changes
  settingFormat.addEventListener('change', () => {
    settings.format = settingFormat.value;
    jpegQualityRow.style.display = settings.format === 'jpeg' ? 'flex' : 'none';
    saveSettings(settings);
  });

  settingQuality.addEventListener('input', () => {
    settings.jpegQuality = parseInt(settingQuality.value);
    qualityValue.textContent = settingQuality.value + '%';
    saveSettings(settings);
  });

  settingTheme.addEventListener('change', () => {
    settings.theme = settingTheme.value;
    applyTheme(settings.theme);
    saveSettings(settings);
  });

  // Listen for progress updates
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === MSG.CAPTURE_PROGRESS) {
      const progress = Math.round(message.progress * 100);
      showStatus(`Capturing... ${progress}%`, 'capturing');
    }
  });

  async function startCapture(mode) {
    // Disable buttons during capture
    btnFullPage.disabled = true;
    btnVisible.disabled = true;
    showStatus('Starting capture...', 'capturing');

    try {
      const TIMEOUT_MS = mode === 'full' ? 60000 : 30000; // 60s for full, 30s for visible

      const messagePromise = chrome.runtime.sendMessage({
        action: mode === 'full' ? MSG.CAPTURE_FULL_PAGE : MSG.CAPTURE_VISIBLE,
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Capture timeout - please try again')), TIMEOUT_MS)
      );

      const response = await Promise.race([messagePromise, timeoutPromise]);

      if (response && response.error) {
        showStatus(response.error, 'error');
        btnFullPage.disabled = false;
        btnVisible.disabled = false;
      } else {
        // Close popup after successful capture
        window.close();
      }
    } catch (err) {
      showStatus(err.message || 'Capture failed. Try again.', 'error');
      btnFullPage.disabled = false;
      btnVisible.disabled = false;
    }
  }

  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
  }

  function applyTheme(theme) {
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  async function saveSettings(settings) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  }
});
