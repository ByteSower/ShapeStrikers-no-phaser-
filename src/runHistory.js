'use strict';

const RunHistory = (() => {
  const TERMINAL = new Set(['won', 'lost', 'abandoned', 'interrupted']);
  const _listeners = new Set();
  let _active = null;
  let _tabId = null;
  let _guestFlowId = null;
  let _knownOwner = null;
  let _guestOwner = null;
  let _initialized = false;
  let _writes = Promise.resolve();
  let _flush = null;
  let _retryTimer = null;
  let _retryDelay = 5000;
  let _message = 'History is starting';
  let _storageFailed = false;
  let _storageMessage = '';
  let _reloadRunId = null;
  let _changingAccount = false;
  let _erasing = false;
  let _erasureStartedIds = null;
  let _resolvingHeld = false;
  let _generation = null;
  let _generationOwner = null;
  const _unsavedIds = new Set();

  function notify() {
    for (const listener of _listeners) queueMicrotask(listener);
  }

  function report(message, error) {
    _message = message;
    console.warn('[RunHistory]', message, error?.name || '');
    notify();
  }

  function queue(entry) {
    const frozen = JSON.parse(JSON.stringify(entry));
    _writes = _writes.then(() => RunHistoryStore.put(frozen)).then(() => {
      _unsavedIds.delete(frozen.id);
      _storageFailed = _unsavedIds.size > 0;
      _message = 'History stored on this browser; awaiting account sync';
      notify();
      if (!_retryTimer && Backend.isReady()) {
        _retryTimer = setTimeout(() => { _retryTimer = null; flush(); }, 500);
      }
    }).catch(error => {
      _unsavedIds.add(frozen.id);
      _storageFailed = true;
      _storageMessage = `${error.message}. Gameplay remains available; this history may be unsaved.`;
      report(_storageMessage, error);
    });
    return _writes;
  }

  function entryFor(payload, ownerId = _active?.ownerId) {
    return {
      id: payload.id, ownerId: ownerId || null, tabId: _tabId, guestFlowId: _guestFlowId,
      generation: ownerId && ownerId === _generationOwner ? _generation : null,
      payload, pending: true, error: null, permanentError: false,
    };
  }

  function checkpoint(data) {
    if (!_active || TERMINAL.has(_active.payload.status)) return;
    _active.payload = {
      ..._active.payload, ...data, status: 'checkpointed',
      revision: _active.payload.revision + 1, observedAt: Date.now(), finishedAt: null,
      completeness: 'checkpoint',
    };
    queue(_active);
  }

  function finish(status, data = {}) {
    if (!_active || TERMINAL.has(_active.payload.status)) return;
    if (!TERMINAL.has(status)) throw new Error('Invalid history outcome');
    const now = Date.now();
    _active.payload = {
      ..._active.payload, ...data, status, revision: _active.payload.revision + 1,
      observedAt: now, finishedAt: now,
      completeness: status === 'won' || status === 'lost' ? 'complete' : 'checkpoint',
    };
    queue(_active).then(() => flush());
  }

  function start(data) {
    if (_changingAccount) {
      report('Account changed; history recording is paused until the game reloads');
      return;
    }
    if (!_initialized || !_tabId) {
      report('Run history is unavailable; this run may not be saved');
      return;
    }
    finish('abandoned');
    let id;
    try { id = SecureIds.create(); } catch (error) {
      report('Secure run identifiers are unavailable; this run may not be saved', error);
      return;
    }
    const now = Date.now();
    const ownerId = Backend.getUserId() || _knownOwner;
    _active = entryFor({
      ...data, id, version: 1, revision: 1, status: 'started',
      gameVersion: PATCH_NOTES[0]?.version || 'unknown',
      startedAt: now, observedAt: now, finishedAt: null, completeness: 'checkpoint',
    }, ownerId);
    if (_erasing) {
      _erasureStartedIds.add(id);
      _active.generation = null;
    }
    queue(_active);
  }

  async function bindUnassigned() {
    if (_active && !TERMINAL.has(_active.payload.status)) {
      throw new Error('Assign unassigned history from home, outside a run');
    }
    const user = Backend.getUser();
    if (!user || (!user.is_anonymous && user.id !== _guestOwner) || !Backend.isReady()) {
      throw new Error('Only the same guest flow can bind unassigned history');
    }
    await _writes;
    const ownerId = user.id;
    if (Backend.getUserId() !== ownerId) throw new Error('Account changed before history binding');
    await RunHistoryStore.bindGuestFlow(_guestFlowId, ownerId);
    if (_active?.ownerId === null) _active.ownerId = ownerId;
    notify();
    return flush();
  }

  async function pending() {
    await _writes;
    return (await RunHistoryStore.list()).filter(row => row.pending || row.erasureHold);
  }

  async function refreshGeneration(ownerId) {
    const result = await Backend.fetchHistoryGeneration(ownerId);
    if (!result.ok) throw new Error(result.error);
    if (Backend.getUserId() !== ownerId || !Backend.isReady()) throw new Error('Account changed while checking history deletion state');
    _generationOwner = ownerId;
    _generation = result.data.generation;
    try { sessionStorage.setItem(`shape_strikers_history_generation_${ownerId}`, String(_generation)); }
    catch (error) { report('History deletion state could not be cached for offline use', error); }
    return _generation;
  }

  async function resolveHeld(id, discard) {
    if (_active && !TERMINAL.has(_active.payload.status)) throw new Error('Review held history from home, outside a run');
    if (_changingAccount || _erasing || _resolvingHeld) throw new Error('History is busy; try again in a moment');
    const ownerId = Backend.getUserId();
    if (!ownerId || !Backend.isReady()) throw new Error('Connect to the account before reviewing held history');
    _resolvingHeld = true;
    try {
      await _writes;
      if (_flush) await _flush;
      const generation = discard ? null : await refreshGeneration(ownerId);
      if (ownerId !== Backend.getUserId() || !Backend.isReady()) throw new Error('Account changed while reviewing held history');
      await RunHistoryStore.resolveErasure(id, ownerId, generation, discard);
      notify();
      if (!discard) await flush();
    } finally {
      _resolvingHeld = false;
    }
  }

  function scheduleRetry() {
    if (_retryTimer) return;
    _retryTimer = setTimeout(() => {
      _retryTimer = null;
      flush();
    }, _retryDelay);
    _retryDelay = Math.min(60000, _retryDelay * 2);
  }

  async function flush(manual = false) {
    if (_erasing) return false;
    if (_flush) return _flush;
    if (!Backend.isReady() || !Backend.getUserId()) {
      if (manual && !_changingAccount && !Backend.isReady() && await Backend.init()) return false;
      report('History is pending; account connection is unavailable');
      return false;
    }
    const ownerId = Backend.getUserId();
    _flush = (async () => {
      await _writes;
      const rows = await pending();
      const own = rows.filter(row => row.ownerId === ownerId && !row.erasureHold && (manual || !row.permanentError)).slice(0, 10);
      for (const row of own) {
        if (!Backend.isReady() || Backend.getUserId() !== ownerId) break;
        if (!Number.isSafeInteger(row.generation) || row.generation < 0) {
          await RunHistoryStore.holdErasure(row.id, ownerId, row.generation);
          continue;
        }
        const result = await Backend.saveHistory(row.payload, ownerId, row.generation);
        if (result.ok) {
          const ack = result.data;
          const acknowledged = await RunHistoryStore.acknowledge(row.id, ownerId, ack.revision, ack.status);
          if (!acknowledged) {
            const current = (await RunHistoryStore.list()).find(entry => entry.id === row.id);
            if (current && !current.erasureHold && current.payload.revision === row.payload.revision) {
              await RunHistoryStore.markError(row.id, row.payload.revision, 'Server history differs from this browser checkpoint', true);
            }
          }
        } else if (result.erased) {
          await RunHistoryStore.holdErasure(row.id, ownerId, row.generation);
        } else {
          await RunHistoryStore.markError(row.id, row.payload.revision, result.error, !result.retryable);
          report(`History upload failed: ${result.error}`);
          if (result.retryable) scheduleRetry();
        }
      }
      const remaining = await pending();
      _message = remaining.length
        ? `${remaining.length} browser record(s) pending; unassigned and other-account records are not transferred`
        : 'History saved to your account';
      if (remaining.some(row => row.ownerId === ownerId && !row.erasureHold && !row.permanentError)) scheduleRetry();
      else _retryDelay = 5000;
      notify();
      return true;
    })().catch(error => {
      _storageFailed = true;
      _storageMessage = `History sync/storage failed: ${error.message}. Gameplay remains available.`;
      report(_storageMessage, error);
      return false;
    }).finally(() => { _flush = null; });
    return _flush;
  }

  async function reconcileReload() {
    const navigation = typeof performance !== 'undefined' ? performance.getEntriesByType('navigation')[0] : null;
    if (navigation?.type !== 'reload' || !_reloadRunId) return;
    const row = (await RunHistoryStore.list()).find(entry => entry.id === _reloadRunId && entry.tabId === _tabId);
    if (!row || TERMINAL.has(row.payload.status)) return;
    const payload = {
      ...row.payload, status: 'interrupted', revision: row.payload.revision + 1,
      finishedAt: row.payload.observedAt, completeness: 'checkpoint',
    };
    await RunHistoryStore.put({ ...row, payload, pending: true, error: null, permanentError: false });
  }

  function init() {
    if (_initialized) return;
    _initialized = true;
    try {
      _tabId = sessionStorage.getItem('shape_strikers_history_tab') || SecureIds.create();
      _guestFlowId = sessionStorage.getItem('shape_strikers_history_flow') || SecureIds.create();
      _knownOwner = sessionStorage.getItem('shape_strikers_history_owner');
      _guestOwner = sessionStorage.getItem('shape_strikers_history_guest_owner');
      if (_knownOwner) {
        const cached = sessionStorage.getItem(`shape_strikers_history_generation_${_knownOwner}`);
        const parsed = cached === null ? null : Number(cached);
        _generationOwner = _knownOwner;
        _generation = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
      }
      _reloadRunId = sessionStorage.getItem('shape_strikers_history_exit_run');
      sessionStorage.removeItem('shape_strikers_history_exit_run');
      sessionStorage.setItem('shape_strikers_history_tab', _tabId);
      sessionStorage.setItem('shape_strikers_history_flow', _guestFlowId);
    } catch (error) {
      _tabId = null;
      _guestFlowId = null;
      _guestOwner = null;
      _storageFailed = true;
      _storageMessage = 'Session history ownership could not be established; this run may be unsaved. Enable browser storage and reload.';
      report(_storageMessage, error);
      return;
    }
    RunHistoryStore.open().then(reconcileReload).then(() => flush()).catch(error => {
      _storageFailed = true;
      _storageMessage = `History storage is unavailable: ${error.message}. Gameplay remains available.`;
      report(_storageMessage, error);
    });
    Backend.subscribeAuth(async ({ previousId, user }) => {
      if (_changingAccount) return;
      const rememberedOwner = _active?.ownerId || _knownOwner || _guestOwner;
      const sourceId = previousId || (user?.id && rememberedOwner && rememberedOwner !== user.id ? rememberedOwner : null);
      if (sourceId && sourceId !== user?.id) {
        _changingAccount = true;
        Backend.suspendOutgoing();
        finish('interrupted');
        try {
          sessionStorage.removeItem('shape_strikers_history_flow');
          sessionStorage.removeItem('shape_strikers_history_guest_owner');
          if (user?.id) sessionStorage.setItem('shape_strikers_history_owner', user.id);
          else sessionStorage.removeItem('shape_strikers_history_owner');
        } catch (error) {
          report('History account checkpoint could not be stored', error);
        }
        await _writes;
        // A live multiplayer match keeps running on the old seat; reload once it ends.
        if (typeof Backend.whenRealtimeReleased === 'function') await Backend.whenRealtimeReleased();
        window.location.reload();
        return;
      }
      if (user?.id) {
        _knownOwner = user.id;
        try {
          sessionStorage.setItem('shape_strikers_history_owner', user.id);
          const cached = sessionStorage.getItem(`shape_strikers_history_generation_${user.id}`);
          const parsed = cached === null ? null : Number(cached);
          _generationOwner = user.id;
          _generation = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
          if (user.is_anonymous) {
            _guestOwner = user.id;
            sessionStorage.setItem('shape_strikers_history_guest_owner', user.id);
          }
        } catch (error) {
          report('History account checkpoint could not be stored', error);
        }
        try { await refreshGeneration(user.id); }
        catch (error) { report('History deletion state is unavailable; ambiguous runs will be held for review', error); }
      }
      notify();
      flush();
    });
    window.addEventListener('online', async () => {
      if (!Backend.isReady() && !_changingAccount && await Backend.init()) return;
      await flush();
    });
    window.addEventListener('pagehide', event => {
      if (event.persisted || !_active || TERMINAL.has(_active.payload.status)) return;
      try { sessionStorage.setItem('shape_strikers_history_exit_run', _active.id); } catch (error) {
        report('History interruption checkpoint could not be stored', error);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') flush();
    });
  }

  async function eraseHistory() {
    if (_active && !TERMINAL.has(_active.payload.status)) throw new Error('Delete history from home, outside a run');
    if (_changingAccount || _erasing || _resolvingHeld) throw new Error('History is busy; try again in a moment');
    const ownerId = Backend.getUserId();
    if (!ownerId || !Backend.isReady()) throw new Error('Account connection unavailable; deletion needs a connection');
    _erasing = true;
    _erasureStartedIds = new Set();
    try {
      const localRows = await RunHistoryStore.list();
      await _writes;
      if (_flush) await _flush;
      const localIds = new Set(localRows
        .filter(row => !_erasureStartedIds.has(row.id))
        .map(row => row.id));
      const result = await Backend.deleteHistory(ownerId);
      if (!result.ok) throw new Error(result.error);
      _generationOwner = ownerId;
      _generation = result.data.generation;
      try { sessionStorage.setItem(`shape_strikers_history_generation_${ownerId}`, String(_generation)); }
      catch (error) { report('History deletion state could not be cached for offline use', error); }
      const local = await RunHistoryStore.purgeOwner(ownerId, _guestFlowId, localIds, result.data.generation);
      if (_active && localIds.has(_active.id) && (_active.ownerId === ownerId || _active.ownerId === null)) _active = null;
      _message = 'Your cloud run history and earlier browser copies were deleted';
      notify();
      return { deleted: result.data.deleted, local };
    } finally {
      _erasing = false;
      _erasureStartedIds = null;
      flush();
    }
  }

  function subscribe(listener) {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
  }

  function getStatus() {
    return {
      message: _storageFailed ? _storageMessage : _changingAccount
        ? 'Account changed; history and multiplayer traffic are paused while the game reloads' : _message,
      storageFailed: _storageFailed, accountChanging: _changingAccount,
      active: Boolean(_active && !TERMINAL.has(_active.payload.status)), guestFlowId: _guestFlowId,
      canBindUnassigned: Backend.isReady() && Boolean(Backend.getUser()
        && (Backend.getUser().is_anonymous || Backend.getUserId() === _guestOwner)),
    };
  }

  return { init, start, checkpoint, finish, flush, pending, bindUnassigned, eraseHistory, resolveHeld, subscribe, getStatus };
})();
