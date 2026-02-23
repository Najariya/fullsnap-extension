// FullSnap Service Worker - Central orchestrator
// Handles capture requests, coordinates content script + offscreen document, and serves viewer data.

importScripts('/shared/constants.js', '/shared/utils.js', '/shared/capture-store.js');

let pendingCaptureId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  const handledActions = new Set([
    MSG.CAPTURE_FULL_PAGE,
    MSG.CAPTURE_VISIBLE,
    MSG.GET_PENDING_CAPTURE,
    MSG.GET_CAPTURE_META,
    MSG.GET_CAPTURE_SEGMENT,
    MSG.DELETE_CAPTURE,
    'GET_PENDING_SCREENSHOT',
  ]);

  if (!handledActions.has(message.action)) {
    // Leave other messages for offscreen/content listeners.
    return false;
  }

  handleRuntimeMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('Service worker message handler error:', err);
      sendResponse({ error: err.message || 'Unknown error' });
    });

  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-full-page') {
    handleCapture('full').catch((err) => console.error('Command error:', err));
  } else if (command === 'capture-visible') {
    handleCapture('visible').catch((err) => console.error('Command error:', err));
  }
});

async function handleRuntimeMessage(message) {
  switch (message.action) {
    case MSG.CAPTURE_FULL_PAGE:
      return handleCapture('full');
    case MSG.CAPTURE_VISIBLE:
      return handleCapture('visible');
    case MSG.GET_PENDING_CAPTURE:
      return getPendingCapture();
    case MSG.GET_CAPTURE_META:
      return getCaptureMeta(message.captureId);
    case MSG.GET_CAPTURE_SEGMENT:
      return getCaptureSegment(message.captureId, message.index);
    case MSG.DELETE_CAPTURE:
      return deleteCapture(message.captureId);
    case 'GET_PENDING_SCREENSHOT':
      return {
        error: 'Legacy screenshot payload has been replaced. Use capture metadata + segments.',
      };
    default:
      return { error: 'Unknown action' };
  }
}

async function handleCapture(mode) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      return { error: 'No active tab found' };
    }

    const url = tab.url || '';
    if (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('https://chromewebstore.google.com') ||
      url.startsWith('about:') ||
      url.startsWith('edge://')
    ) {
      return { error: 'Cannot capture this page. Browser restricts screenshots on system pages.' };
    }

    return mode === 'visible' ? captureVisible(tab) : captureFullPage(tab);
  } catch (err) {
    console.error('Capture error:', err);
    return { error: err.message || 'Capture failed' };
  }
}

async function captureVisible(tab) {
  const dataUrl = await captureWithRetry();
  const blob = await dataUrlToBlob(dataUrl);
  const imageInfo = await getImageDimensions(blob, tab.width || 0, tab.height || 0);

  const captureId = createCaptureId();
  const now = Date.now();

  await CaptureStore.putCaptureSegment({
    captureId,
    index: 0,
    blob,
    width: imageInfo.width,
    height: imageInfo.height,
    yStart: 0,
    yEnd: imageInfo.height,
  });

  await CaptureStore.putCaptureMeta({
    captureId,
    createdAt: now,
    updatedAt: now,
    url: tab.url,
    title: tab.title,
    mode: 'visible',
    segmentCount: 1,
    width: imageInfo.width,
    totalHeight: imageInfo.height,
    devicePixelRatio: 1,
    warnings: [],
  });

  await setPendingCapture(captureId);
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });

  return { success: true, captureId };
}

