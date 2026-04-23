/**
 * Shape Strikers Web - Battle Replay Player
 *
 * Replays deterministic battle logs emitted by BattleSystem.getReplayLog().
 * The player is intentionally renderer-agnostic: callers provide handlers for
 * battle_start, unit_attack, unit_hit, unit_move, status_change, etc.
 */

const BattleReplay = (() => {
  const EVENT_TO_HANDLER = {
    battle_start: 'onBattleStart',
    turn_start: 'onTurnStart',
    unit_attack: 'onUnitAttack',
    unit_hit: 'onUnitHit',
    ability_used: 'onAbilityUsed',
    status_change: 'onStatusChange',
    unit_move: 'onUnitMove',
    unit_death: 'onUnitDeath',
    phase_change: 'onPhaseChange',
    synergy_activated: 'onSynergyActivated',
    battle_end: 'onBattleEnd',
  };

  function _getOrderedEvents(replayLog) {
    return replayLog.events
      .slice()
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  }

  function _hasResumeSnapshot(evt) {
    return Array.isArray(evt?.playerUnits) && Array.isArray(evt?.enemyUnits);
  }

  function getResumePoint(replayLog, startSeq = 0) {
    if (!replayLog || !Array.isArray(replayLog.events)) {
      throw new Error('BattleReplay.getResumePoint requires a replay log with an events array');
    }

    const orderedEvents = _getOrderedEvents(replayLog);
    if (!(startSeq > 0)) {
      return { orderedEvents, checkpoint: null, startIndex: 0 };
    }

    let checkpoint = null;
    let checkpointIndex = -1;

    for (let i = 0; i < orderedEvents.length; i++) {
      const evt = orderedEvents[i];
      if ((evt.seq || 0) > startSeq) break;
      if ((evt.type === 'battle_start' || evt.type === 'turn_start') && _hasResumeSnapshot(evt)) {
        checkpoint = evt;
        checkpointIndex = i;
      }
    }

    if (!checkpoint) {
      checkpointIndex = orderedEvents.findIndex(evt => evt.type === 'battle_start' && _hasResumeSnapshot(evt));
      checkpoint = checkpointIndex >= 0 ? orderedEvents[checkpointIndex] : null;
    }

    return {
      orderedEvents,
      checkpoint,
      startIndex: checkpointIndex >= 0 ? checkpointIndex + 1 : 0,
    };
  }

  class Player {
    constructor(options = {}) {
      this._sleep = options.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
      this._playing = false;
      this._stopped = false;
    }

    isPlaying() {
      return this._playing;
    }

    stop() {
      this._stopped = true;
    }

    async play(replayLog, handlers = {}, options = {}) {
      if (!replayLog || !Array.isArray(replayLog.events)) {
        throw new Error('BattleReplay.play requires a replay log with an events array');
      }

      const startSeq = Number(options.startSeq || 0);
      const resumePoint = getResumePoint(replayLog, startSeq);
      const ordered = resumePoint.orderedEvents;

      this._playing = true;
      this._stopped = false;

      const turnDelay = options.turnDelay || 0;

      try {
        if (startSeq > 0 && resumePoint.checkpoint) {
          await this._dispatchEvent({
            ...resumePoint.checkpoint,
            type: 'battle_start',
            seed: replayLog.seed,
            resumed: true,
            checkpointSeq: resumePoint.checkpoint.seq || 0,
            requestedSeq: startSeq,
          }, handlers, replayLog);
        }

        for (let i = resumePoint.startIndex; i < ordered.length; i++) {
          if (this._stopped) break;

          const evt = ordered[i];
          await this._dispatchEvent(evt, handlers, replayLog);

          const nextEvt = ordered[i + 1] || null;
          const turnChanged = nextEvt && evt.turn > 0 && nextEvt.turn !== evt.turn;
          if (turnChanged) {
            if (typeof handlers.waitForAnimations === 'function') {
              await handlers.waitForAnimations(evt, replayLog);
            }
            if (turnDelay > 0) {
              await this._sleep(turnDelay);
            }
          }
        }
      } finally {
        this._playing = false;
      }

      return { stopped: this._stopped };
    }

    async _dispatchEvent(evt, handlers, replayLog) {
      if (typeof handlers.onEvent === 'function') {
        await handlers.onEvent(evt, replayLog);
      }

      const handlerName = EVENT_TO_HANDLER[evt.type];
      if (handlerName && typeof handlers[handlerName] === 'function') {
        await handlers[handlerName](evt, replayLog);
      }
    }
  }

  function createPlayer(options) {
    return new Player(options);
  }

  return {
    createPlayer,
    getResumePoint,
    Player,
  };
})();