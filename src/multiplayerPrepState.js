'use strict';

const MultiplayerPrepState = (() => {
  function _cloneSerializable(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }

  function _serializeUnit(unit) {
    if (!unit || !unit.definition?.id) return null;

    const snapshot = { defId: unit.definition.id };
    for (const [key, value] of Object.entries(unit)) {
      if (key === 'definition' || typeof value === 'function' || value === undefined) continue;
      snapshot[key] = _cloneSerializable(value);
    }
    return snapshot;
  }

  function _definitionMap(definitions) {
    const map = Object.create(null);
    for (const def of (definitions || [])) {
      if (def?.id) map[def.id] = def;
    }
    return map;
  }

  function build({ roundNumber, revision = 0, gold, refreshesLeft, upgradeLevels, shopUnits, playerUnits }) {
    return {
      roundNumber: Number(roundNumber) || 0,
      revision: Math.max(0, Number(revision) || 0),
      gold: Number(gold) || 0,
      refreshesLeft: Math.max(0, Number(refreshesLeft) || 0),
      upgradeLevels: _cloneSerializable(upgradeLevels) || {},
      shopUnits: Array.isArray(shopUnits) ? shopUnits.map(def => def?.id || null) : [],
      playerUnits: Array.isArray(playerUnits)
        ? playerUnits.map(_serializeUnit).filter(Boolean)
        : [],
      at: Date.now(),
    };
  }

  function inflate(snapshot, { definitions, createUnit }) {
    if (!snapshot || typeof createUnit !== 'function') return null;

    const defs = _definitionMap(definitions);
    const playerUnits = [];
    for (const entry of (snapshot.playerUnits || [])) {
      const def = defs[entry?.defId];
      if (!def) continue;

      const unit = createUnit(def, Number(entry.row) || 0, Number(entry.col) || 0, !!entry.isEnemy);
      for (const [key, value] of Object.entries(entry)) {
        if (key === 'defId') continue;
        unit[key] = _cloneSerializable(value);
      }
      unit.definition = def;
      playerUnits.push(unit);
    }

    return {
      roundNumber: Number(snapshot.roundNumber) || 0,
      revision: Math.max(0, Number(snapshot.revision) || 0),
      gold: Number(snapshot.gold) || 0,
      refreshesLeft: Math.max(0, Number(snapshot.refreshesLeft) || 0),
      upgradeLevels: _cloneSerializable(snapshot.upgradeLevels) || {},
      shopUnits: Array.isArray(snapshot.shopUnits)
        ? snapshot.shopUnits.map(defId => defId ? (defs[defId] || null) : null)
        : [],
      playerUnits,
    };
  }

  return {
    build,
    inflate,
  };
})();