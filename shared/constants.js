// Message types for communication between extension components
const MSG = {
  // Popup -> Service Worker
  CAPTURE_FULL_PAGE: 'CAPTURE_FULL_PAGE',
  CAPTURE_VISIBLE: 'CAPTURE_VISIBLE',

  // Service Worker -> Content Script
  START_CAPTURE: 'START_CAPTURE',
  SCROLL_TO: 'SCROLL_TO',
  CLEANUP: 'CLEANUP',

  // Content Script -> Service Worker
  PAGE_METRICS: 'PAGE_METRICS',
  READY_FOR_CAPTURE: 'READY_FOR_CAPTURE',
  CAPTURE_ERROR: 'CAPTURE_ERROR',
  CAPTURE_PROGRESS: 'CAPTURE_PROGRESS',

  // Service Worker -> Offscreen Document
  PREPARE_CANVAS: 'PREPARE_CANVAS',
  STITCH_VIEWPORT: 'STITCH_VIEWPORT',
  GET_RESULT: 'GET_RESULT',
  GET_RESULT_BLOB: 'GET_RESULT_BLOB',

  // Offscreen Document -> Service Worker
  STITCHING_COMPLETE: 'STITCHING_COMPLETE',
  CANVAS_READY: 'CANVAS_READY',

  // Viewer
  SCREENSHOT_READY: 'SCREENSHOT_READY',

  // Viewer -> Service Worker
  GET_PENDING_CAPTURE: 'GET_PENDING_CAPTURE',
  GET_CAPTURE_META: 'GET_CAPTURE_META',
  GET_CAPTURE_SEGMENT: 'GET_CAPTURE_SEGMENT',
  DELETE_CAPTURE: 'DELETE_CAPTURE',
};

// Default settings
const DEFAULTS = {
  format: 'png',
  jpegQuality: 90,
  theme: 'system',
  captureDelay: 100, // Delay after scroll before capture (ms)
  maxRetries: 5,
  captureThrottleMs: 550, // Min time between captureVisibleTab calls (Chrome limit: 2/sec)
};

// Storage keys
const STORAGE_KEYS = {
  SETTINGS: 'fullsnap_settings',
  SCREENSHOT_META: 'screenshotMeta',
  PENDING_CAPTURE_ID: 'pendingCaptureId',
};

// Capture limits tuned to avoid blank/white results on long pages.
const CAPTURE_LIMITS = {
  MAX_CANVAS_DIMENSION: 16384,
  MAX_CANVAS_AREA: 100000000,
  STITCH_CONCURRENCY: 1,
  STITCH_IMAGE_TIMEOUT_MS: 60000,
};
