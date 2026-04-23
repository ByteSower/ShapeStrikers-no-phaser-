/**
 * Shape Strikers Web — SupabaseClient
 *
 * Singleton channel registry for Supabase Realtime.
 * Owns the connect / reconnect / visibility-based-reconnect lifecycle so
 * individual feature modules (Presence, GlobalChat) stay stateless and simple.
 *
 * NOTE: URL and anon key are configured in backend.js. This module delegates
 * to Backend.getClient() so only one Supabase client instance ever exists.
 * In a browser-only vanilla JS project there is no process.env — configuration
 * lives in backend.js, which is the natural boundary for secrets/config.
 *
 * Public API:
 *   SupabaseClient.init()
 *     Async. Polls until Backend is ready, then drains any queued channels.
 *     Safe to call fire-and-forget. Returns true/false.
 *
 *   SupabaseClient.getClient()
 *     Returns the Supabase JS client (or null if Backend not ready).
 *
 *   SupabaseClient.joinChannel(name, setupFn, onSubscribed?)
 *     Register a channel. setupFn(ch) is called with the new channel object
 *     BEFORE subscribe() so callers can attach .on() listeners. onSubscribed(ch)
 *     is called each time the channel reaches SUBSCRIBED status (incl. reconnects).
 *     Idempotent — safe to call multiple times with the same name.
 *
 *   SupabaseClient.leaveChannel(name)
 *     Unsubscribe and remove the channel.
 *
 *   SupabaseClient.leaveAll()
 *     Unsubscribe all channels (e.g. on app unload).
 *
 *   SupabaseClient.getChannel(name)
 *     Returns the current channel object (refreshed after reconnects).
 *
 *   SupabaseClient.getChannelStatus(name)
 *     Returns the tracked Realtime status string for a channel.
 *
 *   SupabaseClient.reconnectChannel(name)
 *     Forces an immediate reconnect attempt for an already-registered channel.
 *
 *   SupabaseClient.broadcast(channelName, event, payload)
 *     Async. Sends a broadcast message. Returns { ok, error? }.
 *
 * Load order: after backend.js, before presence.js / globalChat.js
 */

