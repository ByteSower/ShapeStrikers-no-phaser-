/**
 * Shape Strikers Web — Replay transport codec
 *
 * Battle replays record a full board snapshot on every turn_start, and most
 * units are unchanged from one turn to the next. pack() swaps each unit
 * snapshot that is identical to the previous snapshot of the same unit id for
 * a `{ "=": id }` reference; unpack() restores it. The round trip is lossless
 * (unpack(pack(x)) deep-equals x), so replay contents and determinism are
 * untouched — this only shrinks what goes over the wire.
 *
 * Replay logs are found anywhere inside the value (e.g. battle_replay payloads
 * or authoritative_state snapshots) and tagged with `__rpk: 1` once packed.
 */

const ReplayCodec = (() => {
  const MARK = '__rpk';
  const REF = '=';
  const SNAPSHOT_ARRAYS = ['playerUnits', 'enemyUnits'];

  function _isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function _isReplayLog(v) {
    return _isPlainObject(v) && Array.isArray(v.events) && v[MARK] === undefined &&
      v.events.some(e => _isPlainObject(e) && (e.type === 'turn_start' || e.type === 'battle_start'));
  }

  function _isUnitSnapshot(u) {
    return _isPlainObject(u) && typeof u.id === 'string';
  }

  function _isRef(u) {
    return _isPlainObject(u) && typeof u[REF] === 'string' && Object.keys(u).length === 1;
  }

  // Both directions visit units in the same order: playerUnits, enemyUnits, then unit.
  function _mapEventUnits(evt, mapUnit) {
    if (!_isPlainObject(evt)) return evt;
    let out = evt;
    const touch = () => { if (out === evt) out = Object.assign({}, evt); };
    for (const key of SNAPSHOT_ARRAYS) {
      if (Array.isArray(evt[key])) { touch(); out[key] = evt[key].map(mapUnit); }
    }
    if (_isPlainObject(evt.unit)) { touch(); out.unit = mapUnit(evt.unit); }
    return out;
  }

  function _packLog(log) {
    const last = new Map();
    const packUnit = (u) => {
      if (!_isUnitSnapshot(u)) return u;
      const json = JSON.stringify(u);
      if (last.get(u.id) === json) return { [REF]: u.id };
      last.set(u.id, json);
      return u;
    };
    return Object.assign({}, log, { events: log.events.map(evt => _mapEventUnits(evt, packUnit)), [MARK]: 1 });
  }

  function _unpackLog(log) {
    const last = new Map();
    const unpackUnit = (u) => {
      if (_isRef(u)) {
        const json = last.get(u[REF]);
        if (json === undefined) throw new Error(`ReplayCodec: unknown unit reference ${u[REF]}`);
        return JSON.parse(json);
      }
      if (_isUnitSnapshot(u)) last.set(u.id, JSON.stringify(u));
      return u;
    };
    const out = Object.assign({}, log, { events: log.events.map(evt => _mapEventUnits(evt, unpackUnit)) });
    delete out[MARK];
    return out;
  }

  function _walk(value, transformLog, isLog) {
    if (Array.isArray(value)) return value.map(v => _walk(v, transformLog, isLog));
    if (!_isPlainObject(value)) return value;
    if (isLog(value)) return transformLog(value);
    const out = {};
    for (const key of Object.keys(value)) out[key] = _walk(value[key], transformLog, isLog);
    return out;
  }

  function pack(value) {
    return _walk(value, _packLog, _isReplayLog);
  }

  function unpack(value) {
    return _walk(value, _unpackLog, v => v[MARK] === 1 && Array.isArray(v.events));
  }

  return { pack, unpack };
})();
