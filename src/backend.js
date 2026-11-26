/**
 * Shape Strikers Web — Backend (Supabase)
 * Handles authentication, leaderboard submission, and leaderboard queries.
 *
 * ⚠️  SETUP REQUIRED: Replace SUPABASE_URL and SUPABASE_ANON_KEY below
 *     with your project values from https://supabase.com/dashboard
 */

const Backend = (() => {

  // ── Configuration ─────────────────────────────────────────────────────────
  const SUPABASE_URL  = 'https://onqofwapnsvxobdihunp.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ucW9md2FwbnN2eG9iZGlodW5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMTkyNzksImV4cCI6MjA5MTg5NTI3OX0.d8RUMu_WnuA8oNBl9dkgRFenEE18B8wGC4lRlDtgPFQ';

  const PLAYER_NAME_KEY = 'shape_strikers_player_name';
  const MAX_NAME_LENGTH = 20;
  const REQUEST_TIMEOUT_MS = 8000;
  const SUBMIT_COOLDOWN_MS = 5000;
  const EXPORT_PAGE = 100;

  let _supabase = null;
  let _user = null;        // auth.users record
  let _playerName = null;  // display name from localStorage (or profile)
  let _ready = false;
  let _submitInFlight = false;
  let _lastSubmitAt = 0;
  let _apiUrl = SUPABASE_URL;
  let _apiKey = SUPABASE_ANON_KEY;
  let _initPromise = null;
  let _codeVerification = null;
  const _authSubscribers = new Set();

  function _configuration() {
    const location = typeof window !== 'undefined' ? window.location : null;
    const override = typeof window !== 'undefined' ? window.SHAPE_STRIKERS_STAGING_CONFIG : null;
    const requested = location && new URLSearchParams(location.search).get('staging') === '1';
    if (!override && !requested) return { url: SUPABASE_URL, publishableKey: SUPABASE_ANON_KEY };
    if (!location || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname) || !override) {
      throw new Error('Staging backend requires localhost and explicit staging client settings');
    }
    const url = new URL(override.url);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin === SUPABASE_URL) {
      throw new Error('Invalid staging project URL; production is not an allowed staging target');
    }
    const key = override.publishableKey;
    if (typeof key !== 'string' || !key) throw new Error('Missing staging publishable key');
    if (!key.startsWith('sb_publishable_')) {
      let role;
      try { role = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role; } catch {
        throw new Error('Staging requires a browser-safe publishable key');
      }
      if (role !== 'anon') throw new Error('Privileged keys must never be used in the browser');
    }
    return { url: url.origin, publishableKey: key };
  }

  function _notifyAuth(previousId, listeners = _authSubscribers) {
    const event = { previousId, user: _user };
    for (const listener of listeners) {
      setTimeout(() => {
        Promise.resolve().then(() => listener(event)).catch(error => {
          console.error('[Backend] Account-change coordination failed:', error?.name || 'Error');
        });
      }, 0);
    }
  }

  async function _accountFetch(input, options) {
    const verification = _codeVerification;
    const url = typeof input === 'string' ? input : input.url || String(input);
    if (!verification || url !== `${_apiUrl}/auth/v1/verify`) return fetch(input, options);
    const current = () => !verification.controller.signal.aborted && _ready && _user?.id === verification.sourceId;
    if (!current()) throw new DOMException('Account verification cancelled', 'AbortError');
    const response = await fetch(input, { ...options, signal: verification.controller.signal });
    if (!current()) throw new DOMException('Account verification cancelled', 'AbortError');
    if (response.ok) {
      const body = await response.clone().json();
      const user = body.user || body;
      if (!current()) throw new DOMException('Account verification cancelled', 'AbortError');
      if (typeof user.id !== 'string' || (verification.kind === 'link' && user.id !== verification.sourceId)) {
        throw new Error('Verification did not preserve the expected guest identity');
      }
      verification.targetId = user.id;
    }
    return response;
  }

  function cancelCodeVerification() {
    if (_codeVerification && _codeVerification.targetId === _user?.id && _codeVerification.sourceId !== _user?.id) return;
    _codeVerification?.controller.abort();
  }

  // An account change mid-match (e.g. SIGNED_OUT after a failed token refresh) must not tear down
  // the live room: the reload that follows would mint a new anonymous id and the seat could not resume.
  // REST traffic stops immediately; realtime teardown waits until the match releases its hold.
  let _realtimeHold = null;
  let _realtimeSuspendDeferred = false;

  function holdRealtime() {
    if (_realtimeHold) return;
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    _realtimeHold = { promise, release };
  }

  function releaseRealtime() {
    const hold = _realtimeHold;
    if (!hold) return;
    _realtimeHold = null;
    if (_realtimeSuspendDeferred) {
      _realtimeSuspendDeferred = false;
      _suspendRealtime();
      _reloadIfUnmanaged();
    }
    hold.release();
  }

  // RunHistory (when loaded) reloads on its own; otherwise nothing would ever restore realtime.
  function _reloadIfUnmanaged() {
    if (typeof RunHistory === 'undefined' && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      setTimeout(() => window.location.reload(), 0);
    }
  }

  function whenRealtimeReleased() {
    return _realtimeHold ? _realtimeHold.promise : Promise.resolve();
  }

  function isRealtimeSuspendDeferred() {
    return _realtimeSuspendDeferred;
  }

  function suspendOutgoing() {
    _ready = false;
    cancelCodeVerification();
    if (_realtimeHold) {
      if (!_realtimeSuspendDeferred) console.warn('[Backend] Account changed mid-match; realtime stays up until the match ends.');
      _realtimeSuspendDeferred = true;
      return;
    }
    _suspendRealtime();
    _reloadIfUnmanaged();
  }

  function _suspendRealtime() {
    if (typeof SupabaseClient !== 'undefined') {
      if (typeof SupabaseClient.suspendOutgoing === 'function') SupabaseClient.suspendOutgoing();
      else SupabaseClient.leaveAll();
    }
    if (typeof Room !== 'undefined') {
      if (typeof Room.suspendOutgoing === 'function') Room.suspendOutgoing();
      else if (typeof Room.clearSavedSession === 'function') Room.clearSavedSession();
    }
  }

  function subscribeAuth(listener) {
    _authSubscribers.add(listener);
    if (_ready) _notifyAuth(null, [listener]);
    return () => _authSubscribers.delete(listener);
  }

  // ── Initialization ────────────────────────────────────────────────────────

  function init() {
    if (!_initPromise) {
      _initPromise = _initialize().then(ready => {
        if (!ready) _initPromise = null;
        return ready;
      });
    }
    return _initPromise;
  }

  async function _initialize() {
    if (SUPABASE_URL === 'YOUR_SUPABASE_URL') {
      console.warn('[Backend] Supabase not configured — leaderboards disabled.');
      return false;
    }
    if (typeof supabase === 'undefined' || !supabase.createClient) {
      console.warn('[Backend] Supabase SDK not loaded — leaderboards disabled.');
      return false;
    }
    try {
      const config = _configuration();
      _apiUrl = config.url;
      _apiKey = config.publishableKey;
      if (!_supabase) {
        _supabase = supabase.createClient(_apiUrl, _apiKey, { global: { fetch: _accountFetch } });
        _supabase.auth.onAuthStateChange((_event, session) => {
          const previousId = _user?.id || null;
          _user = session?.user || null;
          if (previousId && previousId !== _user?.id) suspendOutgoing();
          _notifyAuth(previousId);
        });
      }
      await _ensureAuth();
      _playerName = localStorage.getItem(PLAYER_NAME_KEY) || null;
      _ready = true;
      _notifyAuth(null);
      if (typeof MultiplayerTelemetry !== 'undefined' && typeof MultiplayerTelemetry.notifyBackendReady === 'function') {
        MultiplayerTelemetry.notifyBackendReady();
      }
      console.log('[Backend] Ready. User:', _user?.id?.slice(0, 8));
      return true;
    } catch (e) {
      console.error('[Backend] Init failed:', e);
      return false;
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async function _withTimeout(promise, label = 'Request') {
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

  async function _ensureAuth() {
    const { data: { session } } = await _withTimeout(_supabase.auth.getSession(), 'Session lookup');
    if (session?.user) {
      _user = session.user;
      return;
    }
    // Sign in anonymously
    const { data, error } = await _withTimeout(_supabase.auth.signInAnonymously(), 'Anonymous sign-in');
    if (error) throw error;
    _user = data.user;
  }

  function isReady()   { return _ready; }
  function getClient() { return _ready ? _supabase : null; }
  function getUser()   { return _user; }
  function getUserId() { return _user?.id || null; }

  function getPlayerName() { return _playerName; }

  function setPlayerName(name) {
    if (!name || typeof name !== 'string') return false;
    const clean = name.trim().replace(/[<>&"']/g, '').slice(0, MAX_NAME_LENGTH);
    if (clean.length < 1) return false;
    _playerName = clean;
    localStorage.setItem(PLAYER_NAME_KEY, clean);
    return true;
  }

  // ── Score Submission ──────────────────────────────────────────────────────

  /**
   * Submit a score to the leaderboard.
   * @param {Object} opts
   * @param {number} opts.score
   * @param {number} opts.waveReached
   * @param {string} opts.campaignMode   'normal' | 'void'
   * @param {string|null} opts.challengeType  'daily' | 'weekly' | null
   * @param {string|null} opts.challengeKey   '2026-04-16' or '2026-W16' | null
   * @param {number} opts.unitsUsed
   * @param {boolean} opts.won
   * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
   */
  async function submitScore(opts = {}) {
    if (!_ready || !_user) return { ok: false, error: 'Not connected' };
    if (!_playerName) return { ok: false, error: 'No player name set' };
    if (_submitInFlight) return { ok: false, error: 'Score submission already in progress' };
    if (Date.now() - _lastSubmitAt < SUBMIT_COOLDOWN_MS) {
      return { ok: false, error: 'Please wait a few seconds before submitting again' };
    }

    const campaignMode = ['normal', 'void'].includes(opts.campaignMode) ? opts.campaignMode : 'normal';
    const challengeType = ['daily', 'weekly'].includes(opts.challengeType) ? opts.challengeType : null;
    const row = {
      player_id:      _user.id,
      player_name:    _playerName,
      score:          Math.max(0, Number(opts.score) || 0),
      wave_reached:   Math.max(0, Number(opts.waveReached) || 0),
      campaign_mode:  campaignMode,
      challenge_type: challengeType,
      challenge_key:  challengeType ? (opts.challengeKey || null) : null,
      units_used:     Math.max(0, Number(opts.unitsUsed) || 0),
      won:            opts.won === true,
    };

    _submitInFlight = true;
    try {
      const { data, error } = await _withTimeout(
        _supabase.from('leaderboard').insert(row).select().single(),
        'Score submission'
      );

      if (error) {
        console.error('[Backend] Submit error:', error.message);
        return { ok: false, error: error.message };
      }
      _lastSubmitAt = Date.now();
      return { ok: true, data };
    } catch (error) {
      console.error('[Backend] Submit error:', error?.message || error);
      return { ok: false, error: error?.message || 'Submission failed' };
    } finally {
      _submitInFlight = false;
    }
  }

  // ── Leaderboard Queries ───────────────────────────────────────────────────

  /**
   * Fetch global leaderboard (top scores of all time).
   * @param {number} limit — max rows (default 50)
   * @returns {Promise<{ok: boolean, rows?: Array, error?: string}>}
   */
  async function fetchGlobal(limit = 10) {
    if (!_ready) return { ok: false, error: 'Not connected' };

    try {
      const { data, error } = await _withTimeout(
        _supabase
          .from('leaderboard')
          .select('player_name, score, wave_reached, campaign_mode, won, created_at')
          .is('challenge_type', null)
          .order('score', { ascending: false })
          .limit(limit),
        'Global leaderboard fetch'
      );

      if (error) return { ok: false, error: error.message };
      return { ok: true, rows: data };
    } catch (error) {
      return { ok: false, error: error?.message || 'Leaderboard fetch failed' };
    }
  }

  /**
   * Fetch leaderboard filtered by campaign mode.
   * @param {'normal'|'void'} mode
   * @param {number} limit
   * @returns {Promise<{ok: boolean, rows?: Array, error?: string}>}
   */
  async function fetchByMode(mode, limit = 10) {
    if (!_ready) return { ok: false, error: 'Not connected' };
    if (!['normal', 'void'].includes(mode)) return { ok: false, error: 'Invalid mode' };

    try {
      const { data, error } = await _withTimeout(
        _supabase
          .from('leaderboard')
          .select('player_name, score, wave_reached, won, created_at')
          .eq('campaign_mode', mode)
          .is('challenge_type', null)
          .order('score', { ascending: false })
          .limit(limit),
        'Mode leaderboard fetch'
      );

      if (error) return { ok: false, error: error.message };
      return { ok: true, rows: data };
    } catch (error) {
      return { ok: false, error: error?.message || 'Leaderboard fetch failed' };
    }
  }

  /**
   * Fetch challenge leaderboard (daily or weekly).
   * @param {'daily'|'weekly'} challengeType
   * @param {string} challengeKey — e.g. '2026-04-16' or '2026-W16'
   * @param {number} limit
   * @returns {Promise<{ok: boolean, rows?: Array, error?: string}>}
   */
  async function fetchChallenge(challengeType, challengeKey, limit = 50) {
    if (!_ready) return { ok: false, error: 'Not connected' };
    if (!['daily', 'weekly'].includes(challengeType)) return { ok: false, error: 'Invalid challenge type' };

    try {
      const { data, error } = await _withTimeout(
        _supabase
          .from('leaderboard')
          .select('player_name, score, wave_reached, won, created_at')
          .eq('challenge_type', challengeType)
          .eq('challenge_key', challengeKey)
          .order('score', { ascending: false })
          .limit(limit),
        'Challenge leaderboard fetch'
      );

      if (error) return { ok: false, error: error.message };
      return { ok: true, rows: data };
    } catch (error) {
      return { ok: false, error: error?.message || 'Challenge fetch failed' };
    }
  }

  /**
   * Fetch personal best scores.
   * @param {number} limit
   * @returns {Promise<{ok: boolean, rows?: Array, error?: string}>}
   */
  async function fetchPersonal(limit = 20) {
    if (!_ready || !_user) return { ok: false, error: 'Not connected' };

    try {
      const { data, error } = await _withTimeout(
        _supabase
          .from('leaderboard')
          .select('score, wave_reached, campaign_mode, challenge_type, won, created_at')
          .eq('player_id', _user.id)
          .order('score', { ascending: false })
          .limit(limit),
        'Personal leaderboard fetch'
      );

      if (error) return { ok: false, error: error.message };
      return { ok: true, rows: data };
    } catch (error) {
      return { ok: false, error: error?.message || 'Personal fetch failed' };
    }
  }

  async function _sourceRequest(route, body, ownerId, method = 'POST') {
    if (!_ready || !ownerId) return { ok: false, error: 'Account connection unavailable', retryable: true };
    try {
      const { data, error } = await _withTimeout(_supabase.auth.getSession(), 'Source session lookup');
      if (error) throw error;
      const session = data.session;
      if (!session || session.user.id !== ownerId || _user?.id !== ownerId || !_ready) {
        return { ok: false, error: 'Source account does not match the current account', retryable: false };
      }
      // Pin the source session token: a concurrent account switch must not reassign a queued run.
      const response = await _withTimeout(fetch(`${_apiUrl}/${route}`, {
        method,
        headers: { apikey: _apiKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }), 'Source-bound request');
      const result = await response.json();
      if (!_ready || _user?.id !== ownerId) {
        return { ok: false, error: 'Account changed during the request; history sources remain separate', retryable: true };
      }
      if (!response.ok) {
        const message = [result?.message, result?.msg, result?.error_description].find(value => typeof value === 'string');
        return {
          ok: false, error: message || 'Account request failed',
          retryable: response.status >= 500 || [401, 408, 429].includes(response.status),
          erased: result?.hint === 'history_erased',
        };
      }
      return { ok: true, data: result };
    } catch (error) {
      console.warn('[Backend] Source-bound request failed:', error?.name || 'Error');
      return { ok: false, error: 'Account connection failed; retry when online', retryable: true };
    }
  }

  async function fetchHistoryGeneration(ownerId = getUserId()) {
    const result = await _sourceRequest('rest/v1/rpc/get_run_history_generation', {}, ownerId);
    if (result.ok && (result.data?.ownerId !== ownerId || !Number.isSafeInteger(result.data?.generation)
      || result.data.generation < 0)) {
      return { ok: false, error: 'History deletion state does not match this account', retryable: false };
    }
    return result;
  }

  async function saveHistory(snapshot, ownerId, generation) {
    const result = await _sourceRequest('rest/v1/rpc/save_run_history', { snapshot, expected_generation: generation }, ownerId);
    if (result.ok && (result.data.id !== snapshot.id || result.data.ownerId !== ownerId)) {
      return { ok: false, error: 'History acknowledgment does not match its source', retryable: false };
    }
    return result;
  }

  function fetchHistory({ cursor = null, mode = 'all', includeTests = false } = {}) {
    return _sourceRequest('rest/v1/rpc/list_run_history', {
      page_size: 20, before_created_at: cursor?.createdAt || null, before_id: cursor?.id || null,
      mode_filter: mode, include_tests: includeTests,
    }, getUserId());
  }

  function fetchHistoryTotals() {
    return _sourceRequest('rest/v1/rpc/run_history_totals', {}, getUserId());
  }

  function fetchHistoryDetail(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
      console.warn('[Backend] Invalid history detail identifier');
      return Promise.resolve({ ok: false, error: 'Invalid run identifier' });
    }
    return _sourceRequest(`rest/v1/run_history?select=payload&id=eq.${encodeURIComponent(id)}`, null, getUserId(), 'GET');
  }

  async function exportHistory() {
    const ownerId = getUserId();
    const records = [];
    const columns = 'id,revision,status,campaign_mode,challenge_type,started_at,created_at,updated_at,finalized_at,payload';
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const result = await _sourceRequest(
        `rest/v1/run_history?select=${columns}&order=created_at.asc,id.asc&limit=${EXPORT_PAGE}&offset=${offset}`,
        null, ownerId, 'GET',
      );
      if (!result.ok) return result;
      if (!Array.isArray(result.data)) return { ok: false, error: 'Invalid history export response', retryable: false };
      records.push(...result.data);
      if (result.data.length < EXPORT_PAGE) break;
    }
    return {
      ok: true,
      data: { format: 'shape-strikers-run-history', version: 1, accountId: ownerId, exportedAt: new Date().toISOString(), records },
    };
  }

  async function deleteHistory(ownerId = getUserId()) {
    if (!_accountActionAllowed()) {
      return { ok: false, error: 'Delete history from home, outside a run, with no code verification pending', retryable: false };
    }
    const result = await _sourceRequest('rest/v1/rpc/delete_my_run_history', {}, ownerId);
    if (result.ok && (result.data?.ownerId !== ownerId || !Number.isSafeInteger(result.data.generation)
      || result.data.generation < 1)) {
      return { ok: false, error: 'Deletion acknowledgment does not match this account', retryable: false };
    }
    return result;
  }

  function _accountActionAllowed() {
    return _ready && _user && !_codeVerification && !(typeof RunHistory !== 'undefined' && RunHistory.getStatus().active);
  }

  async function requestLinkEmail(email) {
    if (!_accountActionAllowed() || !_user.is_anonymous) return { ok: false, error: 'Link a guest account from the home screen, outside a run' };
    const sourceId = getUserId();
    const result = await _sourceRequest('auth/v1/user', { email }, sourceId, 'PUT');
    if (result.ok && result.data.id !== sourceId) {
      suspendOutgoing();
      return { ok: false, error: 'Guest identity changed unexpectedly; reload before continuing' };
    }
    return result.ok ? { ok: true } : result;
  }

  async function requestExistingAccount(email, confirmed) {
    if (!_accountActionAllowed() || confirmed !== true) return { ok: false, error: 'Confirm account switching outside a run; guest history will not transfer' };
    try {
      const { error } = await _withTimeout(_supabase.auth.signInWithOtp({
        email, options: { shouldCreateUser: false },
      }), 'Account sign-in');
      return error ? { ok: false, error: error.message } : { ok: true };
    } catch {
      return { ok: false, error: 'Account sign-in request failed; check your connection' };
    }
  }

  async function verifyAccountCode({ email, token, kind, sourceId }) {
    if (!_accountActionAllowed() || !['link', 'existing'].includes(kind) || getUserId() !== sourceId) {
      return { ok: false, error: 'Account changed or a run is active; request a new code from the home screen' };
    }
    const verification = { controller: new AbortController(), sourceId, kind, targetId: null };
    _codeVerification = verification;
    const timer = setTimeout(() => verification.controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const { data, error } = await _supabase.auth.verifyOtp({
        email, token, type: kind === 'link' ? 'email_change' : 'email',
      });
      if (verification.controller.signal.aborted) return { ok: false, error: 'Code verification cancelled or timed out; request a new code if needed' };
      if (error) return { ok: false, error: error.message };
      if (kind === 'link' && data.user?.id !== sourceId) {
        suspendOutgoing();
        return { ok: false, error: 'Guest identity changed unexpectedly; reload before continuing' };
      }
      if (kind === 'link') {
        _user = data.user;
        _notifyAuth(sourceId);
      }
      return { ok: true };
    } catch {
      return { ok: false, error: verification.controller.signal.aborted
        ? 'Code verification cancelled or timed out; request a new code if needed'
        : 'Code verification failed; check your connection or request a new code' };
    } finally {
      clearTimeout(timer);
      if (_codeVerification === verification) _codeVerification = null;
    }
  }
  // ── Public API ────────────────────────────────────────────────────────────

  return {
    init,
    isReady,
    getClient,
    getUser,
    getUserId,
    getPlayerName,
    setPlayerName,
    submitScore,
    fetchGlobal,
    fetchByMode,
    fetchChallenge,
    fetchPersonal,
    subscribeAuth,
    suspendOutgoing,
    holdRealtime,
    releaseRealtime,
    whenRealtimeReleased,
    isRealtimeSuspendDeferred,
    saveHistory,
    fetchHistoryGeneration,
    fetchHistory,
    fetchHistoryTotals,
    fetchHistoryDetail,
    exportHistory,
    deleteHistory,
    requestLinkEmail,
    requestExistingAccount,
    verifyAccountCode,
    cancelCodeVerification,
  };
})();