async function captureFullPage(tab) {
  const tabId = tab.id;
  const captureId = createCaptureId();

  let didInjectContentScript = false;

  try {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['shared/constants.js', 'content/capture.js'],
      });
      didInjectContentScript = true;
    } catch (err) {
      console.error('Content script injection failed:', err);
      const errorMsg = err.message || '';

      if (errorMsg.includes('chrome://') || errorMsg.includes('chrome-extension://')) {
        throw new Error('Cannot capture Chrome internal pages (chrome://, chrome-extension://)');
      }
      if (errorMsg.includes('file://')) {
        throw new Error('Cannot capture local files (file://). Try a web page instead.');
      }
      if (errorMsg.includes('webstore')) {
        throw new Error('Cannot capture Chrome Web Store pages due to security restrictions');
      }

      throw new Error(`Script injection failed: ${errorMsg}`);
    }

    const metricsResponse = await sendMessageToTab(tabId, { action: MSG.START_CAPTURE });
    if (metricsResponse.error) {
      throw new Error(metricsResponse.error);
    }

    const metrics = metricsResponse;
    const positions = calculateScrollPositions(metrics.totalHeight, metrics.viewportHeight);
    const strategy = computeCaptureStrategy(metrics);
    const segments = buildCaptureSegments(
      positions,
      metrics.viewportHeight,
      metrics.totalHeight,
      strategy.viewportsPerSegment
    );

    await ensureOffscreenDocument();

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex];

      const prepareResponse = await chrome.runtime.sendMessage({
        action: MSG.PREPARE_CANVAS,
        width: metrics.viewportWidth,
        height: segment.height,
        devicePixelRatio: strategy.effectiveDpr,
      });

      if (prepareResponse?.error) {
        throw new Error(`Canvas preparation failed: ${prepareResponse.error}`);
      }
      if (!prepareResponse?.ok) {
        throw new Error('Canvas preparation did not confirm success');
      }

      const stitchQueue = new Set();

      for (let i = 0; i < segment.positions.length; i++) {
        const globalIndex = segment.startPositionIndex + i;
        const isFirst = globalIndex === 0;
        const isLast = globalIndex === positions.length - 1;
        const progress = (globalIndex + 1) / positions.length;

        await updateProgress(progress, isLast);

        const scrollResponse = await sendMessageToTab(tabId, {
          action: MSG.SCROLL_TO,
          scrollY: segment.positions[i],
          isFirst,
          isLast,
          progress,
        });

        if (scrollResponse?.error || !scrollResponse?.ok) {
          throw new Error(scrollResponse?.error || 'Failed to scroll page during capture');
        }

        // Wait for paint to settle after scroll (content script uses rAF, add extra safety)
        await delay(DEFAULTS.captureDelay);

        const dataUrl = await captureWithRetry();

        const stitchPromise = chrome.runtime.sendMessage({
          action: MSG.STITCH_VIEWPORT,
          dataUrl,
          yOffset: segment.positions[i] - segment.startY,
          viewportHeight: metrics.viewportHeight,
          totalHeight: segment.height,
          devicePixelRatio: strategy.effectiveDpr,
          isFirst,
          isLast,
        }).then((response) => {
          if (response?.error) {
            throw new Error(response.error);
          }
          if (!response?.ok) {
            throw new Error('Offscreen stitch did not confirm success');
          }
          return response;
        });

        trackPromise(stitchQueue, stitchPromise);
        if (stitchQueue.size >= CAPTURE_LIMITS.STITCH_CONCURRENCY) {
          await Promise.race(stitchQueue);
        }
      }

      await Promise.all(stitchQueue);

      const resultResponse = await chrome.runtime.sendMessage({
        action: MSG.GET_RESULT_BLOB,
        captureId,
        index: segment.index,
        yStart: segment.startY,
        yEnd: segment.endY,
      });

      if (resultResponse?.error) {
        throw new Error(`Failed to store segment ${segment.index + 1}: ${resultResponse.error}`);
      }
    }

    const warnings = [];
    if (segments.length > 1) {
      warnings.push(`Large page split into ${segments.length} parts to preserve quality.`);
    }

    const now = Date.now();
    await CaptureStore.putCaptureMeta({
      captureId,
      createdAt: now,
      updatedAt: now,
      url: tab.url,
      title: tab.title,
      mode: 'full',
      segmentCount: segments.length,
      width: Math.round(metrics.viewportWidth * strategy.effectiveDpr),
      totalHeight: Math.round(metrics.totalHeight * strategy.effectiveDpr),
      cssTotalHeight: metrics.totalHeight,
      viewportHeight: metrics.viewportHeight,
      devicePixelRatio: strategy.effectiveDpr,
      originalDevicePixelRatio: metrics.devicePixelRatio,
      warnings,
    });

    await setPendingCapture(captureId);
    await chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });

    return { success: true, captureId, segmentCount: segments.length };
  } catch (err) {
    console.error('Full-page capture failed:', err);
    await CaptureStore.deleteCapture(captureId).catch(() => {});
    return { error: err.message || 'Capture failed' };
  } finally {
    chrome.action.setBadgeText({ text: '' });

    if (didInjectContentScript) {
      await sendMessageToTab(tabId, { action: MSG.CLEANUP }).catch(() => {});
    }
  }
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS', 'CLIPBOARD'],
      justification: 'Canvas stitching for screenshot assembly and clipboard operations',
    });
  }
}

