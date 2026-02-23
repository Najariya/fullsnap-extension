(function (global) {
  const DB_NAME = 'fullsnap_capture_db';
  const DB_VERSION = 1;

  const STORES = {
    captures: 'captures',
    segments: 'segments',
    state: 'state',
  };

  const STATE_KEYS = {
    pendingCaptureId: 'pendingCaptureId',
  };

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;

        if (!db.objectStoreNames.contains(STORES.captures)) {
          db.createObjectStore(STORES.captures, { keyPath: 'captureId' });
        }

        if (!db.objectStoreNames.contains(STORES.segments)) {
          const segments = db.createObjectStore(STORES.segments, { keyPath: ['captureId', 'index'] });
          segments.createIndex('captureId', 'captureId', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.state)) {
          db.createObjectStore(STORES.state, { keyPath: 'key' });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open capture store'));
    });

    return dbPromise;
  }

  function requestAsPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  async function putCaptureMeta(meta) {
    if (!meta || !meta.captureId) throw new Error('putCaptureMeta requires captureId');
    const db = await openDb();
    const tx = db.transaction(STORES.captures, 'readwrite');
    tx.objectStore(STORES.captures).put(meta);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(meta);
      tx.onerror = () => reject(tx.error || new Error('Failed to write capture metadata'));
      tx.onabort = () => reject(tx.error || new Error('Capture metadata transaction aborted'));
    });
  }

  async function getCaptureMeta(captureId) {
    const db = await openDb();
    const tx = db.transaction(STORES.captures, 'readonly');
    return requestAsPromise(tx.objectStore(STORES.captures).get(captureId));
  }

  async function putCaptureSegment(segment) {
    if (!segment || !segment.captureId || typeof segment.index !== 'number') {
      throw new Error('putCaptureSegment requires captureId and numeric index');
    }
    const db = await openDb();
    const tx = db.transaction(STORES.segments, 'readwrite');
    tx.objectStore(STORES.segments).put(segment);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(segment);
      tx.onerror = () => reject(tx.error || new Error('Failed to write capture segment'));
      tx.onabort = () => reject(tx.error || new Error('Capture segment transaction aborted'));
    });
  }

  async function getCaptureSegment(captureId, index) {
    const db = await openDb();
    const tx = db.transaction(STORES.segments, 'readonly');
    return requestAsPromise(tx.objectStore(STORES.segments).get([captureId, index]));
  }

  async function listCaptureSegments(captureId) {
    const db = await openDb();
    const tx = db.transaction(STORES.segments, 'readonly');
    const index = tx.objectStore(STORES.segments).index('captureId');
    const rows = await requestAsPromise(index.getAll(IDBKeyRange.only(captureId)));
    return (rows || []).sort((a, b) => a.index - b.index);
  }

  async function setPendingCaptureId(captureId) {
    const db = await openDb();
    const tx = db.transaction(STORES.state, 'readwrite');
    tx.objectStore(STORES.state).put({
      key: STATE_KEYS.pendingCaptureId,
      value: captureId || null,
    });
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(captureId || null);
      tx.onerror = () => reject(tx.error || new Error('Failed to persist pending capture id'));
      tx.onabort = () => reject(tx.error || new Error('Pending capture id transaction aborted'));
    });
  }

  async function getPendingCaptureId() {
    const db = await openDb();
    const tx = db.transaction(STORES.state, 'readonly');
    const row = await requestAsPromise(tx.objectStore(STORES.state).get(STATE_KEYS.pendingCaptureId));
    return row?.value || null;
  }

  async function deleteCapture(captureId) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const tx = db.transaction([STORES.captures, STORES.segments, STORES.state], 'readwrite');
      const captures = tx.objectStore(STORES.captures);
      const segments = tx.objectStore(STORES.segments);
      const state = tx.objectStore(STORES.state);

      captures.delete(captureId);

      const cursorReq = segments.index('captureId').openCursor(IDBKeyRange.only(captureId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      cursorReq.onerror = () => fail(cursorReq.error || new Error('Failed to delete segments'));

      const pendingReq = state.get(STATE_KEYS.pendingCaptureId);
      pendingReq.onsuccess = () => {
        if (pendingReq.result?.value === captureId) {
          state.put({ key: STATE_KEYS.pendingCaptureId, value: null });
        }
      };
      pendingReq.onerror = () => fail(pendingReq.error || new Error('Failed to read pending capture state'));

      tx.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      };
      tx.onerror = () => fail(tx.error || new Error('Failed to delete capture'));
      tx.onabort = () => fail(tx.error || new Error('Delete capture transaction aborted'));
    });
  }

  const CaptureStore = {
    putCaptureMeta,
    getCaptureMeta,
    putCaptureSegment,
    getCaptureSegment,
    listCaptureSegments,
    setPendingCaptureId,
    getPendingCaptureId,
    deleteCapture,
  };

  global.CaptureStore = CaptureStore;
})(typeof self !== 'undefined' ? self : window);
