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

  let _supabase = null;
  let _user = null;        // auth.users record
  let _playerName = null;  // display name from localStorage (or profile)
  let _ready = false;
  let _submitInFlight = false;
  let _lastSubmitAt = 0;

  // ── Initialization ────────────────────────────────────────────────────────

  async function init() {
    if (SUPABASE_URL === 'YOUR_SUPABASE_URL') {
      console.warn('[Backend] Supabase not configured — leaderboards disabled.');
      return false;
    }
    if (typeof supabase === 'undefined' || !supabase.createClient) {
      console.warn('[Backend] Supabase SDK not loaded — leaderboards disabled.');
      return false;
    }
    try {
      _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      await _ensureAuth();
      _playerName = localStorage.getItem(PLAYER_NAME_KEY) || null;
      _ready = true;
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

  function isReady() { return _ready; }
  function getUser() { return _user; }

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
  async function fetchGlobal(limit = 50) {
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

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    init,
    isReady,
    getUser,
    getPlayerName,
    setPlayerName,
    submitScore,
    fetchGlobal,
    fetchChallenge,
    fetchPersonal,
  };
})();
