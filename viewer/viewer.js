// FullSnap Viewer - Multipart screenshot preview, annotation, and export.

(function () {
  const container = document.getElementById('canvas-container');
  const wrapper = document.getElementById('canvas-wrapper');
  const screenshotCanvas = document.getElementById('screenshot-canvas');
  const annotationCanvas = document.getElementById('annotation-canvas');
  const loadingEl = document.getElementById('loading');
  const toastEl = document.getElementById('toast');

  const statusDimensions = document.getElementById('status-dimensions');
  const statusSize = document.getElementById('status-size');
  const statusZoom = document.getElementById('status-zoom');

  const bannerEl = document.getElementById('capture-info-banner');
  const partControlsEl = document.getElementById('part-controls');
  const btnPartPrev = document.getElementById('btn-part-prev');
  const btnPartNext = document.getElementById('btn-part-next');
  const partIndicator = document.getElementById('part-indicator');

  const zoomDisplay = document.getElementById('zoom-display');

  let zoom = 1;
  let imgWidth = 0;
  let imgHeight = 0;
  let currentSegmentBytes = 0;
  let annotation = null;

  let captureId = null;
  let captureMeta = null;
  let segmentCount = 1;
  let currentSegmentIndex = 0;

  let activeTool = null;
  let toastTimeout = null;

  // Settings (loaded from storage)
  let settings = {
    showTimestamp: true,
    showUrl: true,
    theme: 'system',
  };

  // Filters state
  let filters = {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    grayscale: false,
    sepia: false,
  };

  window.addEventListener('error', (e) => {
    console.error('[Viewer] UNCAUGHT ERROR:', e.message, e.filename, e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[Viewer] UNHANDLED REJECTION:', e.reason);
  });

  console.log('[Viewer] Script loaded, calling init()...');
  init();

  async function init() {
    try {
      console.log('[Viewer] init() starting...');
      await loadSettings();
      await applyTheme();
      setupExportButtons();
      setupDialogs();
      setupZoomControls();
      setupThemeToggle();
      setupKeyboardShortcuts();
      setupAnnotationControls();
      setupPartControls();
      setupSettingsPanel();
      setupFiltersPanel();
      setupFeedbackBanner();
      updateShortcutDisplay();
      await loadInitialCapture();
      console.log('[Viewer] init() complete');
    } catch (err) {
      console.error('[Viewer] init() FAILED:', err);
      showError('Initialization error: ' + (err.message || err));
    }
  }

  // --- Settings ---

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
      const saved = stored[STORAGE_KEYS.SETTINGS] || {};
      settings = {
        showTimestamp: saved.showTimestamp !== undefined ? saved.showTimestamp : true,
        showUrl: saved.showUrl !== undefined ? saved.showUrl : true,
        theme: saved.theme || 'system',
      };
    } catch (err) {
      console.warn('[Viewer] Failed to load settings:', err);
    }

    // Sync checkboxes with loaded settings
    const tsCheckbox = document.getElementById('show-timestamp-checkbox');
    const urlCheckbox = document.getElementById('show-url-checkbox');
    if (tsCheckbox) tsCheckbox.checked = settings.showTimestamp;
    if (urlCheckbox) urlCheckbox.checked = settings.showUrl;
  }

  async function saveSettings() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
      const existing = stored[STORAGE_KEYS.SETTINGS] || {};
      const merged = { ...existing, ...settings };
      await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
    } catch (err) {
      console.warn('[Viewer] Failed to save settings:', err);
    }
  }

  // --- Load screenshot ---

  async function loadInitialCapture() {
    try {
      setLoadingText('Loading screenshot...');

      console.log('[Viewer] Requesting pending capture...');
      const pending = await chrome.runtime.sendMessage({ action: MSG.GET_PENDING_CAPTURE });
      console.log('[Viewer] Pending response:', JSON.stringify(pending));

      if (pending?.error || !pending?.captureId) {
        console.error('[Viewer] No pending capture:', pending);
        showError('No screenshot found. Please capture a screenshot first.');
        return;
      }

      captureId = pending.captureId;
      console.log('[Viewer] captureId:', captureId);

      const metaResponse = await chrome.runtime.sendMessage({
        action: MSG.GET_CAPTURE_META,
        captureId,
      });
      console.log('[Viewer] Meta response:', JSON.stringify(metaResponse));

      if (metaResponse?.error || !metaResponse?.meta) {
        console.error('[Viewer] Meta error:', metaResponse);
        showError(metaResponse?.error || 'Failed to load capture metadata.');
        return;
      }

      captureMeta = metaResponse.meta;
      segmentCount = Math.max(1, captureMeta.segmentCount || 1);
      currentSegmentIndex = 0;
      console.log('[Viewer] Segments:', segmentCount, 'Meta:', JSON.stringify({
        url: captureMeta.url,
        width: captureMeta.width,
        totalHeight: captureMeta.totalHeight,
        dpr: captureMeta.devicePixelRatio,
      }));

      updateBanner();
      updatePartControls();

      console.log('[Viewer] Loading segment 0...');
      await loadSegment(currentSegmentIndex);

      document.title = `FullSnap - ${captureMeta.title || 'Screenshot'}`;
      loadingEl.classList.add('hidden');
      console.log('[Viewer] Screenshot loaded and visible');
    } catch (err) {
      console.error('[Viewer] loadInitialCapture FAILED:', err);
      showError('Error loading screenshot: ' + (err.message || err));
    }
  }

  async function loadSegment(index) {
    if (!captureId) {
      throw new Error('Capture ID is missing');
    }

    if (index < 0 || index >= segmentCount) {
      throw new Error('Segment index is out of bounds');
    }

    setLoadingText(`Loading part ${index + 1} of ${segmentCount}...`);
    loadingEl.classList.remove('hidden');

    let img = null;
    let blobSize = 0;

    // Strategy 1: Try reading directly from IndexedDB (fastest, no serialization)
    try {
      console.log(`[Viewer] loadSegment(${index}) - trying IndexedDB direct read...`);
      const segment = await CaptureStore.getCaptureSegment(captureId, index);

      if (segment && segment.blob && segment.blob.size > 0) {
        console.log(`[Viewer] IndexedDB segment found: blob=${formatBytes(segment.blob.size)}, ${segment.width}x${segment.height}`);
        blobSize = segment.blob.size;
        const objectUrl = URL.createObjectURL(segment.blob);
        try {
          img = await loadImage(objectUrl);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
        console.log(`[Viewer] IndexedDB image loaded: ${img.naturalWidth}x${img.naturalHeight}`);
      } else {
        console.warn(`[Viewer] IndexedDB returned segment but blob is missing/empty:`, segment ? { hasBlob: !!segment.blob, size: segment.blob?.size } : 'null');
      }
    } catch (err) {
      console.warn(`[Viewer] IndexedDB direct read failed:`, err.message);
    }

    // Strategy 2: Fallback - ask service worker for dataUrl
    if (!img) {
      console.log(`[Viewer] Falling back to service worker GET_CAPTURE_SEGMENT...`);
      const response = await chrome.runtime.sendMessage({
        action: MSG.GET_CAPTURE_SEGMENT,
        captureId,
        index,
      });

      if (response?.error) {
        throw new Error(`Failed to load segment ${index + 1}: ${response.error}`);
      }

      if (!response?.dataUrl) {
        throw new Error(`Failed to load segment ${index + 1}: no data returned`);
      }

      console.log(`[Viewer] Service worker returned dataUrl (${formatBytes(response.dataUrl.length)}), ${response.width}x${response.height}`);
      blobSize = response.dataUrl.length;
      img = await loadImage(response.dataUrl);
      console.log(`[Viewer] Fallback image loaded: ${img.naturalWidth}x${img.naturalHeight}`);
    }

    // Validate image
    if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new Error(`Segment ${index + 1} loaded but image has zero dimensions`);
    }

    currentSegmentIndex = index;
    currentSegmentBytes = blobSize;
    imgWidth = img.naturalWidth;
    imgHeight = img.naturalHeight;

    // Set canvas dimensions
    screenshotCanvas.width = imgWidth;
    screenshotCanvas.height = imgHeight;
    annotationCanvas.width = imgWidth;
    annotationCanvas.height = imgHeight;

    // Draw image to canvas
    const baseCtx = screenshotCanvas.getContext('2d');
    baseCtx.clearRect(0, 0, imgWidth, imgHeight);
    baseCtx.drawImage(img, 0, 0);

    // Apply current CSS filters
    applyCanvasFilters();

    console.log(`[Viewer] Canvas drawn: ${screenshotCanvas.width}x${screenshotCanvas.height}`);

    // Set up annotation engine (destroy previous instance to avoid stacking DOM elements)
    if (annotation) {
      annotation.destroy();
    }
    annotation = new AnnotationEngine(annotationCanvas, screenshotCanvas);
    restoreActiveTool();

    updateStatusBar();
    updatePartControls();
    updateViewerMetaBar();

    if (index === 0) {
      fitToWindow();
      console.log(`[Viewer] fitToWindow applied, zoom: ${zoom}`);
    }

    loadingEl.classList.add('hidden');
    console.log(`[Viewer] Segment ${index} loaded successfully`);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const timeoutId = setTimeout(() => {
        img.onload = null;
        img.onerror = null;
        reject(new Error('Image load timed out after 30s'));
      }, 30000);

      img.onload = () => {
        clearTimeout(timeoutId);
        console.log(`[Viewer] Image decoded: ${img.naturalWidth}x${img.naturalHeight}`);
        resolve(img);
      };
      img.onerror = (e) => {
        clearTimeout(timeoutId);
        console.error('[Viewer] Image decode FAILED:', e);
        reject(new Error('Failed to decode image'));
      };
      img.src = src;
    });
  }

  // --- Zoom ---

  // Returns the zoom level that fits the image to the current container.
  // Mirrors fitToWindow() logic but returns the value without applying it.
  function getFitZoom() {
    if (!imgWidth || !imgHeight) return 1;
    const containerRect = container.getBoundingClientRect();
    const availW = Math.max(1, containerRect.width - 40);
    const availH = Math.max(1, containerRect.height - 40);
    return Math.min(availW / imgWidth, availH / imgHeight, 1);
  }

  function setZoom(newZoom) {
    zoom = Math.max(0.1, Math.min(5, newZoom));
    wrapper.style.transform = `scale(${zoom})`;

    // Toggle CSS class used for zoom-in / zoom-out cursor
    const fitZ = getFitZoom();
    container.classList.toggle('zoomed-in', zoom > fitZ + 0.01);

    const zoomText = Math.round(zoom * 100) + '%';
    if (statusZoom) statusZoom.textContent = zoomText;
    if (zoomDisplay) zoomDisplay.textContent = zoomText;
  }

  function fitToWindow() {
    if (!imgWidth || !imgHeight) return;

    const containerRect = container.getBoundingClientRect();
    const availW = Math.max(1, containerRect.width - 40);
    const availH = Math.max(1, containerRect.height - 40);

    const scaleX = availW / imgWidth;
    const scaleY = availH / imgHeight;
    setZoom(Math.min(scaleX, scaleY, 1));
  }

  function setupZoomControls() {
    container.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();

          const rect = container.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          const scrollX = container.scrollLeft;
          const scrollY = container.scrollTop;

          const oldZoom = zoom;
          const delta = e.deltaY > 0 ? -0.1 : 0.1;
          setZoom(zoom + delta);

          // Adjust scroll to keep mouse position fixed
          const zoomRatio = zoom / oldZoom;
          container.scrollLeft = scrollX * zoomRatio + mouseX * (zoomRatio - 1);
          container.scrollTop = scrollY * zoomRatio + mouseY * (zoomRatio - 1);
        }
      },
      { passive: false }
    );

    const btnFit = document.getElementById('btn-fit');
    const btn100 = document.getElementById('btn-100');
    const btnZoomIn = document.getElementById('btn-zoom-in');
    const btnZoomOut = document.getElementById('btn-zoom-out');

    if (btnFit) btnFit.addEventListener('click', fitToWindow);
    if (btn100) btn100.addEventListener('click', () => setZoom(1));
    if (btnZoomIn) btnZoomIn.addEventListener('click', () => setZoom(zoom + 0.1));
    if (btnZoomOut) btnZoomOut.addEventListener('click', () => setZoom(zoom - 0.1));

    let isPanning = false;
    let panStart = { x: 0, y: 0 };
    let scrollStart = { x: 0, y: 0 };

    container.addEventListener('mousedown', (e) => {
      // When an annotation tool is active, the annotation canvas handles all mouse events.
      // Use the wrapper class flag so this check is synchronous and independent of
      // the annotation object state (avoids race conditions on segment reload).
      if (wrapper.classList.contains('annotation-active')) return;
      if (e.button !== 0) return;

      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
      scrollStart = { x: container.scrollLeft, y: container.scrollTop };
      container.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      container.scrollLeft = scrollStart.x - (e.clientX - panStart.x);
      container.scrollTop = scrollStart.y - (e.clientY - panStart.y);
    });

    window.addEventListener('mouseup', () => {
      if (!isPanning) return;
      isPanning = false;
      container.classList.remove('dragging');
    });

    // ── Click-to-zoom toggle ─────────────────────────────────────────────────
    // A click (< 5px movement) toggles between fit-to-window and 100% zoom.
    // Drag still pans; annotation tools intercept clicks when active.
    const CLICK_THRESHOLD_PX = 5;
    let clickDownPos = null;

    container.addEventListener('mousedown', (e) => {
      if (wrapper.classList.contains('annotation-active')) return;
      if (e.button !== 0) return;
      clickDownPos = { x: e.clientX, y: e.clientY };
    });

    container.addEventListener('click', (e) => {
      if (wrapper.classList.contains('annotation-active')) return;
      if (!clickDownPos) return;
      const dx = Math.abs(e.clientX - clickDownPos.x);
      const dy = Math.abs(e.clientY - clickDownPos.y);
      clickDownPos = null;
      if (dx > CLICK_THRESHOLD_PX || dy > CLICK_THRESHOLD_PX) return; // was a drag — ignore

      const fitZ = getFitZoom();
      if (zoom < fitZ + 0.01) {
        // Currently at or below fit zoom → zoom to 100%, centered on click point
        const rect = container.getBoundingClientRect();
        // Position in the scaled canvas coordinate space of the click
        const clickX = (e.clientX - rect.left + container.scrollLeft) / zoom;
        const clickY = (e.clientY - rect.top  + container.scrollTop)  / zoom;
        setZoom(1);
        // After setZoom, scroll so the same canvas pixel stays under cursor
        container.scrollLeft = clickX - (e.clientX - rect.left);
        container.scrollTop  = clickY - (e.clientY - rect.top);
      } else {
        // Currently zoomed in → fit to window and center horizontally
        fitToWindow();
        setTimeout(() => {
          container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
          container.scrollTop = 0;
        }, 20); // small delay to let CSS transition start
      }
    });
  }

  // --- Part controls ---

  function setupPartControls() {
    if (btnPartPrev) {
      btnPartPrev.addEventListener('click', async () => {
        if (currentSegmentIndex <= 0) return;
        await safeLoadSegment(currentSegmentIndex - 1);
      });
    }

    if (btnPartNext) {
      btnPartNext.addEventListener('click', async () => {
        if (currentSegmentIndex >= segmentCount - 1) return;
        await safeLoadSegment(currentSegmentIndex + 1);
      });
    }
  }

  async function safeLoadSegment(index) {
    try {
      await loadSegment(index);
    } catch (err) {
      loadingEl.classList.add('hidden');
      showToast(err.message || 'Failed to switch parts');
    }
  }

  function updatePartControls() {
    if (partIndicator) {
      partIndicator.textContent = `Part ${currentSegmentIndex + 1} / ${segmentCount}`;
    }

    if (btnPartPrev) {
      btnPartPrev.disabled = currentSegmentIndex <= 0;
    }

    if (btnPartNext) {
      btnPartNext.disabled = currentSegmentIndex >= segmentCount - 1;
    }

    if (partControlsEl) {
      if (segmentCount > 1) {
        partControlsEl.classList.remove('hidden');
      } else {
        partControlsEl.classList.add('hidden');
      }
    }
  }

  function updateBanner() {
    if (!bannerEl) return;

    const warnings = captureMeta?.warnings || [];
    let message = '';

    if (warnings.length > 0) {
      message = warnings[0];
    } else if (segmentCount > 1) {
      message = `Large page split into ${segmentCount} parts to preserve quality.`;
    }

    if (message) {
      bannerEl.textContent = message;
      bannerEl.classList.remove('hidden');
      container.style.top = '78px';
      loadingEl.style.top = '78px';
    } else {
      bannerEl.classList.add('hidden');
      container.style.top = '48px';
      loadingEl.style.top = '48px';
    }
  }

  // --- Export ---

  function setupExportButtons() {
    const btnPng = document.getElementById('btn-download-png');
    const btnJpeg = document.getElementById('btn-download-jpeg');
    const btnPdf = document.getElementById('btn-download-pdf');
    const btnCopy = document.getElementById('btn-copy');

    if (btnPng) btnPng.addEventListener('click', downloadPNG);
    if (btnJpeg) btnJpeg.addEventListener('click', () => showDialog('jpeg-dialog'));
    if (btnPdf) btnPdf.addEventListener('click', () => showDialog('pdf-dialog'));
    if (btnCopy) btnCopy.addEventListener('click', copyToClipboard);
  }

  function getCompositedCanvas() {
    const composite = document.createElement('canvas');
    composite.width = screenshotCanvas.width;
    composite.height = screenshotCanvas.height;

    const ctx = composite.getContext('2d');
    ctx.drawImage(screenshotCanvas, 0, 0);

    // Draw static annotation layer if present
    if (annotation && annotation.staticCanvas) {
      ctx.drawImage(annotation.staticCanvas, 0, 0);
    }

    // Draw dynamic annotation layer
    ctx.drawImage(annotationCanvas, 0, 0);

    return composite;
  }

  function addMetadataOverlay(canvas) {
    const showTs = settings.showTimestamp;
    const showUrl = settings.showUrl;

    if (!showTs && !showUrl) return canvas;
    if (!captureMeta) return canvas;

    const ctx = canvas.getContext('2d');
    const lines = [];

    if (showUrl && captureMeta.url) {
      lines.push(captureMeta.url);
    }

    if (showTs && captureMeta.createdAt) {
      const date = new Date(captureMeta.createdAt);
      lines.push(date.toLocaleString());
    }

    if (lines.length === 0) return canvas;

    const fontSize = Math.max(12, Math.round(canvas.width * 0.012));
    const padding = Math.round(fontSize * 0.8);
    const lineHeight = Math.round(fontSize * 1.4);
    const totalTextHeight = lines.length * lineHeight;
    const barHeight = totalTextHeight + padding * 2;

    // Draw semi-transparent bar at bottom
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, canvas.height - barHeight, canvas.width, barHeight);

    ctx.fillStyle = '#ffffff';
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'top';

    let textY = canvas.height - barHeight + padding;
    for (const line of lines) {
      ctx.fillText(line, padding, textY, canvas.width - padding * 2);
      textY += lineHeight;
    }

    ctx.restore();

    return canvas;
  }

  /**
   * Updates the DOM overlay bar that shows URL / date-time over the viewer canvas.
   * Uses a plain <div> (not canvas pixels) so PNG/JPEG exports are unaffected.
   * Called after each segment load and whenever the settings checkboxes change.
   */
  function updateViewerMetaBar() {
    const bar = document.getElementById('viewer-metadata-bar');
    if (!bar) return;

    const showUrl = settings.showUrl;
    const showTs  = settings.showTimestamp;

    if ((!showUrl && !showTs) || !captureMeta) {
      bar.classList.add('hidden');
      bar.textContent = '';
      return;
    }

    const lines = [];
    if (showUrl && captureMeta.url) {
      lines.push(captureMeta.url);
    }
    if (showTs && captureMeta.createdAt) {
      lines.push(new Date(captureMeta.createdAt).toLocaleString());
    }

    if (lines.length === 0) {
      bar.classList.add('hidden');
      bar.textContent = '';
      return;
    }

    bar.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    bar.classList.remove('hidden');
  }

  function downloadPNG() {
    let canvas = getCompositedCanvas();
    canvas = addMetadataOverlay(canvas);
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast('Failed to generate PNG');
        return;
      }
      downloadBlob(blob, generateFilename('png'));
      showToast('PNG downloaded');
    }, 'image/png');
  }

  function downloadJPEG(quality) {
    let canvas = getCompositedCanvas();
    canvas = addMetadataOverlay(canvas);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          showToast('Failed to generate JPEG');
          return;
        }
        downloadBlob(blob, generateFilename('jpg'));
        showToast('JPEG downloaded');
      },
      'image/jpeg',
      quality / 100
    );
  }

  async function downloadPDF(pageSize) {
    try {
      const { jsPDF } = window.jspdf;

      if (segmentCount === 1) {
        let canvas = getCompositedCanvas();
        canvas = addMetadataOverlay(canvas);
        const pdf = buildPdfForSingleCanvas(jsPDF, canvas, pageSize);
        pdf.save(generateFilename('pdf'));
        showToast('PDF saved');
        return;
      }

      if (pageSize === 'full') {
        await saveFullSizeMultipartPdf(jsPDF);
      } else {
        await savePagedMultipartPdf(jsPDF, pageSize);
      }

      showToast('PDF saved');
    } catch (err) {
      showToast('Failed to save PDF: ' + (err.message || err));
    }
  }

  function buildPdfForSingleCanvas(jsPDF, canvas, pageSize) {
    const pxToMm = 25.4 / 96;
    const imgWidthMm = canvas.width * pxToMm;
    const imgHeightMm = canvas.height * pxToMm;

    if (pageSize === 'full') {
      const orientation = imgWidthMm > imgHeightMm ? 'l' : 'p';
      const pdf = new jsPDF({ orientation, unit: 'mm', format: [imgWidthMm, imgHeightMm] });
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, imgWidthMm, imgHeightMm);
      return pdf;
    }

    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: pageSize });
    appendCanvasToPagedPdf(pdf, canvas, pageSize, true);
    return pdf;
  }

  async function saveFullSizeMultipartPdf(jsPDF) {
    let pdf = null;

    for (let i = 0; i < segmentCount; i++) {
      let canvas = await getCanvasForSegment(i);
      if (i === segmentCount - 1) {
        canvas = addMetadataOverlay(canvas);
      }
      const pxToMm = 25.4 / 96;
      const widthMm = canvas.width * pxToMm;
      const heightMm = canvas.height * pxToMm;
      const orientation = widthMm > heightMm ? 'l' : 'p';

      if (!pdf) {
        pdf = new jsPDF({ orientation, unit: 'mm', format: [widthMm, heightMm] });
      } else {
        pdf.addPage([widthMm, heightMm], orientation);
      }

      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, widthMm, heightMm);
    }

    if (!pdf) {
      throw new Error('No pages available for PDF export');
    }

    pdf.save(generateFilename('pdf'));
  }

  async function savePagedMultipartPdf(jsPDF, pageSize) {
    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: pageSize });
    let isFirstPage = true;

    for (let i = 0; i < segmentCount; i++) {
      const canvas = await getCanvasForSegment(i);
      isFirstPage = appendCanvasToPagedPdf(pdf, canvas, pageSize, isFirstPage);
    }

    pdf.save(generateFilename('pdf'));
  }

  /**
   * Builds a row-score array for the entire canvas height using the Horizontal
   * Projection Profile technique (Nagy & Seth, 1984 / ericdraken.com variant).
   *
   * Each row is scored by how "blank" it is, accounting for both dark and light
   * backgrounds via background-relative deviation:
   *   score[r] = average |pixel_brightness - background_brightness| across the row
   *
   * A perfectly blank row on any background → score = 0.
   * A row with content (text, images) → score > 0.
   *
   * We also smooth adjacent rows to avoid single anti-aliased pixels creating
   * false-positive blank rows between adjacent content lines.
   *
   * @param {Uint8ClampedArray} data          - imageData.data (RGBA flat array)
   * @param {number}            canvasWidth   - canvas pixel width
   * @param {number}            canvasHeight  - canvas pixel height
   * @param {number}            sampleStride  - sample every Nth column
   * @param {number}            bgBrightness  - detected background brightness (0–255)
   * @returns {Float32Array} rowScore[r] — lower means more blank
   */
  function buildRowScores(data, canvasWidth, canvasHeight, sampleStride, bgBrightness) {
    const scores = new Float32Array(canvasHeight);
    for (let r = 0; r < canvasHeight; r++) {
      let sumDev = 0, n = 0;
      for (let c = 0; c < canvasWidth; c += sampleStride) {
        const off        = (r * canvasWidth + c) * 4;
        const brightness = (data[off] + data[off + 1] + data[off + 2]) / 3;
        sumDev += Math.abs(brightness - bgBrightness);
        n++;
      }
      scores[r] = n > 0 ? sumDev / n : 0;
    }
    // No smoothing: the old 3-row box smooth was averaging genuine blank rows
    // with their text-row neighbours, raising the blank rows' scores above the
    // detection threshold and erasing real inter-line gaps from the output.
    // MIN_BAND_PX=3 already requires 3 consecutive blank rows, which filters
    // isolated 1-px anti-alias noise without smoothing needed.
    return scores;
  }

  /**
   * Detects the page background brightness by sampling the first and last 3%
   * of canvas rows (header/footer area is usually the background colour).
   * Returns a brightness value in [0, 255]: ~255 = white, ~0 = dark.
   *
   * @param {Uint8ClampedArray} data
   * @param {number}            canvasWidth
   * @param {number}            canvasHeight
   * @param {number}            sampleStride
   * @returns {number} background brightness estimate
   */
  function detectBackgroundBrightness(data, canvasWidth, canvasHeight, sampleStride) {
    const edgeRows = Math.max(1, Math.round(canvasHeight * 0.03));
    let sum = 0, n = 0;
    for (let r = 0; r < edgeRows; r++) {
      for (let c = 0; c < canvasWidth; c += sampleStride) {
        const off = (r * canvasWidth + c) * 4;
        sum += (data[off] + data[off + 1] + data[off + 2]) / 3;
        n++;
      }
    }
    for (let r = canvasHeight - edgeRows; r < canvasHeight; r++) {
      for (let c = 0; c < canvasWidth; c += sampleStride) {
        const off = (r * canvasWidth + c) * 4;
        sum += (data[off] + data[off + 1] + data[off + 2]) / 3;
        n++;
      }
    }
    return n > 0 ? sum / n : 255;
  }

  /**
   * Scans rowScores from fromY to toY and returns an array of ALL qualifying
   * whitespace bands, sorted by start position.
   *
   * A "band" is a contiguous run of rows whose score < blankThreshold that is
   * at least minBandPx rows wide. Each band object: { start, end, centre, width }.
   *
   * Scanning the full canvas (not just a ±N window) means we find paragraph gaps
   * even when they are far from the nominal page-cut point.
   *
   * @param {Float32Array} rowScores
   * @param {number}       fromY          first row to scan (inclusive)
   * @param {number}       toY            last row to scan (inclusive)
   * @param {number}       blankThreshold row score below this = "blank"
   * @param {number}       minBandPx      minimum consecutive blank rows required
   * @returns {Array<{start:number,end:number,centre:number,width:number}>}
   */
  function findAllWhitespaceBands(rowScores, fromY, toY, blankThreshold, minBandPx) {
    const bands = [];
    let bandStart = -1;

    for (let r = fromY; r <= toY + 1; r++) {
      const isBlank = r <= toY && rowScores[r] < blankThreshold;

      if (isBlank) {
        if (bandStart < 0) bandStart = r;
      } else {
        if (bandStart >= 0) {
          const bandEnd = r - 1;
          const width   = bandEnd - bandStart + 1;
          if (width >= minBandPx) {
            bands.push({
              start:  bandStart,
              end:    bandEnd,
              centre: (bandStart + bandEnd) / 2,
              width,
            });
          }
          bandStart = -1;
        }
      }
    }
    return bands; // already in ascending start order
  }

  function appendCanvasToPagedPdf(pdf, canvas, pageSize, isFirstPage) {
    const pageDims = pageSize === 'a4' ? [210, 297] : [215.9, 279.4];
    const margin   = 10;

    // canvas.width/height are in *physical* pixels (devicePixelRatio already applied
    // by the browser when capturing to canvas). Divide by DPR to recover logical CSS
    // pixels, then convert at the standard 96 CSS-px-per-inch.
    // On a standard 1× display DPR=1 so this is identical to the old behaviour.
    // On a Retina 2× display DPR=2, a 1920-wide viewport produces a 3840px-wide canvas;
    // without the DPR correction pxToMm would halve the image size in the PDF.
    const dpr    = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const pxToMm = 25.4 / (96 * dpr);

    const imgWidthMm  = canvas.width  * pxToMm;
    const imgHeightMm = canvas.height * pxToMm;

    const contentW = pageDims[0] - 2 * margin;
    const contentH = pageDims[1] - 2 * margin;   // full usable height (excl. margins)
    const scale    = contentW / imgWidthMm;

    // ── Footer lines (computed once, used for both space reservation and rendering) ─
    // Build footer lines here so we can calculate reserved space BEFORE the page loop.
    const FOOTER_LINE_HEIGHT_MM = 3.5;  // vertical spacing between footer lines
    const FOOTER_PADDING_MM     = 2.5;  // gap between image bottom and first footer line
    const footerLines = [];
    if (typeof settings !== 'undefined' && typeof captureMeta !== 'undefined' &&
        captureMeta) {
      if (settings.showUrl && captureMeta.url)           footerLines.push(captureMeta.url);
      if (settings.showTimestamp && captureMeta.createdAt)
        footerLines.push(new Date(captureMeta.createdAt).toLocaleString());
    }
    // Total mm to reserve at the bottom of every page for the footer.
    // When no footer is shown this is 0 and layout is unchanged.
    const footerReservedMm = footerLines.length > 0
      ? FOOTER_PADDING_MM + footerLines.length * FOOTER_LINE_HEIGHT_MM
      : 0;

    // Effective image height per page — shrunk by footer reserve so the image
    // NEVER reaches the footer area.  All subsequent calculations use this.
    const imageContentH = contentH - footerReservedMm;

    const scaledHeight = imgHeightMm * scale;
    const pagesNeeded  = Math.ceil(scaledHeight / imageContentH);

    // Source pixels that fill one full PDF image-content area height.
    const contentHPx = (imageContentH / scale / imgHeightMm) * canvas.height;

    // Column sampling stride (every 4th pixel).
    const sampleStride = 4;

    // Minimum contiguous blank-row band to count as valid whitespace.
    // 2px: on DPR=2 retina displays, 1 CSS pixel gap = 2 physical pixels, so 3 was too strict.
    const MIN_BAND_PX = 2;

    // Row score below this = blank (average pixel deviation from background colour).
    // 12 gives a small tolerance for slight anti-alias bleed at gap edges.
    const BLANK_ROW_THRESHOLD = 12;

    // When no whitespace band exists near a cut, the next page backs up by OVERLAP_PX
    // so the cut-boundary strip appears on BOTH pages (belt-and-suspenders safety net).
    const OVERLAP_PX = 60;

    // No MAX_FORWARD_PX cap — search the full remaining canvas for clean whitespace bands.
    // Pass 1 still prefers bands AT or AFTER nominalEndY (with a 50% ahead safety cap);
    // Pass 2 looks freely backwards for the closest band before the nominal cut point.

    // ── Pre-compute row scores for the ENTIRE canvas once ──────────────────────────
    let allBands     = null;
    let bgBrightness = 255;

    try {
      const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      bgBrightness    = detectBackgroundBrightness(
        imageData.data, canvas.width, canvas.height, sampleStride
      );
      const rowScores = buildRowScores(
        imageData.data, canvas.width, canvas.height, sampleStride, bgBrightness
      );
      allBands = findAllWhitespaceBands(
        rowScores, 0, canvas.height - 1, BLANK_ROW_THRESHOLD, MIN_BAND_PX
      );
    } catch (e) {
      allBands = null;  // tainted canvas or missing context — fall back gracefully
    }

    // prevCutY: logical end of previous page's content in canvas pixels.
    let prevCutY = 0;
    // bestBandForPage: hoisted outside the loop so Step 6 can advance prevCutY past
    // the entire whitespace band (not just to band.start), preventing the same band
    // from being selected again on the next iteration.
    let bestBandForPage = null;

    for (let page = 0; page < pagesNeeded; page++) {
      if (!isFirstPage) {
        pdf.addPage();
      }
      bestBandForPage = null; // reset each page

      // ── Step 1: Nominal bottom edge of this page's slice (canvas pixels) ──────────
      // Use imageContentH (not contentH) so the nominal slice fits within the image zone.
      const sourceEndMm = Math.min((page + 1) * imageContentH / scale, imgHeightMm);
      const nominalEndY = Math.min(
        Math.round((sourceEndMm / imgHeightMm) * canvas.height),
        canvas.height
      );

      // ── Step 2: Find best whitespace band for this cut (interior pages only) ──────
      let refinedEndY = nominalEndY;
      let useOverlap  = false;

      if (allBands !== null && page < pagesNeeded - 1) {
        // Two-pass: prefer bands AT OR AFTER nominalEndY (fills page fully),
        // then fall back to bands BEFORE (page ends a little early but cut is clean).
        // Guard uses band.end (not band.centre) to detect consumed bands — this is
        // critical because we cut at band.start (< band.centre), so after setting
        // prevCutY = band.start, band.centre > prevCutY would pass the old guard and
        // select the same band every iteration → 538-page explosion.
        let bestDist = Infinity;

        // Pass 1 — bands at or after nominalEndY (page fills as fully as possible).
        for (const band of allBands) {
          if (band.end <= prevCutY) continue;          // fully consumed — skip
          if (band.centre < nominalEndY) continue;     // behind nominal — skip in pass 1
          const dist = band.centre - nominalEndY;
          if (dist < bestDist) { bestDist = dist; bestBandForPage = band; }
          if (dist > contentHPx * 0.5) break;          // too far ahead — stop looking
        }

        // Pass 2 — bands before nominalEndY (only if Pass 1 found nothing usable).
        // Scans ALL bands behind the nominal cut, picks the one closest to it.
        if (!bestBandForPage) {
          bestDist = Infinity;
          for (const band of allBands) {
            if (band.end <= prevCutY) continue;         // fully consumed — skip
            if (band.centre >= nominalEndY) continue;   // at or after — not for pass 2
            const dist = nominalEndY - band.centre;
            if (dist < bestDist) { bestDist = dist; bestBandForPage = band; }
          }
        }

        if (bestBandForPage !== null) {
          refinedEndY = bestBandForPage.start;
          useOverlap  = false;
        } else {
          refinedEndY = nominalEndY;
          useOverlap  = true;
        }
      }

      // ── Step 3: Determine this page's source slice ────────────────────────────────
      let srcY = (useOverlap && prevCutY > 0)
        ? Math.max(0, prevCutY - OVERLAP_PX)
        : prevCutY;
      let srcH = refinedEndY - srcY;

      // Safety guard: if the slice is <5% of a normal page (rounding or edge case),
      // force meaningful progress by advancing a full page from prevCutY.
      if (srcH < contentHPx * 0.05) {
        srcY            = prevCutY;
        refinedEndY     = Math.min(prevCutY + Math.round(contentHPx), canvas.height);
        srcH            = refinedEndY - srcY;
        useOverlap      = false;
        bestBandForPage = null; // no band used — raw advancement
      }

      // Clamp srcH to at most one page of content so the image is never squished.
      // Without this, overlap slices (srcH = contentHPx + 60px) would be compressed
      // by the old drawHeightMm cap, causing visible vertical distortion.
      srcH = Math.max(1, Math.min(srcH, Math.round(contentHPx)));

      // ── Step 4: Render slice and add to PDF ──────────────────────────────────────
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width  = canvas.width;
      sliceCanvas.height = srcH;
      sliceCanvas.getContext('2d').drawImage(
        canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH
      );

      // drawHeightMm is exact — no min() cap needed because srcH ≤ contentHPx
      // guarantees (srcH / canvas.height) * imgHeightMm * scale ≤ imageContentH.
      const drawHeightMm = (srcH / canvas.height) * imgHeightMm * scale;

      pdf.addImage(
        sliceCanvas.toDataURL('image/jpeg', 0.92),
        'JPEG',
        margin,
        margin,
        contentW,
        drawHeightMm
      );

      // ── Step 5: White mask + footer ───────────────────────────────────────────────
      // The white rectangle covers the footer zone on every page, hiding any pixel
      // that might have bled past imageContentH due to JPEG rounding or jsPDF internals.
      if (footerReservedMm > 0) {
        pdf.setFillColor(255, 255, 255);
        pdf.rect(
          0,
          margin + imageContentH,
          pageDims[0],
          footerReservedMm + margin,   // footer band + bottom margin
          'F'
        );

        pdf.setFontSize(6);
        pdf.setTextColor(100, 100, 100);
        const footerTopY = margin + imageContentH + FOOTER_PADDING_MM;
        footerLines.forEach((line, i) => {
          const truncated = pdf.splitTextToSize(line, contentW)[0];
          pdf.text(truncated, margin, footerTopY + i * FOOTER_LINE_HEIGHT_MM);
        });
        pdf.setFontSize(12);        // restore jsPDF default
        pdf.setTextColor(0, 0, 0); // restore black
      }

      // ── Step 6: Advance logical position tracker ──────────────────────────────────
      // Advance PAST the entire whitespace band (band.end + 1) — not just to band.start.
      // This is the fix for the 538-page bug: cutting at band.start left band.centre
      // still > prevCutY, so the old guard (band.centre <= prevCutY) failed to skip
      // the same band, causing prevCutY to stall and each page to render ~1px of content.
      prevCutY = (bestBandForPage !== null)
        ? bestBandForPage.end + 1   // skip past the whitespace gap entirely
        : refinedEndY;              // overlap/raw fallback: start next page at cut point

      isFirstPage = false;
    }

    return isFirstPage;
  }

  async function getCanvasForSegment(index) {
    if (index === currentSegmentIndex) {
      return getCompositedCanvas();
    }

    // Try IndexedDB first, then service worker fallback
    let img = null;

    try {
      const segment = await CaptureStore.getCaptureSegment(captureId, index);
      if (segment?.blob && segment.blob.size > 0) {
        const objectUrl = URL.createObjectURL(segment.blob);
        try {
          img = await loadImage(objectUrl);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }
    } catch (_) {}

    if (!img) {
      const response = await chrome.runtime.sendMessage({
        action: MSG.GET_CAPTURE_SEGMENT,
        captureId,
        index,
      });
      if (response?.error || !response?.dataUrl) {
        throw new Error(`Failed to load part ${index + 1}`);
      }
      img = await loadImage(response.dataUrl);
    }

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    return canvas;
  }

  async function copyToClipboard() {
    try {
      const canvas = getCompositedCanvas();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) {
        throw new Error('Failed to serialize image');
      }
      const item = new ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([item]);
      showToast('Copied to clipboard');
    } catch (err) {
      showToast('Failed to copy: ' + err.message);
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- Dialogs ---

  function setupDialogs() {
    const jpegSlider = document.getElementById('jpeg-quality-slider');
    const jpegLabel = document.getElementById('jpeg-quality-label');
    const jpegCancel = document.getElementById('jpeg-cancel');
    const jpegConfirm = document.getElementById('jpeg-confirm');

    const pdfCancel = document.getElementById('pdf-cancel');
    const pdfConfirm = document.getElementById('pdf-confirm');

    if (jpegSlider && jpegLabel) {
      jpegSlider.addEventListener('input', () => {
        jpegLabel.textContent = jpegSlider.value + '%';
      });
    }

    if (jpegCancel) jpegCancel.addEventListener('click', () => hideDialog('jpeg-dialog'));
    if (jpegConfirm && jpegSlider) {
      jpegConfirm.addEventListener('click', () => {
        hideDialog('jpeg-dialog');
        downloadJPEG(parseInt(jpegSlider.value, 10));
      });
    }

    if (pdfCancel) pdfCancel.addEventListener('click', () => hideDialog('pdf-dialog'));
    if (pdfConfirm) {
      pdfConfirm.addEventListener('click', async () => {
        hideDialog('pdf-dialog');
        const selected = document.querySelector('input[name="pdf-size"]:checked');
        const size = selected ? selected.value : 'a4';
        await downloadPDF(size);
      });
    }

    document.querySelectorAll('.dialog-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.add('hidden');
        }
      });
    });
  }

  function showDialog(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  function hideDialog(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }

  // --- Settings panel ---

  function setupSettingsPanel() {
    const btnSettings = document.getElementById('btn-settings');
    const panel = document.getElementById('settings-panel');
    const closeBtn = document.getElementById('settings-close-btn');

    if (!btnSettings || !panel) return;

    btnSettings.addEventListener('click', () => {
      // Close filters panel if open
      const filtersPanel = document.getElementById('filters-panel');
      if (filtersPanel) filtersPanel.classList.add('hidden');

      panel.classList.toggle('hidden');
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
    }

    // Timestamp checkbox
    const tsCheckbox = document.getElementById('show-timestamp-checkbox');
    if (tsCheckbox) {
      tsCheckbox.addEventListener('change', () => {
        settings.showTimestamp = tsCheckbox.checked;
        saveSettings();
        updateViewerMetaBar();
      });
    }

    // URL checkbox
    const urlCheckbox = document.getElementById('show-url-checkbox');
    if (urlCheckbox) {
      urlCheckbox.addEventListener('change', () => {
        settings.showUrl = urlCheckbox.checked;
        saveSettings();
        updateViewerMetaBar();
      });
    }

    // Make panel draggable
    makeDraggable(panel, document.getElementById('settings-header'));
  }

  // --- Filters panel ---

  function setupFiltersPanel() {
    const btnFilters = document.getElementById('btn-filters');
    const panel = document.getElementById('filters-panel');
    const closeBtn = document.getElementById('filters-close-btn');
    const resetBtn = document.getElementById('filters-reset');
    const saveBtn = document.getElementById('filters-save');

    if (!btnFilters || !panel) return;

    btnFilters.addEventListener('click', () => {
      // Close settings panel if open
      const settingsPanel = document.getElementById('settings-panel');
      if (settingsPanel) settingsPanel.classList.add('hidden');

      panel.classList.toggle('hidden');
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
    }

    // Filter sliders - live preview
    const brightnessSlider = document.getElementById('brightness-slider');
    const contrastSlider = document.getElementById('contrast-slider');
    const saturationSlider = document.getElementById('saturation-slider');
    const grayscaleCheckbox = document.getElementById('grayscale-checkbox');
    const sepiaCheckbox = document.getElementById('sepia-checkbox');

    let filterDebounce = null;

    function onFilterChange() {
      if (brightnessSlider) {
        filters.brightness = parseInt(brightnessSlider.value, 10);
        const bv = document.getElementById('brightness-value');
        if (bv) bv.textContent = filters.brightness;
      }
      if (contrastSlider) {
        filters.contrast = parseInt(contrastSlider.value, 10);
        const cv = document.getElementById('contrast-value');
        if (cv) cv.textContent = filters.contrast;
      }
      if (saturationSlider) {
        filters.saturation = parseInt(saturationSlider.value, 10);
        const sv = document.getElementById('saturation-value');
        if (sv) sv.textContent = filters.saturation;
      }
      if (grayscaleCheckbox) filters.grayscale = grayscaleCheckbox.checked;
      if (sepiaCheckbox) filters.sepia = sepiaCheckbox.checked;

      clearTimeout(filterDebounce);
      filterDebounce = setTimeout(() => {
        applyCanvasFilters();
      }, 50);
    }

    if (brightnessSlider) brightnessSlider.addEventListener('input', onFilterChange);
    if (contrastSlider) contrastSlider.addEventListener('input', onFilterChange);
    if (saturationSlider) saturationSlider.addEventListener('input', onFilterChange);
    if (grayscaleCheckbox) grayscaleCheckbox.addEventListener('change', onFilterChange);
    if (sepiaCheckbox) sepiaCheckbox.addEventListener('change', onFilterChange);

    // Reset button
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        filters = { brightness: 0, contrast: 0, saturation: 0, grayscale: false, sepia: false };
        if (brightnessSlider) brightnessSlider.value = 0;
        if (contrastSlider) contrastSlider.value = 0;
        if (saturationSlider) saturationSlider.value = 0;
        if (grayscaleCheckbox) grayscaleCheckbox.checked = false;
        if (sepiaCheckbox) sepiaCheckbox.checked = false;

        const bv = document.getElementById('brightness-value');
        const cv = document.getElementById('contrast-value');
        const sv = document.getElementById('saturation-value');
        if (bv) bv.textContent = '0';
        if (cv) cv.textContent = '0';
        if (sv) sv.textContent = '0';

        applyCanvasFilters();
        showToast('Filters reset');
      });
    }

    // Save & Download button
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        downloadPNG();
        panel.classList.add('hidden');
      });
    }

    // Make panel draggable
    makeDraggable(panel, document.getElementById('filters-header'));
  }

  function applyCanvasFilters() {
    // Build CSS filter string for the screenshot canvas
    const parts = [];

    if (filters.brightness !== 0) {
      parts.push(`brightness(${100 + filters.brightness}%)`);
    }
    if (filters.contrast !== 0) {
      parts.push(`contrast(${100 + filters.contrast}%)`);
    }
    if (filters.saturation !== 0) {
      parts.push(`saturate(${100 + filters.saturation}%)`);
    }
    if (filters.grayscale) {
      parts.push('grayscale(100%)');
    }
    if (filters.sepia) {
      parts.push('sepia(100%)');
    }

    screenshotCanvas.style.filter = parts.length > 0 ? parts.join(' ') : 'none';
  }

  // --- Draggable panels ---

  function makeDraggable(panel, handle) {
    if (!panel || !handle) return;

    let isDragging = false;
    let dragStart = { x: 0, y: 0 };

    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('panel-close')) return;
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragStart = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      panel.classList.add('dragging');
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - dragStart.x));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - dragStart.y));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      panel.classList.remove('dragging');
    });
  }

  // --- Theme ---

  async function applyTheme() {
    const theme = settings.theme || 'system';

    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  function setupThemeToggle() {
    const btnTheme = document.getElementById('btn-theme');
    if (!btnTheme) return;

    btnTheme.addEventListener('click', async () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);

      settings.theme = next;
      await saveSettings();
    });
  }

  // --- Keyboard shortcuts ---

  // --- OS-aware shortcut display ---

  function updateShortcutDisplay() {
    const isMac = navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Mac');
    const mod   = isMac ? '⌘' : 'Ctrl';
    const shift = isMac ? '⇧' : 'Shift';
    const kbdStyle = 'background:var(--bg-hover);padding:2px 5px;border-radius:3px;border:1px solid var(--border);font-family:inherit';
    const el = document.getElementById('kbd-shortcuts-display');
    if (!el) return;
    el.innerHTML = [
      `<div><kbd style="${kbdStyle}">${mod}+${shift}+S</kbd> Full page screenshot</div>`,
      `<div><kbd style="${kbdStyle}">${mod}+${shift}+V</kbd> Visible area screenshot</div>`,
      `<div><kbd style="${kbdStyle}">${mod}+Z</kbd> / <kbd style="${kbdStyle}">${mod}+${shift}+Z</kbd> Undo / Redo</div>`,
      `<div><kbd style="${kbdStyle}">${mod}+S</kbd> Download PNG &nbsp;<kbd style="${kbdStyle}">${mod}+C</kbd> Copy</div>`,
      `<div><kbd style="${kbdStyle}">+</kbd> / <kbd style="${kbdStyle}">−</kbd> Zoom &nbsp;<kbd style="${kbdStyle}">0</kbd> Fit to window</div>`,
    ].join('');
  }

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', async (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (annotation) annotation.undo();
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (annotation) annotation.redo();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        downloadPNG();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        await copyToClipboard();
      }

      if (e.key === 'Escape') {
        // Close open panels
        const settingsPanel = document.getElementById('settings-panel');
        const filtersPanel = document.getElementById('filters-panel');
        if (settingsPanel && !settingsPanel.classList.contains('hidden')) {
          settingsPanel.classList.add('hidden');
          return;
        }
        if (filtersPanel && !filtersPanel.classList.contains('hidden')) {
          filtersPanel.classList.add('hidden');
          return;
        }

        if (annotation) annotation.setTool(null);
        activeTool = null;
        document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
        container.classList.remove('annotating');
        wrapper.classList.remove('annotation-active');
        annotationCanvas.style.pointerEvents = ''; // remove inline override → CSS default (none)
      }

      if (e.key === '=' || e.key === '+') {
        setZoom(zoom + 0.1);
      }

      if (e.key === '-') {
        setZoom(zoom - 0.1);
      }

      if (e.key === '0' && !e.ctrlKey && !e.metaKey) {
        fitToWindow();
      }

      if (segmentCount > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const nextIndex = e.key === 'ArrowLeft' ? currentSegmentIndex - 1 : currentSegmentIndex + 1;
        if (nextIndex >= 0 && nextIndex < segmentCount) {
          await safeLoadSegment(nextIndex);
        }
      }
    });
  }

  // --- Annotation controls ---

  function setupAnnotationControls() {
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        const isActive = btn.classList.contains('active');

        document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));

        if (isActive) {
          activeTool = null;
          if (annotation) annotation.setTool(null);
          container.classList.remove('annotating');
          wrapper.classList.remove('annotation-active');
          annotationCanvas.style.pointerEvents = ''; // remove inline override → CSS default (none) takes over
          return;
        }

        btn.classList.add('active');
        activeTool = tool;
        if (annotation) annotation.setTool(tool);
        container.classList.add('annotating');
        wrapper.classList.add('annotation-active');
        annotationCanvas.style.pointerEvents = 'auto'; // belt-and-suspenders: works even if CSS is cached/stale
      });
    });

    const colorInput = document.getElementById('annotation-color');
    if (colorInput) {
      colorInput.addEventListener('input', (e) => {
        if (annotation) annotation.setColor(e.target.value);
      });
    }

    const strokeSelect = document.getElementById('annotation-stroke');
    if (strokeSelect) {
      strokeSelect.addEventListener('change', (e) => {
        if (annotation) annotation.setStrokeWidth(parseInt(e.target.value, 10));
      });
    }

    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    const btnClear = document.getElementById('btn-clear-annotations');

    if (btnUndo) btnUndo.addEventListener('click', () => annotation && annotation.undo());
    if (btnRedo) btnRedo.addEventListener('click', () => annotation && annotation.redo());
    if (btnClear) btnClear.addEventListener('click', () => annotation && annotation.clearAll());
  }

  function restoreActiveTool() {
    if (!annotation) return;

    if (activeTool) {
      annotation.setTool(activeTool);
      container.classList.add('annotating');
      wrapper.classList.add('annotation-active');
      annotationCanvas.style.pointerEvents = 'auto'; // belt-and-suspenders alongside CSS class
    } else {
      annotation.setTool(null);
      container.classList.remove('annotating');
      wrapper.classList.remove('annotation-active');
      annotationCanvas.style.pointerEvents = ''; // remove inline override → CSS default (none)
    }
  }

  // --- Status bar ---

  function updateStatusBar() {
    if (statusDimensions) {
      statusDimensions.textContent = `${imgWidth} x ${imgHeight}`;
    }

    if (statusSize) {
      statusSize.textContent = currentSegmentBytes > 0 ? formatBytes(currentSegmentBytes) : '-';
    }

    if (statusZoom) {
      statusZoom.textContent = Math.round(zoom * 100) + '%';
    }

    if (zoomDisplay) {
      zoomDisplay.textContent = Math.round(zoom * 100) + '%';
    }
  }

  // --- UI helpers ---

  function setLoadingText(message) {
    const text = loadingEl.querySelector('.loading-text');
    if (text) text.textContent = message;
  }

  function showToast(message) {
    if (!toastEl) return;

    toastEl.textContent = message;
    toastEl.classList.remove('hidden');

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 2500);
  }

  function showError(message) {
    loadingEl.innerHTML = `
      <div style="color: var(--text-secondary); font-size: 14px; text-align: center; max-width: 420px;">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style="margin-bottom: 12px;">
          <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2"/>
          <path d="M24 14v12M24 30v4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <div>${message}</div>
      </div>
    `;
    loadingEl.classList.remove('hidden');
  }

  // --- Feedback / Rate banner ---

  function setupFeedbackBanner() {
    const banner = document.getElementById('feedback-banner');
    const rateBtn = document.getElementById('feedback-rate-btn');
    const dismissBtn = document.getElementById('feedback-dismiss-btn');
    const closeBtn = document.getElementById('feedback-close-btn');
    const feedbackToolbarBtn = document.getElementById('btn-feedback');
    const stars = banner ? banner.querySelectorAll('.fb-star') : [];

    if (!banner) return;

    // Check if user already dismissed or rated
    chrome.storage.local.get('fullsnap_feedback_state', (result) => {
      const state = result.fullsnap_feedback_state || {};
      const captureCount = (state.captureCount || 0) + 1;

      // Update capture count
      chrome.storage.local.set({
        fullsnap_feedback_state: { ...state, captureCount },
      });

      // Show banner after 3rd capture, and not if already rated or dismissed permanently
      if (state.rated || state.permanentDismiss) return;
      if (captureCount < 3 && !state.dismissed) return;

      // Show after 2 seconds delay
      setTimeout(() => {
        banner.classList.remove('hidden');
        // Trigger the slide-up animation after a paint cycle
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            banner.classList.add('visible');
          });
        });
      }, 2000);
    });

    // Star hover effects
    stars.forEach((star, index) => {
      star.addEventListener('mouseenter', () => {
        stars.forEach((s, i) => {
          s.classList.toggle('hovered', i <= index);
        });
      });

      star.addEventListener('mouseleave', () => {
        stars.forEach((s) => s.classList.remove('hovered'));
      });

      star.addEventListener('click', () => {
        stars.forEach((s, i) => {
          s.classList.toggle('active', i <= index);
        });
        // Auto-open store after selecting stars
        setTimeout(() => openChromeWebStore(), 500);
      });
    });

    // Rate button
    if (rateBtn) {
      rateBtn.addEventListener('click', () => {
        openChromeWebStore();
      });
    }

    // Dismiss button
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        hideFeedbackBanner(banner);
        chrome.storage.local.get('fullsnap_feedback_state', (result) => {
          const state = result.fullsnap_feedback_state || {};
          chrome.storage.local.set({
            fullsnap_feedback_state: { ...state, dismissed: true },
          });
        });
      });
    }

    // Close button
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        hideFeedbackBanner(banner);
        chrome.storage.local.get('fullsnap_feedback_state', (result) => {
          const state = result.fullsnap_feedback_state || {};
          chrome.storage.local.set({
            fullsnap_feedback_state: { ...state, permanentDismiss: true },
          });
        });
      });
    }

    // Toolbar feedback button - always opens banner or store
    if (feedbackToolbarBtn) {
      feedbackToolbarBtn.addEventListener('click', () => {
        if (banner.classList.contains('hidden') || !banner.classList.contains('visible')) {
          banner.classList.remove('hidden');
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              banner.classList.add('visible');
            });
          });
        } else {
          hideFeedbackBanner(banner);
        }
      });
    }
  }

  function openChromeWebStore() {
    const banner = document.getElementById('feedback-banner');
    // Replace with your actual Chrome Web Store extension URL
    const storeUrl = `https://chromewebstore.google.com/detail/fullsnap/${chrome.runtime.id}`;
    window.open(storeUrl, '_blank');

    chrome.storage.local.get('fullsnap_feedback_state', (result) => {
      const state = result.fullsnap_feedback_state || {};
      chrome.storage.local.set({
        fullsnap_feedback_state: { ...state, rated: true },
      });
    });

    if (banner) hideFeedbackBanner(banner);
    showToast('Thank you for your support! 🎉');
  }

  function hideFeedbackBanner(banner) {
    banner.classList.remove('visible');
    setTimeout(() => {
      banner.classList.add('hidden');
    }, 600);
  }
})();
