// Shared utility functions

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateFilename(extension, chunkInfo = null) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '-');

  if (chunkInfo) {
    return `fullsnap-${date}_${time}-part${chunkInfo.chunkIndex}.${extension}`;
  }

  return `fullsnap-${date}_${time}.${extension}`;
}

function generateFilenameForChunk(extension, chunkIndex, timestamp) {
  const date = new Date(timestamp);
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toTimeString().slice(0, 8).replace(/:/g, '-');
  return `fullsnap-${dateStr}_${timeStr}-part${chunkIndex}.${extension}`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64.split(',')[1] || base64);
  const byteArrays = [];
  for (let offset = 0; offset < byteChars.length; offset += 8192) {
    const slice = byteChars.slice(offset, offset + 8192);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }
  return new Blob(byteArrays, { type: mimeType });
}
