/**
 * Shape Strikers Web — Audio Manager
 * Handles background music and sound effects.
 */

const Audio = (() => {
  const BASE = 'public/Audio/';
  const RETRIABLE_SFX = new Set(['getReady', 'objective', 'letsGo', 'gameOver', 'newHighScore', 'cry']);
  const AUDIO_UNLOCK_EVENTS = ['pointerdown', 'touchstart', 'click', 'keydown'];

  // ── Sound pools (for random selection) ────────────────────────────────────
  const SFX = {
    attack:       ['07_human_atk_sword_1.wav', '07_human_atk_sword_2.wav', '07_human_atk_sword_3.wav'],
    hit:          ['26_sword_hit_1.wav', '26_sword_hit_2.wav', '26_sword_hit_3.wav'],
    ability:      ['10_human_special_atk_1.wav', '10_human_special_atk_2.wav'],
    death:        ['14_human_death_spin.wav'],
    enemyDeath:   ['24_orc_death_spin.wav'],
    place:        ['01_chest_open_1.wav', '01_chest_open_2.wav'],
    buy:          ['04_sack_open_1.wav', '04_sack_open_2.wav'],
    sell:         ['02_chest_close_1.wav', '02_chest_close_2.wav'],
    move:         ['16_human_walk_stone_1.wav', '16_human_walk_stone_2.wav'],
    waveStart:    ['08_human_charge_1.wav'],
    waveClear:    ['completion_1.wav', 'completion_2.wav', 'completion_3.wav'],
    gameOver:     ['game_over.wav'],
    miss:         ['27_sword_miss_1.wav', '27_sword_miss_2.wav'],
    damage:       ['11_human_damage_1.wav', '11_human_damage_2.wav', '11_human_damage_3.wav'],
    getReady:     ['get_ready.wav'],
    enemySpotted: ['enemy_spotted.wav'],
    objective:    ['objective_complete.wav'],
    letsGo:       ['lets_go.wav'],
    newHighScore: ['new_high_score.wav'],
    cry:          ['cry.wav'],
  };

  // Gameplay BGM tracks — randomly rotated while playing (short loops)
  const _gameplayTracks = ['SS_Music_2.wav', 'SS_Music_3.wav'];

  let _musicEl  = null;  // current Audio object for BGM
  let _sfxVol   = 0.35;
  let _musicVol = 0.25;
  let _muted    = false;
  let _desiredMusic = null;
  let _musicRetryPending = false;
  let _musicRequestId = 0;
  let _unlockListenersBound = false;

  // Cache of pre-created Audio objects for faster playback
  const _cache = {};
  const _activeSfx = new Set();
  const _pendingSfxKeys = new Set();

  function _clampVolume(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
  }

  function _isPromiseLike(value) {
    return !!value && typeof value.then === 'function' && typeof value.catch === 'function';
  }

  function _createAudio(src = '') {
    const audio = new window.Audio(src);
    if ('preload' in audio) audio.preload = 'auto';
    if ('playsInline' in audio) audio.playsInline = true;
    audio.setAttribute?.('playsinline', '');
    return audio;
  }

  function _stopCurrentMusicElement() {
    if (!_musicEl) return;
    _musicEl.pause?.();
    _musicEl.currentTime = 0;
    _musicEl.removeAttribute?.('src');
    try { _musicEl.load?.(); } catch (_) {}
    _musicEl = null;
  }

  function _pickGameplayTrack() {
    return _gameplayTracks[Math.floor(Math.random() * _gameplayTracks.length)];
  }

  function _makeMusicElement(descriptor) {
    const src = descriptor.kind === 'gameplay'
      ? BASE + _pickGameplayTrack()
      : BASE + descriptor.file;
    const musicEl = _createAudio(src);
    musicEl.loop = descriptor.kind !== 'gameplay';
    musicEl.volume = _muted ? 0 : _musicVol;
    if (descriptor.kind === 'gameplay') {
      musicEl.addEventListener('ended', () => {
        if (_desiredMusic?.kind === 'gameplay') _playDesiredMusic();
      }, { once: true });
    }
    return musicEl;
  }

  function _playDesiredMusic() {
    if (!_desiredMusic) return;

    const requestId = ++_musicRequestId;
    _musicRetryPending = false;
    _stopCurrentMusicElement();

    const musicEl = _makeMusicElement(_desiredMusic);
    _musicEl = musicEl;

    const playResult = musicEl.play?.();
    if (!_isPromiseLike(playResult)) return;

    playResult.then(() => {
      if (requestId !== _musicRequestId || _musicEl !== musicEl) return;
      _musicRetryPending = false;
    }).catch(() => {
      if (requestId !== _musicRequestId || _musicEl !== musicEl) return;
      _musicRetryPending = true;
    });
  }

  function _cleanupSfxInstance(snd) {
    _activeSfx.delete(snd);
  }

  function _stopActiveSfx() {
    for (const snd of Array.from(_activeSfx)) {
      try {
        snd.pause?.();
        snd.currentTime = 0;
      } catch (_) {}
    }
    _activeSfx.clear();
  }

  function _flushPendingAudio() {
    if (_muted) return;

    if (_musicRetryPending && _desiredMusic) {
      _playDesiredMusic();
    }

    if (_pendingSfxKeys.size === 0) return;
    const keys = Array.from(_pendingSfxKeys);
    _pendingSfxKeys.clear();
    keys.forEach((key) => play(key));
  }

  function _bindUnlockListeners() {
    if (_unlockListenersBound) return;
    _unlockListenersBound = true;
    const target = (typeof document !== 'undefined' && document?.addEventListener)
      ? document
      : (typeof window !== 'undefined' ? window : null);
    if (!target?.addEventListener) return;
    AUDIO_UNLOCK_EVENTS.forEach((eventName) => {
      target.addEventListener(eventName, _flushPendingAudio, { passive: true });
    });
  }

  // ── Initialise ────────────────────────────────────────────────────────────

  function init() {
    // Restore mute state
    _muted = localStorage.getItem('shape_strikers_muted') === '1';
    _sfxVol = _clampVolume(localStorage.getItem('shape_strikers_sfx_vol'), 0.35);
    _musicVol = _clampVolume(localStorage.getItem('shape_strikers_music_vol'), 0.25);
    _bindUnlockListeners();
  }

  // ── Background music ─────────────────────────────────────────────────────

  function playMusic(file) {
    _desiredMusic = { kind: 'file', file };
    _playDesiredMusic();
  }

  function stopMusic() {
    _desiredMusic = null;
    _musicRetryPending = false;
    _stopCurrentMusicElement();
  }

  function setMusicVolume(v) {
    _musicVol = Math.max(0, Math.min(1, v));
    if (_musicEl) _musicEl.volume = _muted ? 0 : _musicVol;
    localStorage.setItem('shape_strikers_music_vol', _musicVol);
  }

  // ── SFX ───────────────────────────────────────────────────────────────────

  function play(key) {
    if (_muted) return;
    const pool = SFX[key];
    if (!pool || pool.length === 0) return;
    const file = pool[Math.floor(Math.random() * pool.length)];
    const path = BASE + file;

    // Clone from cache for overlapping sounds
    if (!_cache[path]) _cache[path] = _createAudio(path);
    const snd = typeof _cache[path].cloneNode === 'function'
      ? _cache[path].cloneNode()
      : _createAudio(path);
    if (!snd.src) snd.src = path;
    if ('preload' in snd) snd.preload = 'auto';
    if ('playsInline' in snd) snd.playsInline = true;
    snd.setAttribute?.('playsinline', '');
    snd.volume = _sfxVol;
    _activeSfx.add(snd);

    const cleanup = () => _cleanupSfxInstance(snd);
    snd.addEventListener?.('ended', cleanup, { once: true });
    snd.addEventListener?.('error', cleanup, { once: true });
    snd.addEventListener?.('abort', cleanup, { once: true });

    const playResult = snd.play?.();
    if (!_isPromiseLike(playResult)) {
      _pendingSfxKeys.delete(key);
      return;
    }

    playResult.then(() => {
      _pendingSfxKeys.delete(key);
    }).catch(() => {
      cleanup();
      if (!_muted && RETRIABLE_SFX.has(key)) {
        _pendingSfxKeys.add(key);
      }
    });
  }

  function setSfxVolume(v) {
    _sfxVol = Math.max(0, Math.min(1, v));
    localStorage.setItem('shape_strikers_sfx_vol', _sfxVol);
  }

  // ── Mute toggle ───────────────────────────────────────────────────────────

  function toggleMute() {
    _muted = !_muted;
    localStorage.setItem('shape_strikers_muted', _muted ? '1' : '0');
    if (_musicEl) _musicEl.volume = _muted ? 0 : _musicVol;
    if (_muted) {
      _pendingSfxKeys.clear();
      _stopActiveSfx();
    } else {
      _flushPendingAudio();
    }
    return _muted;
  }

  function isMuted() { return _muted; }

  // ── Gameplay / Boss music ─────────────────────────────────────────────────

  // Plays gameplay BGM, rotating randomly through tracks when each ends.
  function playGameplayMusic() {
    _desiredMusic = { kind: 'gameplay' };
    _playDesiredMusic();
  }

  // Plays boss fight BGM (looping until explicitly stopped)
  function playBossMusic() {
    _desiredMusic = { kind: 'boss', file: 'SS_Music_Boss.wav' };
    _playDesiredMusic();
  }

  // Plays a SFX key after a delay (ms) — used for sequenced sounds (e.g. game_over then cry)
  function playAfter(key, delayMs) {
    setTimeout(() => play(key), delayMs);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    init,
    playMusic,
    playGameplayMusic,
    playBossMusic,
    playAfter,
    stopMusic,
    play,
    toggleMute,
    isMuted,
    setMusicVolume,
    setSfxVolume,
  };
})();
