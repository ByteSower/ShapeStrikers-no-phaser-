'use strict';

const RunHistoryStore = (() => {
  let _database = null;
  const MAX_PAYLOAD = 32768;
  const MAX_PENDING_BYTES = 1048576;
  const MAX_PENDING = 100;
  const ERROR_RESERVE = 'x'.repeat(512);
  const TERMINAL = new Set(['won', 'lost', 'abandoned', 'interrupted']);

  function canonicalBytes(value) {
    const text = JSON.stringify(value);
    let quoted = false;
    let escaped = false;
    let spaces = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === ':' || char === ',') spaces++;
      else if (char === '-' || (char >= '0' && char <= '9')) {
        const start = index;
        while (/[0-9.eE+-]/.test(text[index + 1] || '')) index++;
        const number = text.slice(start, index + 1);
        if (number.includes('e')) {
          const [coefficient, exponent] = number.split('e');
          const unsigned = coefficient.replace('-', '');
          const digits = unsigned.replace('.', '').length;
          const point = unsigned.split('.')[0].length + Number(exponent);
          const expanded = point <= 0 ? 2 - point + digits : point >= digits ? point : digits + 1;
          spaces += expanded + (coefficient.startsWith('-') ? 1 : 0) - number.length;
        }
      }
    }
    return new TextEncoder().encode(text).length + spaces;
  }

  function open() {
    if (_database) return _database;
    _database = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('Browser history storage is unavailable'));
        return;
      }
      const request = indexedDB.open('shape_strikers_history', 1);
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('History storage did not open; close older game tabs and retry')), 8000);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('runs', { keyPath: 'id' });
        db.createObjectStore('cache', { keyPath: 'ownerId' });
      };
      request.onerror = () => { clearTimeout(timer); fail(request.error); };
      request.onblocked = () => {
        clearTimeout(timer);
        fail(new Error('History storage is blocked by an older game tab'));
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        db.onversionchange = () => { db.close(); _database = null; };
        resolve(db);
      };
    }).catch(error => {
      _database = null;
      throw error;
    });
    return _database;
  }

  async function transaction(name, mode, execute) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const store = tx.objectStore(name);
      let result;
      let failure;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(failure || tx.error || new Error('History storage transaction failed'));
      tx.onabort = () => reject(failure || tx.error || new Error('History storage transaction aborted'));
      const setResult = value => { result = value; };
      const fail = error => { failure = error; tx.abort(); };
      try { execute(store, setResult, fail); } catch (error) { fail(error); }
    });
  }

  function list() {
    return transaction('runs', 'readonly', (store, done) => {
      store.getAll().onsuccess = event => done(event.target.result);
    });
  }

  function pendingBytes(entry) {
    // Reserve future ownership/error metadata so a full guest queue can still bind and report failures.
    return canonicalBytes({
      ...entry,
      ownerId: entry.ownerId || '00000000-0000-0000-0000-000000000000',
      error: canonicalBytes(entry.error || null) > 514 ? entry.error : ERROR_RESERVE,
      generation: Number.MAX_SAFE_INTEGER,
      erasureHold: true,
      permanentError: false,
    });
  }

  function put(entry) {
    const copy = JSON.parse(JSON.stringify(entry));
    if (canonicalBytes(copy.payload) > MAX_PAYLOAD) {
      return Promise.reject(new Error('History summary exceeds 32 KiB; this result is not safely stored'));
    }
    return transaction('runs', 'readwrite', (store, done, fail) => {
      store.getAll().onsuccess = event => {
        const entries = event.target.result;
        const previous = entries.find(row => row.id === copy.id);
        if (previous) {
          if (previous.ownerId !== copy.ownerId || previous.guestFlowId !== copy.guestFlowId) {
            fail(new Error('History source account cannot change'));
            return;
          }
          if (TERMINAL.has(previous.payload.status)) {
            if (JSON.stringify(previous.payload) !== JSON.stringify(copy.payload)) {
              fail(new Error('A terminal browser history result cannot change'));
            } else done(previous);
            return;
          }
          if (previous.payload.revision >= copy.payload.revision) { done(previous); return; }
          if (previous.erasureHold && previous.generation === copy.generation) {
            copy.erasureHold = true;
            copy.error = previous.error;
            copy.permanentError = true;
          }
        }
        const pending = entries.filter(row => row.pending && row.id !== copy.id);
        const bytes = pending.reduce((sum, row) => sum + pendingBytes(row), 0) + pendingBytes(copy);
        if (pending.length >= MAX_PENDING || bytes > MAX_PENDING_BYTES) {
          fail(new Error('History queue is full (100 records / 1 MiB); existing pending records are preserved'));
          return;
        }
        store.put(copy);
        done(copy);
      };
    });
  }

  function acknowledge(id, ownerId, revision, status) {
    return transaction('runs', 'readwrite', (store, done) => {
      store.get(id).onsuccess = event => {
        const entry = event.target.result;
        if (!entry || entry.erasureHold || entry.ownerId !== ownerId || entry.payload.revision !== revision || entry.payload.status !== status) {
          done(false);
          return;
        }
        store.put({ ...entry, pending: false, error: null, permanentError: false });
        store.getAll().onsuccess = all => {
          const removable = all.target.result.filter(row => !row.pending && !row.erasureHold && TERMINAL.has(row.payload.status))
            .sort((a, b) => b.payload.observedAt - a.payload.observedAt);
          for (const old of removable.slice(50)) store.delete(old.id);
          done(true);
        };
      };
    });
  }

  function markError(id, revision, message, permanent) {
    return transaction('runs', 'readwrite', (store, done) => {
      store.get(id).onsuccess = event => {
        const entry = event.target.result;
        if (entry && !entry.erasureHold && entry.payload.revision === revision) {
          const diagnostic = message.length > 80 ? `${message.slice(0, 80)} [truncated]` : message;
          store.put({ ...entry, error: diagnostic, permanentError: permanent });
        }
        done();
      };
    });
  }

  function resolveErasure(id, ownerId, generation, discard) {
    return transaction('runs', 'readwrite', (store, done, fail) => {
      store.get(id).onsuccess = event => {
        const entry = event.target.result;
        if (!entry || entry.ownerId !== ownerId || !entry.erasureHold) {
          fail(new Error('This held history record is no longer available for this account'));
          return;
        }
        if (discard) {
          store.delete(id);
          done();
          return;
        }
        const restored = { ...entry, generation, pending: true, erasureHold: false, error: null, permanentError: false };
        store.getAll().onsuccess = all => {
          const pending = all.target.result.filter(row => row.pending && row.id !== id);
          const bytes = pending.reduce((sum, row) => sum + pendingBytes(row), 0) + pendingBytes(restored);
          if (pending.length >= MAX_PENDING || bytes > MAX_PENDING_BYTES) {
            fail(new Error('History queue is full (100 records / 1 MiB); this held record is preserved'));
            return;
          }
          store.put(restored);
          done();
        };
      };
    });
  }

  function holdErasure(id, ownerId, generation) {
    return transaction('runs', 'readwrite', (store, done) => {
      store.get(id).onsuccess = event => {
        const entry = event.target.result;
        if (entry?.ownerId === ownerId && entry.generation === generation) {
          store.put({ ...entry, erasureHold: true, error: 'History deletion state changed; choose restore or discard', permanentError: true });
        }
        done();
      };
    });
  }

  function bindGuestFlow(flowId, ownerId) {
    if (typeof ownerId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ownerId)) {
      return Promise.reject(new Error('History binding requires a valid account identifier'));
    }
    return transaction('runs', 'readwrite', (store, done) => {
      store.getAll().onsuccess = event => {
        let count = 0;
        for (const row of event.target.result) {
          if (row.ownerId === null && row.guestFlowId === flowId) {
            store.put({ ...row, ownerId, pending: true, error: null, permanentError: false });
            count++;
          }
        }
        done(count);
      };
    });
  }

  function getCache(ownerId) {
    return transaction('cache', 'readonly', (store, done) => {
      store.get(ownerId).onsuccess = event => done(event.target.result || null);
    });
  }

  function setCache(ownerId, records, totals) {
    return transaction('cache', 'readwrite', (store, done) => {
      store.put({ ownerId, records: records.slice(0, 50), totals, observedAt: Date.now() });
      done();
    });
  }

  function remove(id) {
    return transaction('runs', 'readwrite', (store, done) => {
      store.delete(id);
      done(true);
    });
  }

  async function purgeOwner(ownerId, guestFlowId, selectedIds, generation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['runs', 'cache'], 'readwrite');
      let count = 0;
      tx.objectStore('cache').delete(ownerId);
      const runs = tx.objectStore('runs');
      runs.getAll().onsuccess = event => {
        for (const row of event.target.result) {
          if (selectedIds.has(row.id)
            && (row.ownerId === ownerId || (row.ownerId === null && guestFlowId && row.guestFlowId === guestFlowId))) {
            runs.delete(row.id);
            count++;
          } else if (row.ownerId === ownerId && !selectedIds.has(row.id) && row.generation !== generation) {
            runs.put({
              ...row, erasureHold: true,
              error: 'History deletion state changed; choose restore or discard', permanentError: true,
            });
          }
        }
      };
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error || new Error('History storage transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('History storage transaction aborted'));
    });
  }

  return { open, list, put, acknowledge, markError, holdErasure, resolveErasure, bindGuestFlow, getCache, setCache, remove, purgeOwner, canonicalBytes };
})();