let lastCaptureTime = 0;

async function captureWithRetry() {
  // Throttle: ensure minimum gap between captureVisibleTab calls
  const now = Date.now();
  const elapsed = now - lastCaptureTime;
  const throttle = DEFAULTS.captureThrottleMs || 550;
  if (elapsed < throttle) {
    await delay(throttle - elapsed);
  }

  for (let attempt = 0; attempt < DEFAULTS.maxRetries; attempt++) {
    try {
      lastCaptureTime = Date.now();
      return await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    } catch (err) {
      const errMsg = err.message || '';
      const isRateLimit = errMsg.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');

      if (attempt < DEFAULTS.maxRetries - 1) {
        // Exponential backoff: 600ms, 1200ms, 2400ms, etc. (longer for rate limits)
        const backoff = isRateLimit
          ? 600 * Math.pow(2, attempt)
          : 200 * (attempt + 1);
        console.warn(`captureVisibleTab attempt ${attempt + 1} failed (${isRateLimit ? 'rate limit' : 'error'}), retrying in ${backoff}ms...`);
        await delay(backoff);
      } else {
        console.error('Tab capture failed after retries:', err);
        throw err;
      }
    }
  }

  throw new Error('Capture failed after retries');
}

function calculateScrollPositions(totalHeight, viewportHeight) {
  if (totalHeight <= viewportHeight) {
    return [0];
  }

  const positions = [];
  let y = 0;

  while (y + viewportHeight <= totalHeight) {
    positions.push(y);
    y += viewportHeight;
  }

  if (y < totalHeight) {
    positions.push(totalHeight - viewportHeight);
  }

  return [...new Set(positions)].sort((a, b) => a - b);
}

function computeCaptureStrategy(metrics) {
  const dpr = metrics.devicePixelRatio || 1;
  const viewportWidth = Math.max(1, metrics.viewportWidth || 1);
  const viewportHeight = Math.max(1, metrics.viewportHeight || 1);

  const maxDprByWidth = CAPTURE_LIMITS.MAX_CANVAS_DIMENSION / viewportWidth;
  const effectiveDpr = roundTo(Math.max(0.5, Math.min(dpr, maxDprByWidth)), 3);

  if (!Number.isFinite(effectiveDpr) || effectiveDpr <= 0) {
    throw new Error('Unable to compute safe capture scale');
  }

  const maxHeightByDimension = Math.floor(CAPTURE_LIMITS.MAX_CANVAS_DIMENSION / effectiveDpr);
  const maxHeightByArea = Math.floor(
    CAPTURE_LIMITS.MAX_CANVAS_AREA / (viewportWidth * effectiveDpr * effectiveDpr)
  );

  const maxSegmentHeightCss = Math.max(
    viewportHeight,
    Math.min(maxHeightByDimension, maxHeightByArea)
  );

  if (!Number.isFinite(maxSegmentHeightCss) || maxSegmentHeightCss <= 0) {
    throw new Error('Page is too large to capture with current browser limits');
  }

  const viewportsPerSegment = Math.max(1, Math.floor(maxSegmentHeightCss / viewportHeight));

  return {
    effectiveDpr,
    maxSegmentHeightCss,
    viewportsPerSegment,
  };
}

function buildCaptureSegments(positions, viewportHeight, totalHeight, viewportsPerSegment) {
  const segments = [];

  for (let i = 0; i < positions.length; i += viewportsPerSegment) {
    const slice = positions.slice(i, i + viewportsPerSegment);
    const startY = slice[0];
    const endY = Math.min(totalHeight, slice[slice.length - 1] + viewportHeight);

    segments.push({
      index: segments.length,
      startPositionIndex: i,
      positions: slice,
      startY,
      endY,
      height: endY - startY,
    });
  }

  return segments;
}

