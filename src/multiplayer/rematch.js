/**
 * Shape Strikers — multiplayer/rematch.js
 *
 * Rematch handshake for the match-end screen.
 *
 * Each player broadcasts `mp_rematch_request` when they click Rematch. As soon
 * as a client knows both sides want a rematch it fires onStart with the next
 * room id. The id is derived from the current room id, so both clients reach
 * the same fresh channel without another round-trip, and a missed "start"
 * message can't strand one player. Returning to the lobby broadcasts
 * `mp_rematch_decline` so the other player isn't left waiting.
 *
 * Exposed as a plain global object (MultiplayerRematch) to match the IIFE pattern.
 */
'use strict';

const MultiplayerRematch = (() => {
  const REQUEST_KEY = 'mp_rematch_request';
  const DECLINE_KEY = 'mp_rematch_decline';
  const ROOM_SUFFIX = '~rematch-';

  function nextRoomId(roomId) {
    const match = /^(.*)~rematch-(\d+)$/.exec(String(roomId || ''));
    if (match) return `${match[1]}${ROOM_SUFFIX}${Number(match[2]) + 1}`;
    return `${roomId}${ROOM_SUFFIX}1`;
  }

  /**
   * @param {object}   opts
   * @param {string}   opts.roomId   Current room id (both clients must share it).
   * @param {function} opts.send     (key, value) → Promise|any. Broadcasts to the opponent.
   * @param {function} [opts.onChange] (status) → void. Called whenever status changes.
   * @param {function} opts.onStart  (nextRoomId, pendingSend) → void. Fires at most once.
   */
  function createSession({ roomId, send, onChange = () => {}, onStart }) {
    let localWants = false;
    let remoteWants = false;
    let declined = false;
    let started = false;
    let lastSend = null;

    const getStatus = () => ({ localWants, remoteWants, declined, started });
    const notify = () => onChange(getStatus());

    function maybeStart() {
      if (!localWants || !remoteWants || declined || started) return false;
      started = true;
      notify();
      onStart(nextRoomId(roomId), lastSend);
      return true;
    }

    function isForThisRoom(value) {
      if (!value) return false;
      return typeof value !== 'object' || !value.roomId || value.roomId === roomId;
    }

    return {
      requestLocal() {
        if (localWants || declined || started) return false;
        localWants = true;
        lastSend = send(REQUEST_KEY, { roomId, at: Date.now() });
        notify();
        maybeStart();
        return true;
      },

      declineLocal() {
        if (started || declined) return false;
        declined = true;
        lastSend = send(DECLINE_KEY, { roomId, at: Date.now() });
        notify();
        return true;
      },

      handleState(key, value) {
        if (started || !isForThisRoom(value)) return false;
        if (key === REQUEST_KEY) {
          if (remoteWants || declined) return false;
          remoteWants = true;
          notify();
          maybeStart();
          return true;
        }
        if (key === DECLINE_KEY) {
          if (declined) return false;
          declined = true;
          notify();
          return true;
        }
        return false;
      },

      getStatus,
    };
  }

  return { REQUEST_KEY, DECLINE_KEY, nextRoomId, createSession };
})();
