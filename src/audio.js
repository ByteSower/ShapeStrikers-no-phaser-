/**
 * Shape Strikers Web — Audio Manager
 * Handles background music and sound effects.
 */

const Audio = (() => {
  const BASE = 'public/Audio/';

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

  // Cache of pre-created Audio objects for faster playback
  const _cache = {};

  function _clampVolume(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
  }

  // ── Initialise ────────────────────────────────────────────────────────────

  function init() {
    // Restore mute state
    _muted = localStorage.getItem('shape_strikers_muted') === '1';
    _sfxVol = _clampVolume(localStorage.getItem('shape_strikers_sfx_vol'), 0.35);
    _musicVol = _clampVolume(localStorage.getItem('shape_strikers_music_vol'), 0.25);
  }

  // ── Background music ─────────────────────────────────────────────────────

  function playMusic(file) {
    stopMusic();
    _musicEl = new window.Audio(BASE + file);
    _musicEl.loop = true;
    _musicEl.volume = _muted ? 0 : _musicVol;
    _musicEl.play().catch(() => {});
  }

  function stopMusic() {
    if (_musicEl) {
      _musicEl.pause();
      _musicEl.currentTime = 0;
      _musicEl.removeAttribute('src');
      try { _musicEl.load(); } catch (_) {}
      _musicEl = null;
    }
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
    if (!_cache[path]) _cache[path] = new window.Audio(path);
    const snd = _cache[path].cloneNode();
    snd.volume = _sfxVol;
    snd.play().catch(() => {});
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
    return _muted;
  }

  function isMuted() { return _muted; }

  // ── Gameplay / Boss music ─────────────────────────────────────────────────

  // Plays gameplay BGM, rotating randomly through tracks when each ends.
  function playGameplayMusic() {
    stopMusic();
    const track = _gameplayTracks[Math.floor(Math.random() * _gameplayTracks.length)];
    _musicEl = new window.Audio(BASE + track);
    _musicEl.loop = false;
    _musicEl.volume = _muted ? 0 : _musicVol;
    // On end, recurse to pick a fresh random track (provides variety without fixed ordering)
    _musicEl.addEventListener('ended', playGameplayMusic, { once: true });
    _musicEl.play().catch(() => {});
  }

  // Plays boss fight BGM (looping until explicitly stopped)
  function playBossMusic() {
    stopMusic();
    _musicEl = new window.Audio(BASE + 'SS_Music_Boss.wav');
    _musicEl.loop = true;
    _musicEl.volume = _muted ? 0 : _musicVol;
    _musicEl.play().catch(() => {});
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
