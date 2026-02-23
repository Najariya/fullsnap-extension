// FullSnap Offscreen Document - Canvas stitching and segment persistence.
// This document has DOM access that the service worker lacks.

let canvas = null;
let ctx = null;
let canvasStrategy = null;
let resultDataUrl = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case MSG.PREPARE_CANVAS:
      try {
        prepareCanvas(message.width, message.height, message.devicePixelRatio);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      break;

    case MSG.STITCH_VIEWPORT:
      stitchViewport(message)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case MSG.GET_RESULT:
      getResult()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case MSG.GET_RESULT_BLOB:
      storeCurrentSegment(message)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case 'COPY_TO_CLIPBOARD':
      copyToClipboard(message.dataUrl)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    default:
      return false;
  }
});

function prepareCanvas(viewportWidth, totalHeight, dpr) {
  canvasStrategy = determineCanvasStrategy(viewportWidth, totalHeight, dpr);

  canvas = document.createElement('canvas');
  canvas.width = canvasStrategy.canvasWidth;
  canvas.height = canvasStrategy.canvasHeight;

  ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D canvas context');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  canvas._lastDrawnBottomY = 0;
  resultDataUrl = null;
}

function determineCanvasStrategy(width, height, dpr) {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const safeDpr = Number.isFinite(dpr) ? Math.max(0.5, dpr) : 1;

  const physicalWidth = Math.round(safeWidth * safeDpr);
  const physicalHeight = Math.round(safeHeight * safeDpr);
  const area = physicalWidth * physicalHeight;

  if (physicalWidth > CAPTURE_LIMITS.MAX_CANVAS_DIMENSION) {
    throw new Error('Requested canvas width exceeds safe browser limits');
  }

  if (physicalHeight > CAPTURE_LIMITS.MAX_CANVAS_DIMENSION) {
    throw new Error('Requested canvas height exceeds safe browser limits');
  }

  if (area > CAPTURE_LIMITS.MAX_CANVAS_AREA) {
    throw new Error('Requested canvas area exceeds safe browser limits');
  }

  return {
    scale: safeDpr,
    canvasWidth: physicalWidth,
    canvasHeight: physicalHeight,
  };
}

async function stitchViewport(message) {
  if (!canvas || !ctx || !canvasStrategy) {
    throw new Error('Canvas not prepared before stitching');
  }

  const { dataUrl, yOffset, viewportHeight, totalHeight, isFirst, isLast } = message;
  const timeoutMs = Math.max(15000, CAPTURE_LIMITS.STITCH_IMAGE_TIMEOUT_MS || 60000);
  const img = await loadImageWithTimeout(dataUrl, timeoutMs);

  const canvasScale = canvasStrategy.scale;
  const drawY = Math.round(yOffset * canvasScale);

  // Use the captured image's actual pixel dimensions for accurate mapping.
  // The captured image comes from captureVisibleTab which returns at native DPR.
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;

  // Destination dimensions: map the CSS viewport to our canvas coordinate system.
  const drawWidth = canvas.width;
  const drawHeight = Math.round(viewportHeight * canvasScale);

  // For overlapping last viewport, crop off the top portion that was already drawn
  // by a previous viewport. This prevents the "seam line" where two viewports
  // overlap with slightly different sub-pixel rendering.
  let srcCropY = 0;      // How many source pixels to skip from top
  let destCropY = drawY;  // Where to start drawing on canvas

  if (!isFirst && yOffset > 0) {
    // Check if this viewport overlaps with the region already stitched.
    // The previous viewport covered up to (prevScrollY + viewportHeight).
    // If yOffset < (prevScrollY + viewportHeight), we have overlap.
    // We can detect overlap: the expected y without overlap would be drawY,
    // but we only need to draw the NEW pixels that haven't been covered yet.
    const expectedPosNoOverlap = drawY;  // Where this viewport starts in canvas space
    const alreadyDrawnUpTo = canvas._lastDrawnBottomY || 0;

    if (alreadyDrawnUpTo > expectedPosNoOverlap) {
      // There IS overlap. Skip the overlapping top portion of this viewport.
      const overlapPx = alreadyDrawnUpTo - expectedPosNoOverlap;  // in canvas pixels
      // Convert canvas overlap pixels to source image pixels
      srcCropY = Math.round((overlapPx / drawHeight) * srcH);
      destCropY = alreadyDrawnUpTo;
    }
  }

  const srcDrawH = srcH - srcCropY;
  const destDrawH = drawHeight - (destCropY - drawY);

  try {
    if (srcDrawH > 0 && destDrawH > 0) {
      ctx.drawImage(
        img,
        0, srcCropY, srcW, srcDrawH,        // source: full width, cropped height
        0, destCropY, drawWidth, destDrawH   // dest: full width, adjusted position
      );
    }
  } catch (err) {
    throw new Error(`Canvas drawing failed: ${err.message}`);
  }

  // Track the bottom edge of what we've drawn so far
  canvas._lastDrawnBottomY = destCropY + destDrawH;
}

async function getResult() {
  if (!canvas) {
    return { error: 'No canvas available' };
  }

  try {
    resultDataUrl = canvas.toDataURL('image/png');
    return { dataUrl: resultDataUrl };
  } catch (err) {
    return { error: err.message };
  }
}

async function storeCurrentSegment(message) {
  if (!canvas || !ctx) {
    throw new Error('No canvas available to store');
  }

  const captureId = message.captureId;
  const index = message.index;

  if (!captureId || !Number.isInteger(index)) {
    throw new Error('captureId and numeric segment index are required');
  }

  const blob = await canvasToBlob(canvas, 'image/png');

  await CaptureStore.putCaptureSegment({
    captureId,
    index,
    blob,
    width: canvas.width,
    height: canvas.height,
    yStart: message.yStart || 0,
    yEnd: message.yEnd || canvas.height,
  });

  return {
    ok: true,
    index,
    width: canvas.width,
    height: canvas.height,
  };
}

function canvasToBlob(canvasEl, type) {
  return new Promise((resolve, reject) => {
    canvasEl.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to serialize canvas'));
      }
    }, type);
  });
}

function loadImageWithTimeout(dataUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;

    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Image loading timeout (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(img);
    };

    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error('Failed to load viewport image'));
    };

    img.src = dataUrl;

    if (img.complete && img.naturalWidth > 0) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(img);
    }
  });
}

async function copyToClipboard(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const item = new ClipboardItem({ 'image/png': blob });
  await navigator.clipboard.write([item]);
}
