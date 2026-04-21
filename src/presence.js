/**
 * Shape Strikers Web — Presence (Supabase Realtime)
 *
 * Tracks concurrent online players via Supabase Realtime Presence.
 * Lifecycle (connect / reconnect / visibility-reconnect) is fully owned by
 * SupabaseClient — this module just registers handlers and reads state.
 *
 * Public API:
 *   Presence.init()                  → fire-and-forget safe
 *   Presence.getOnlineCount()        → number of connected players
 *   Presence.onCountChange(fn)       → subscribe: fn(count)
 *   Presence.offCountChange(fn)      → unsubscribe
 *   Presence.destroy()               → leave channel, clear listeners
 *
 * Load order: after supabaseClient.js, before game.js
 */

const Presence = (() => {

  const CHANNEL_NAME = 'presence:online';

  let _count     = 0;
  let _listeners = [];
  let _playerId  = null;  // stable for the session; computed once in init()

  const _VERSION = (() => {
    try { return (typeof PATCH_NOTES !== 'undefined' && PATCH_NOTES[0]?.version) || '0.9.2'; }
    catch (_) { return '0.9.2'; }
  })();

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _emit() {
    _listeners.forEach(fn => { try { fn(_count); } catch (_) {} });
  }

  function _syncCount() {
    const ch = (typeof SupabaseClient !== 'undefined') && SupabaseClient.getChannel(CHANNEL_NAME);
    if (!ch) { _count = 0; _emit(); return; }
    const state = ch.presenceState();
    _count = Object.keys(state).length;
    _emit();
  }

  // ── Channel callbacks (passed to SupabaseClient) ──────────────────────────

  function _setupListeners(ch) {
    ch.on('presence', { event: 'sync' },  () => _syncCount())
      .on('presence', { event: 'join' },  () => _syncCount())
      .on('presence', { event: 'leave' }, () => _syncCount());
  }

  async function _onSubscribed(ch) {
    // Track this client in the presence channel.
    await ch.track({ playerId: _playerId, version: _VERSION });
    _syncCount();
    console.log(`[Presence] Tracking — playerId: ${_playerId.slice(0, 8)}…`);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function getOnlineCount() { return _count; }

  function onCountChange(fn) {
    if (typeof fn === 'function' && !_listeners.includes(fn)) _listeners.push(fn);
  }

  function offCountChange(fn) {
    _listeners = _listeners.filter(l => l !== fn);
  }

  /**
   * Register the presence channel. Idempotent.
   * SupabaseClient.init() will connect it once the Backend is ready.
   */
  function init() {
    if (typeof SupabaseClient === 'undefined') {
      console.warn('[Presence] SupabaseClient not loaded — online count disabled.');
      return;
    }

    // Compute a stable player ID once — reused on every reconnect so our own
    // presence slot doesn't drift and inflate the count.
    if (!_playerId) {
      _playerId = (typeof Backend !== 'undefined' && Backend.getUserId())
        || (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    }

    SupabaseClient.joinChannel(CHANNEL_NAME, _setupListeners, _onSubscribed);
  }

  function destroy() {
    if (typeof SupabaseClient !== 'undefined') SupabaseClient.leaveChannel(CHANNEL_NAME);
    _listeners = [];
    _count     = 0;
  }

  return { init, getOnlineCount, onCountChange, offCountChange, destroy };

})();
