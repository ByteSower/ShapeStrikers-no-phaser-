'use strict';

const MultiplayerTelemetry = (() => {
  const STORAGE_KEY = 'shape_strikers_mp_telemetry_log';
  const MAX_ENTRIES = 80;
  let _memoryEntries = [];

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
      }));
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
    };

    const entries = _readEntries();
    entries.push(entry);
    _writeEntries(entries);
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

  return {
    STORAGE_KEY,
    MAX_ENTRIES,
    record,
    list,
    clear,
  };
})();