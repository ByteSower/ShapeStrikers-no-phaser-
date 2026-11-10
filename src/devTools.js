/**
 * Local-only development controls for progression and battle playback.
 */
const DevTools = (() => {
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const PROGRESSION_KEYS = [
    'shape_strikers_achievements',
    'shape_strikers_encountered_bosses',
    'shape_strikers_arcane_unlocked',
    'shape_strikers_void_unlocked',
    'shape_strikers_void_campaign_cleared',
    'shape_strikers_grid_glowing_unlocked',
    'shape_strikers_grid_flames_unlocked',
    'shape_strikers_grid_ice_unlocked',
    'shape_strikers_best_score_normal',
    'shape_strikers_best_score_void',
    'shape_strikers_daily_challenge',
    'shape_strikers_weekly_challenge',
    'shape_strikers_tutorial_done',
  ];

  function isEnabled() {
    const { hostname, search } = window.location;
    return LOCAL_HOSTS.has(hostname) && new URLSearchParams(search).get('dev') === '1';
  }

  function _refreshProgressionUI() {
    if (typeof Game !== 'undefined') Game.refreshProgressionUI();
  }

  function grantCampaignUnlocks() {
    if (!isEnabled()) return false;
    localStorage.setItem('shape_strikers_arcane_unlocked', '1');
    localStorage.setItem('shape_strikers_void_unlocked', '1');
    localStorage.setItem('shape_strikers_void_campaign_cleared', '1');
    if (typeof GridStyles !== 'undefined') GridStyles.syncCampaignProgress();
    _refreshProgressionUI();
    return true;
  }

  function unlockAllAchievements() {
    if (!isEnabled()) return false;
    const timestamp = Date.now();
    const achievements = {};
    for (const achievement of ACHIEVEMENTS) achievements[achievement.id] = timestamp;
    localStorage.setItem('shape_strikers_achievements', JSON.stringify(achievements));
    const bossIds = UNIT_DEFINITIONS.filter(unit => unit.isBoss).map(unit => unit.id);
    localStorage.setItem('shape_strikers_encountered_bosses', JSON.stringify(bossIds));
    _refreshProgressionUI();
    return true;
  }

  function resetProgression() {
    if (!isEnabled()) return false;
    if (!window.confirm('Reset campaign unlocks, achievements, boss discoveries, scores, challenge progress, and tutorial completion? Settings and multiplayer data will be kept.')) {
      return false;
    }
    for (const key of PROGRESSION_KEYS) localStorage.removeItem(key);
    _refreshProgressionUI();
    return true;
  }

  function init() {
    if (!isEnabled()) return;

    const root = document.createElement('div');
    root.id = 'dev-tools';
    root.innerHTML = `
      <details class="dev-tools-panel">
        <summary>🛠 Dev Tools</summary>
        <div class="dev-tools-content">
          <p class="dev-tools-note">Local testing only · progression changes are saved in this browser.</p>
          <div class="dev-tools-actions">
            <button type="button" data-dev-action="grant-unlocks">Grant campaign unlocks</button>
            <button type="button" data-dev-action="unlock-achievements">Unlock achievements + bosses</button>
            <button type="button" data-dev-action="reset-progression">Reset progression…</button>
          </div>
          <div class="dev-tools-speeds" aria-label="Fast battle speeds">
            <span>Battle speed</span>
            <button type="button" data-dev-speed="8">8×</button>
            <button type="button" data-dev-speed="16">16×</button>
          </div>
          <div class="dev-tools-speeds" aria-label="Grid effect renderer">
            <span>Grid effects</span>
            <button type="button" data-dev-renderer="canvas">Canvas 2D</button>
            <button type="button" data-dev-renderer="webgl">WebGL</button>
          </div>
          <output class="dev-tools-performance" aria-live="polite">FPS — · frame — ms</output>
          <p class="dev-tools-status" role="status" aria-live="polite"></p>
        </div>
      </details>`;
    document.body.appendChild(root);

    const status = root.querySelector('.dev-tools-status');
    root.querySelector('[data-dev-action="grant-unlocks"]').addEventListener('click', () => {
      try {
        grantCampaignUnlocks();
        status.textContent = 'Campaign unlocks granted and saved.';
      } catch (error) {
        console.error('[DevTools] Could not grant campaign unlocks:', error);
        status.textContent = `Could not grant unlocks: ${error.message}`;
      }
    });
    root.querySelector('[data-dev-action="unlock-achievements"]').addEventListener('click', () => {
      try {
        unlockAllAchievements();
        status.textContent = 'Achievements and boss discoveries saved.';
      } catch (error) {
        console.error('[DevTools] Could not unlock achievements:', error);
        status.textContent = `Could not unlock achievements: ${error.message}`;
      }
    });
    root.querySelector('[data-dev-action="reset-progression"]').addEventListener('click', () => {
      try {
        if (resetProgression()) status.textContent = 'Progression reset. Settings and multiplayer data were kept.';
      } catch (error) {
        console.error('[DevTools] Could not reset progression:', error);
        status.textContent = `Could not reset progression: ${error.message}`;
      }
    });
    root.querySelectorAll('[data-dev-speed]').forEach(button => {
      button.addEventListener('click', () => {
        try {
          const speed = Number(button.dataset.devSpeed);
          Game.setSpeed(speed);
          status.textContent = `Battle speed set to ${speed}×.`;
        } catch (error) {
          console.error('[DevTools] Could not change battle speed:', error);
          status.textContent = `Could not change speed: ${error.message}`;
        }
      });
    });

    root.querySelectorAll('[data-dev-renderer]').forEach(button => {
      button.addEventListener('click', () => {
        try {
          const requested = button.dataset.devRenderer;
          const active = GridFx.setRenderer(requested);
          if (!active) status.textContent = `Saved ${button.textContent}. Select an animated grid to see it.`;
          else if (active !== requested) status.textContent = 'This grid has no WebGL version yet; using Canvas 2D.';
          else status.textContent = `Grid effects now drawn with ${button.textContent}.`;
        } catch (error) {
          console.error('[DevTools] Could not change grid renderer:', error);
          status.textContent = `Could not change renderer: ${error.message}`;
        }
      });
    });

    const performanceOutput = root.querySelector('.dev-tools-performance');
    let previousFrame = 0;
    let sampleStart = 0;
    let frameCount = 0;
    let frameTimeTotal = 0;
    function sampleFrame(timestamp) {
      if (previousFrame > 0) {
        frameCount++;
        frameTimeTotal += timestamp - previousFrame;
      }
      if (!sampleStart) sampleStart = timestamp;
      if (timestamp - sampleStart >= 1000) {
        const elapsed = timestamp - sampleStart;
        const fps = Math.round(frameCount * 1000 / elapsed);
        const averageFrameTime = frameCount ? (frameTimeTotal / frameCount).toFixed(1) : '—';
        performanceOutput.textContent = `FPS ${fps} · frame ${averageFrameTime} ms`;
        sampleStart = timestamp;
        frameCount = 0;
        frameTimeTotal = 0;
      }
      previousFrame = timestamp;
      window.requestAnimationFrame(sampleFrame);
    }
    window.requestAnimationFrame(sampleFrame);
  }

  return { init, isEnabled, grantCampaignUnlocks, unlockAllAchievements, resetProgression };
})();
