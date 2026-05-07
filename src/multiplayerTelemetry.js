'use strict';

const MultiplayerTelemetry = (() => {
  const STORAGE_KEY = 'shape_strikers_mp_telemetry_log';
  const MAX_ENTRIES = 80;
  const FLUSH_BATCH_SIZE = 10;
  const FLUSH_RETRY_MS = 5000;
  const REQUEST_TIMEOUT_MS = 8000;
  const TELEMETRY_TABLE = 'mp_telemetry_events';
  let _memoryEntries = [];
  let _flushTimer = null;
  let _flushPromise = null;
  let _sessionId = _createId('mp-telemetry-session');

  function _cloneSerializable(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }

  function _createId(prefix = 'mp-telemetry') {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function _getStorage() {
    try {
      return (typeof localStorage !== 'undefined') ? localStorage : null;
    } catch (_) {
      return null;
    }
  }

  function _normalizeEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
      .filter(entry => entry && typeof entry.type === 'string' && entry.type)
      .slice(-MAX_ENTRIES)
      .map(entry => ({
        id: typeof entry.id === 'string' && entry.id ? entry.id : _createId(),
        type: entry.type,
        level: typeof entry.level === 'string' && entry.level ? entry.level : 'info',
        at: Number(entry.at) || Date.now(),
        details: _cloneSerializable(entry.details) || {},
        uploadedAt: Number(entry.uploadedAt) || 0,
        uploadAttempts: Math.max(0, Number(entry.uploadAttempts) || 0),
        lastUploadError: typeof entry.lastUploadError === 'string' && entry.lastUploadError ? entry.lastUploadError : null,
      }));
  }

  function _getClient() {
    if (typeof Backend === 'undefined' || typeof Backend.getClient !== 'function') return null;
    if (typeof Backend.isReady === 'function' && !Backend.isReady()) return null;
    return Backend.getClient();
  }

  function _getUserId() {
    if (typeof Backend === 'undefined' || typeof Backend.getUserId !== 'function') return null;
    return Backend.getUserId();
  }

  function _getVersion() {
    try {
      return (typeof PATCH_NOTES !== 'undefined' && PATCH_NOTES[0]?.version) || 'unknown';
    } catch (_) {
      return 'unknown';
    }
  }

  function _getPagePath() {
    try {
      return (typeof location !== 'undefined' && typeof location.pathname === 'string') ? location.pathname : null;
    } catch (_) {
      return null;
    }
  }

  function _getUserAgent() {
    try {
      return (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') ? navigator.userAgent : null;
    } catch (_) {
      return null;
    }
  }

  function _getPlatform() {
    try {
      return (typeof navigator !== 'undefined' && typeof navigator.platform === 'string') ? navigator.platform : null;
    } catch (_) {
      return null;
    }
  }

  function _normalizeRoomId(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!normalized) return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
      ? normalized
      : null;
  }

  function _scheduleFlush(delayMs = 250) {
    if (typeof setTimeout !== 'function') return;
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      flush();
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function _withTimeout(promise, label = 'Telemetry upload') {
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function _buildUploadRow(entry) {
    return {
      id: entry.id,
      player_id: _getUserId(),
      room_id: _normalizeRoomId(entry.details?.roomId),
      event_type: entry.type,
      level: entry.level,
      details: _cloneSerializable(entry.details) || {},
      client_at: new Date(entry.at).toISOString(),
      session_id: _sessionId,
      client_version: _getVersion(),
      page_path: _getPagePath(),
      platform: _getPlatform(),
      user_agent: _getUserAgent(),
    };
  }

  function _isDuplicateInsertError(error) {
    if (!error) return false;
    if (String(error.code || '') === '23505') return true;
    const message = String(error.message || '').toLowerCase();
    return message.includes('duplicate key') || message.includes('already exists');
  }

  async function _uploadEntry(client, entry) {
    const row = _buildUploadRow(entry);
    const { error } = await _withTimeout(
      client.from(TELEMETRY_TABLE).insert(row),
      `Telemetry upload (${entry.type})`
    );
    if (error && !_isDuplicateInsertError(error)) throw error;
  }

  function _readEntries() {
    const storage = _getStorage();
    if (!storage) return _memoryEntries.slice();

    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      return _normalizeEntries(JSON.parse(raw));
    } catch (_) {
      return [];
    }
  }

  function _writeEntries(entries) {
    const normalized = _normalizeEntries(entries);
    _memoryEntries = normalized.slice();

    const storage = _getStorage();
    if (!storage) return normalized;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch (_) {}
    return normalized;
  }

  function record(type, details = {}, options = {}) {
    if (typeof type !== 'string' || !type.trim()) return null;

    const entry = {
      id: _createId(),
      type: type.trim(),
      level: typeof options.level === 'string' && options.level ? options.level : 'info',
      at: Date.now(),
      details: _cloneSerializable(details) || {},
      uploadedAt: 0,
      uploadAttempts: 0,
      lastUploadError: null,
    };

    const entries = _readEntries();
    entries.push(entry);
    _writeEntries(entries);
    _scheduleFlush();
    return entry;
  }

  function list() {
    return _readEntries();
  }

  function clear() {
    _memoryEntries = [];
    const storage = _getStorage();
    if (!storage) return;
    try { storage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  async function flush() {
    if (_flushPromise) return _flushPromise;

    const client = _getClient();
    const userId = _getUserId();
    if (!client || !userId) return { ok: false, uploaded: 0, pending: _readEntries().filter(entry => !entry.uploadedAt).length };

    _flushPromise = (async () => {
      const entries = _readEntries();
      const pendingEntries = entries.filter(entry => !entry.uploadedAt).slice(0, FLUSH_BATCH_SIZE);
      if (!pendingEntries.length) {
        return { ok: true, uploaded: 0, pending: 0 };
      }

      let uploaded = 0;
      let retryDelayMs = 0;
      for (const pendingEntry of pendingEntries) {
        const liveEntries = _readEntries();
        const index = liveEntries.findIndex(entry => entry.id === pendingEntry.id);
        if (index === -1) continue;

        liveEntries[index].uploadAttempts = Math.max(0, Number(liveEntries[index].uploadAttempts) || 0) + 1;
        liveEntries[index].lastUploadError = null;
        _writeEntries(liveEntries);

        try {
          await _uploadEntry(client, liveEntries[index]);
          const updatedEntries = _readEntries();
          const updatedIndex = updatedEntries.findIndex(entry => entry.id === pendingEntry.id);
          if (updatedIndex !== -1) {
            updatedEntries[updatedIndex].uploadedAt = Date.now();
            updatedEntries[updatedIndex].lastUploadError = null;
            _writeEntries(updatedEntries);
          }
          uploaded += 1;
        } catch (error) {
          const updatedEntries = _readEntries();
          const updatedIndex = updatedEntries.findIndex(entry => entry.id === pendingEntry.id);
          if (updatedIndex !== -1) {
            updatedEntries[updatedIndex].lastUploadError = error?.message || 'Telemetry upload failed';
            _writeEntries(updatedEntries);
          }
          retryDelayMs = FLUSH_RETRY_MS;
          break;
        }
      }

      const pending = _readEntries().filter(entry => !entry.uploadedAt).length;
      if (pending > 0) {
        _scheduleFlush(retryDelayMs || 250);
      }
      return { ok: retryDelayMs === 0, uploaded, pending };
    })();

    try {
      return await _flushPromise;
    } finally {
      _flushPromise = null;
    }
  }

  function notifyBackendReady() {
    _scheduleFlush(0);
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => _scheduleFlush(0));
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _scheduleFlush(0);
    });
  }

  return {
    STORAGE_KEY,
    MAX_ENTRIES,
    FLUSH_BATCH_SIZE,
    TELEMETRY_TABLE,
    record,
    list,
    clear,
    flush,
    notifyBackendReady,
  };
})();