function trackPromise(set, promise) {
  set.add(promise);
  const clear = () => set.delete(promise);
  promise.then(clear).catch(clear);
}

async function updateProgress(progress, isLast) {
  const percent = Math.round(progress * 100);

  chrome.action.setBadgeText({ text: `${percent}%` });
  chrome.action.setBadgeBackgroundColor({ color: '#4A90D9' });

  try {
    await chrome.runtime.sendMessage({
      action: MSG.CAPTURE_PROGRESS,
      progress,
    });
  } catch (_) {
    // Popup may be closed.
  }

  if (isLast) {
    chrome.action.setBadgeText({ text: '' });
  }
}

function sendMessageToTab(tabId, message, timeoutMs = 10000) {
  const messagePromise = new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || {});
      }
    });
  });

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ error: `No response from tab after ${timeoutMs}ms` }), timeoutMs)
  );

  return Promise.race([messagePromise, timeoutPromise]);
}

async function setPendingCapture(captureId) {
  pendingCaptureId = captureId || null;
  await CaptureStore.setPendingCaptureId(pendingCaptureId);

  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.PENDING_CAPTURE_ID]: pendingCaptureId });
  } catch (_) {
    // session storage may be unavailable in older environments.
  }
}

async function readPendingCaptureId() {
  if (pendingCaptureId) {
    return pendingCaptureId;
  }

  const persisted = await CaptureStore.getPendingCaptureId();
  if (persisted) {
    pendingCaptureId = persisted;
    return pendingCaptureId;
  }

  try {
    const session = await chrome.storage.session.get(STORAGE_KEYS.PENDING_CAPTURE_ID);
    pendingCaptureId = session[STORAGE_KEYS.PENDING_CAPTURE_ID] || null;
    if (pendingCaptureId) {
      await CaptureStore.setPendingCaptureId(pendingCaptureId);
    }
  } catch (_) {
    pendingCaptureId = null;
  }

  return pendingCaptureId;
}

async function getPendingCapture() {
  const captureId = await readPendingCaptureId();
  if (!captureId) {
    return { error: 'No screenshot available' };
  }

  return { captureId };
}

async function getCaptureMeta(captureId) {
  const resolvedCaptureId = captureId || (await readPendingCaptureId());
  if (!resolvedCaptureId) {
    return { error: 'No capture selected' };
  }

  const meta = await CaptureStore.getCaptureMeta(resolvedCaptureId);
  if (!meta) {
    return { error: 'Capture metadata not found' };
  }

  return { meta };
}

async function getCaptureSegment(captureId, index) {
  const resolvedCaptureId = captureId || (await readPendingCaptureId());
  const resolvedIndex = Number.isInteger(index) ? index : 0;

  if (!resolvedCaptureId) {
    return { error: 'No capture selected' };
  }

  const segment = await CaptureStore.getCaptureSegment(resolvedCaptureId, resolvedIndex);
  if (!segment) {
    return { error: `Capture segment ${resolvedIndex} not found` };
  }

  const dataUrl = await blobToDataUrl(segment.blob);

  return {
    captureId: resolvedCaptureId,
    index: resolvedIndex,
    width: segment.width,
    height: segment.height,
    yStart: segment.yStart,
    yEnd: segment.yEnd,
    dataUrl,
  };
}

async function deleteCapture(captureId) {
  if (!captureId) {
    return { error: 'captureId is required' };
  }

  await CaptureStore.deleteCapture(captureId);

  const currentPending = await readPendingCaptureId();
  if (currentPending === captureId) {
    await setPendingCapture(null);
  }

  return { ok: true };
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function getImageDimensions(blob, fallbackWidth, fallbackHeight) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const dims = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dims;
    } catch (_) {
      // Fallback below.
    }
  }

  return {
    width: fallbackWidth || 0,
    height: fallbackHeight || 0,
  };
}

function createCaptureId() {
  if (self.crypto && typeof self.crypto.randomUUID === 'function') {
    return self.crypto.randomUUID();
  }

  return `capture-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