const SupabaseClient = (() => {

  // ── State ─────────────────────────────────────────────────────────────────

  // Registry entry shape:
  //   { channel, status, retryCount, retryTimer, setupFn, onSubscribed }
  const _channels = new Map();

  // Channels registered before init() completes are queued here.
  const _pending   = new Map();

  let _ready = false;

  const MAX_RETRIES    = 6;
  const BASE_RETRY_MS  = 2000;   // first retry after 2 s; doubles each time, cap 30 s

  // ── Client access ─────────────────────────────────────────────────────────

  /** Returns the Supabase JS client singleton, or null if Backend not yet ready. */
  function getClient() {
    return (typeof Backend !== 'undefined') ? Backend.getClient() : null;
  }

  // ── Connect / reconnect ───────────────────────────────────────────────────

  function _connect(name) {
    const client = getClient();
    const entry  = _channels.get(name);
    if (!entry || !client) return;

    // Clean up any existing subscription cleanly before reconnecting.
    if (entry.channel) {
      try { entry.channel.unsubscribe(); } catch (_) {}
    }

    const ch = client.channel(name);
    entry.channel = ch;
    entry.status  = 'pending';

    // Let the caller attach .on() handlers before we subscribe.
    if (entry.setupFn) entry.setupFn(ch);

    ch.subscribe((status) => {
      entry.status = status;
      if (status === 'SUBSCRIBED') {
        entry.retryCount = 0;
        if (entry.onSubscribed) entry.onSubscribed(ch);
        console.info(`[SupabaseClient] Connected: ${name}`);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[SupabaseClient] ${status} on channel "${name}" — will retry.`);
        _scheduleReconnect(name);
      } else if (status === 'CLOSED') {
        console.info(`[SupabaseClient] Closed: ${name}`);
      }
    });
  }

  function _scheduleReconnect(name) {
    const entry = _channels.get(name);
    if (!entry) return;
    clearTimeout(entry.retryTimer);
    if (entry.retryCount >= MAX_RETRIES) {
      console.warn(`[SupabaseClient] "${name}" — gave up after ${MAX_RETRIES} retries.`);
      return;
    }
    const delay = Math.min(BASE_RETRY_MS * Math.pow(2, entry.retryCount), 30_000);
    entry.retryCount++;
    console.info(`[SupabaseClient] Reconnecting "${name}" in ${delay}ms (attempt ${entry.retryCount})`);
    entry.retryTimer = setTimeout(() => _connect(name), delay);
  }

  // ── Visibility-based reconnect ────────────────────────────────────────────

  function _onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    for (const [name, entry] of _channels) {
      if (entry.status !== 'SUBSCRIBED') {
        console.info(`[SupabaseClient] Tab visible — reconnecting: ${name}`);
        entry.retryCount = 0;  // reset backoff so reconnect is immediate
        _connect(name);
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Async init — polls until Backend is ready, then drains the pending queue.
   * All feature modules call joinChannel() as fire-and-forget; if SupabaseClient
   * is not ready yet the channel is queued and connected once init() completes.
   */
  async function init() {
    if (_ready) return true;

    const MAX_WAIT_MS = 12_000;
    const POLL_MS     = 250;
    let waited = 0;
    while (waited < MAX_WAIT_MS) {
      if (typeof Backend !== 'undefined' && Backend.isReady() && Backend.getClient()) {
        _ready = true;
        break;
      }
      await new Promise(r => setTimeout(r, POLL_MS));
      waited += POLL_MS;
    }

    if (!_ready) {
      console.warn('[SupabaseClient] Backend unavailable after timeout — realtime disabled.');
      _pending.clear();
      return false;
    }

    // Drain channels that were registered before we were ready.
    for (const [name, { setupFn, onSubscribed }] of _pending) {
      const entry = { channel: null, status: 'pending', retryCount: 0, retryTimer: null, setupFn, onSubscribed };
      _channels.set(name, entry);
      _connect(name);
    }
    _pending.clear();

    document.addEventListener('visibilitychange', _onVisibilityChange);
    console.log('[SupabaseClient] Ready.');
    return true;
  }

  /**
   * Register a Realtime channel.
   * @param {string}   name          — Channel name, e.g. "presence:online"
   * @param {function} setupFn       — Called with (channel) to attach .on() listeners
   * @param {function} [onSubscribed]— Called with (channel) each time SUBSCRIBED fires
   */
  function joinChannel(name, setupFn, onSubscribed) {
    if (_channels.has(name)) return; // already tracked
    if (!_ready) {
      _pending.set(name, { setupFn, onSubscribed: onSubscribed || null });
      return;
    }
    const entry = { channel: null, status: 'pending', retryCount: 0, retryTimer: null, setupFn, onSubscribed: onSubscribed || null };
    _channels.set(name, entry);
    _connect(name);
  }

  /**
   * Unsubscribe and remove a channel.
   * @param {string} name
   */
  function leaveChannel(name) {
    _pending.delete(name);
    const entry = _channels.get(name);
    if (!entry) return;
    clearTimeout(entry.retryTimer);
    try { entry.channel?.unsubscribe(); } catch (_) {}
    _channels.delete(name);
  }

  /** Unsubscribe all channels (call on app unload). */
  function leaveAll() {
    for (const name of [..._channels.keys()]) leaveChannel(name);
    _pending.clear();
  }

  /**
   * Returns the current channel object (updated after reconnects).
   * @param {string} name
   * @returns {object|null}
   */
  function getChannel(name) {
    return _channels.get(name)?.channel || null;
  }

  /** Returns the tracked Realtime status for a channel. */
  function getChannelStatus(name) {
    if (_channels.has(name)) return _channels.get(name)?.status || 'pending';
    if (_pending.has(name)) return 'pending';
    return 'closed';
  }

  /** Force an immediate reconnect for an existing channel registration. */
  function reconnectChannel(name) {
    const entry = _channels.get(name);
    if (!entry) return false;
    clearTimeout(entry.retryTimer);
    entry.retryCount = 0;
    _connect(name);
    return true;
  }

  /**
   * Send a Realtime Broadcast message.
   * @param {string} channelName
   * @param {string} event
   * @param {object} payload
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function broadcast(channelName, event, payload) {
    const entry = _channels.get(channelName);
    if (!entry?.channel) return { ok: false, error: 'Channel not found' };
    if (entry.status !== 'SUBSCRIBED') return { ok: false, error: 'Channel not ready' };
    try {
      await entry.channel.send({ type: 'broadcast', event, payload });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'Broadcast failed' };
    }
  }

  return { init, getClient, joinChannel, leaveChannel, leaveAll, getChannel, getChannelStatus, reconnectChannel, broadcast };

})();
