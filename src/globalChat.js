/**
 * Shape Strikers Web — Global Chat
 *
 * Real-time global chat via Supabase Realtime Broadcast on "chat:global".
 * Non-blocking: init() is async and never stalls the game loop.
 * Degrades gracefully if Supabase is unavailable.
 *
 * Security:
 *   - All user text is stored raw (length-capped, control chars stripped).
 *   - Rendering MUST use textContent (never innerHTML) — enforced in the UI layer.
 *   - Rate-limited to one message per 2 s client-side.
 *
 * Message schema: { id, playerId, playerName, text, timestamp }
 *
 * Public API:
 *   GlobalChat.init()                → async, fire-and-forget safe
 *   GlobalChat.sendMessage(text)     → { ok, error? }
 *   GlobalChat.getMessages()         → snapshot of the message buffer
 *   GlobalChat.onMessage(fn)         → subscribe: fn(msg)
 *   GlobalChat.offMessage(fn)        → unsubscribe
 *   GlobalChat.isReady()             → boolean
 *   GlobalChat.destroy()             → leave channel, clear listeners
 *
 * Load order: after supabaseClient.js, before game.js
 */

const GlobalChat = (() => {

  // ── Constants ─────────────────────────────────────────────────────────────

  const CHANNEL_NAME   = 'chat:global';
  const MAX_MESSAGES   = 50;      // messages kept in memory / rendered
  const RATE_LIMIT_MS  = 2_000;   // minimum gap between sends
  const MAX_TEXT_LEN   = 200;
  const MAX_NAME_LEN   = 20;

  // ── State ─────────────────────────────────────────────────────────────────

  let _ready      = false;
  let _messages   = [];          // { id, playerId, playerName, text, timestamp }
  let _listeners  = [];          // message-event subscribers
  let _lastSentAt = 0;

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Strip ASCII control chars and trim to length. Safe for display via textContent. */
  function _clean(str, maxLen) {
    return String(str).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLen);
  }

  function _emit(msg) {
    _listeners.forEach(fn => { try { fn(msg); } catch (_) {} });
  }

  // ── Channel setup (passed to SupabaseClient.joinChannel) ──────────────────

  /** Attach broadcast listener. Called with fresh channel object on every connect/reconnect. */
  function _setupChannel(ch) {
    ch.on('broadcast', { event: 'message' }, ({ payload }) => {
      _handleIncoming(payload);
    });
  }

  /**
   * Validate and store an incoming broadcast payload.
   * Callers (including local optimistic sends) go through this path so the
   * buffer and listener notifications are always consistent.
   */
  function _handleIncoming(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.id !== 'string' || !payload.id) return;
    if (typeof payload.text !== 'string' || !payload.text) return;
    if (typeof payload.playerId !== 'string') return;

    const msg = {
      id:         _clean(payload.id,         64),
      playerId:   _clean(payload.playerId,    36),
      playerName: _clean(String(payload.playerName || 'Anonymous'), MAX_NAME_LEN),
      text:       _clean(payload.text,        MAX_TEXT_LEN),
      timestamp:  Number.isFinite(payload.timestamp) ? payload.timestamp : Date.now(),
    };

    // Deduplicate by id (optimistic local send may already have pushed this).
    if (_messages.some(m => m.id === msg.id)) return;

    _messages.push(msg);
    if (_messages.length > MAX_MESSAGES) _messages.shift();
    _emit(msg);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Start the chat channel. Idempotent — safe to call multiple times.
   * @returns {Promise<boolean>}
   */
  async function init() {
    if (_ready) return true;
    if (typeof SupabaseClient === 'undefined') {
      console.warn('[GlobalChat] SupabaseClient not loaded — chat disabled.');
      return false;
    }

    // joinChannel queues internally if SupabaseClient.init() hasn't finished yet.
    SupabaseClient.joinChannel(CHANNEL_NAME, _setupChannel);

    _ready = true;
    console.log('[GlobalChat] Channel registered:', CHANNEL_NAME);
    return true;
  }

  /**
   * Send a chat message. Rate-limited.
   * @param {string} text
   * @returns {{ ok: boolean, error?: string }}
   */
  function sendMessage(text) {
    if (!_ready || typeof SupabaseClient === 'undefined') {
      return { ok: false, error: 'Chat not ready' };
    }

    const now = Date.now();
    if (now - _lastSentAt < RATE_LIMIT_MS) {
      return { ok: false, error: 'Rate limited' };
    }

    const cleaned = _clean(text, MAX_TEXT_LEN);
    if (!cleaned) return { ok: false, error: 'Empty message' };

    const playerId   = (typeof Backend !== 'undefined' && Backend.getUserId())     || 'anon';
    const playerName = (typeof Backend !== 'undefined' && Backend.getPlayerName()) || 'Anonymous';

    const msg = {
      id:         `${playerId.slice(0, 8)}-${now}`,
      playerId,
      playerName: _clean(playerName, MAX_NAME_LEN),
      text:       cleaned,
      timestamp:  now,
    };

    _lastSentAt = now;

    // Optimistically add to local buffer immediately for snappy UX.
    _handleIncoming(msg);

    // Broadcast to all other connected clients (fire-and-forget).
    SupabaseClient.broadcast(CHANNEL_NAME, 'message', msg)
      .then(result => {
        if (!result.ok) console.warn('[GlobalChat] Broadcast failed:', result.error);
      });

    return { ok: true };
  }

  /** Snapshot of the current message buffer (newest last). */
  function getMessages() { return [..._messages]; }

  /** Subscribe to new messages. fn(msg) is called for every incoming message. */
  function onMessage(fn) {
    if (typeof fn === 'function' && !_listeners.includes(fn)) _listeners.push(fn);
  }

  /** Unsubscribe a previously registered listener. */
  function offMessage(fn) {
    _listeners = _listeners.filter(l => l !== fn);
  }

  /** Whether the channel has been registered. */
  function isReady() { return _ready; }

  /** Disconnect and clean up. */
  function destroy() {
    if (typeof SupabaseClient !== 'undefined') SupabaseClient.leaveChannel(CHANNEL_NAME);
    _listeners = [];
    _ready     = false;
    _messages  = [];
  }

  return { init, sendMessage, getMessages, onMessage, offMessage, isReady, destroy };

})();
