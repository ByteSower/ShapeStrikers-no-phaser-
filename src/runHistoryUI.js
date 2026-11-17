'use strict';

const RunHistoryUI = (() => {
  const $ = id => document.getElementById(id);
  const OUTCOMES = { won: 'Won', lost: 'Lost', abandoned: 'Abandoned', interrupted: 'Interrupted', started: 'Unfinished / no result received', checkpointed: 'Unfinished / no result received' };
  let _initialized = false;
  let _epoch = 0;
  let _statusEpoch = 0;
  let _authEpoch = 0;
  let _focus = null;
  let _records = [];
  let _recordsOwner = null;
  let _cursor = null;
  let _pendingAuth = null;
  let _verifying = false;

  function warning(state, pending = 0, held = 0, failed = 0) {
    const disconnected = !Backend.isReady() || navigator.onLine === false;
    const visible = state.storageFailed || state.accountChanging
      || held > 0 || failed > 0 || ((state.active || pending > 0) && disconnected);
    for (const id of ['run-history-live-status', 'history-title-status']) {
      $(id).textContent = state.storageFailed || state.accountChanging ? state.message
        : held ? `${held} browser record(s) need review before uploading.`
          : failed ? `${failed} browser record(s) could not sync. Open History for details.`
            : disconnected && (state.active || pending > 0) ? 'History is pending on this browser; reconnect to sync.' : state.message;
      $(id).classList.toggle('hidden', !visible);
    }
  }

  function node(tag, text) {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }

  function errorMessage(id, error) {
    console.warn('[RunHistoryUI] Operation failed:', error?.name || 'Error');
    $(id).textContent = error.message;
  }

  function modeName(summary) {
    return summary.challengeType ? `${summary.challengeType} challenge (${summary.challengeKey})` : `${summary.campaignMode} campaign`;
  }

  function matches(summary) {
    const mode = $('history-mode').value;
    return ($('history-tests').checked || !summary.isTest)
      && (mode === 'all' || summary.challengeType === mode || (!summary.challengeType && summary.campaignMode === mode));
  }

  function date(value) {
    if (value === null || value === undefined) return 'Not recorded';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Unavailable' : parsed.toLocaleString();
  }

  async function status() {
    const epoch = ++_statusEpoch;
    clearChangedOwner();
    const state = RunHistory.getStatus();
    $('history-sync-status').textContent = state.message;
    warning(state);
    const rows = await RunHistory.pending();
    if (epoch !== _statusEpoch) return;
    const owner = Backend.getUserId();
    const own = rows.filter(row => owner && row.ownerId === owner).length;
    const unassigned = rows.filter(row => row.ownerId === null && row.guestFlowId === state.guestFlowId).length;
    const holds = rows.filter(row => owner && row.ownerId === owner && row.erasureHold);
    const failed = rows.filter(row => owner && row.ownerId === owner && row.error && !row.erasureHold).length;
    warning(RunHistory.getStatus(), owner ? own + unassigned : rows.length, holds.length, failed);
    const heldList = $('history-held-records');
    heldList.replaceChildren();
    $('history-held-section').classList.toggle('hidden', holds.length === 0);
    for (const row of holds) {
      const item = node('li', `${modeName(row.payload)} - ${date(row.payload.startedAt)} `);
      for (const [label, discard] of [['Restore to account', false], ['Discard browser copy', true]]) {
        const button = node('button', label);
        button.type = 'button';
        button.className = 'btn btn-secondary btn-sm';
        button.addEventListener('click', async () => {
          if (!window.confirm(discard ? 'Permanently discard this browser copy?' : 'Restore this record to your account? It may have existed before your history was deleted.')) return;
          button.disabled = true;
          try { await RunHistory.resolveHeld(row.id, discard); await status(); await load(); }
          catch (error) { errorMessage('history-sync-status', error); }
          finally { button.disabled = false; }
        });
        item.append(button);
      }
      heldList.append(item);
    }
    $('history-pending-counts').textContent = `Pending on this browser: ${own} for this account, ${unassigned} unassigned in this guest flow, ${rows.length - own - unassigned} for other accounts/flows (not transferred).`;
    $('history-bind').classList.toggle('hidden', !unassigned || !RunHistory.getStatus().canBindUnassigned);
    $('history-account-identity').textContent = !owner ? 'Account connection unavailable.' : Backend.getUser()?.is_anonymous
      ? 'Guest account: optional email linking protects recovery after browser storage is cleared.'
      : 'Email-linked account. Your private history follows this account; local cosmetics do not.';
  }

  function clearChangedOwner() {
    const owner = Backend.getUserId();
    if (_recordsOwner === owner) return;
    _epoch++;
    _recordsOwner = owner;
    _records = [];
    _cursor = null;
    $('history-records').replaceChildren();
    $('history-more').classList.add('hidden');
    totals(null);
  }

  function totals(data, cached = false) {
    $('history-categories').replaceChildren();
    if (!data) {
      $('history-totals').textContent = 'Cloud totals unavailable; no totals are inferred from this page.';
      return;
    }
    if (!['completed', 'wins', 'losses', 'damage', 'healed', 'kills', 'recruits', 'bossesDefeated'].every(key => Number.isFinite(data[key]))
      || !Array.isArray(data.categories)) throw new Error('Invalid cloud totals response');
    const rate = data.completed ? `${(100 * data.wins / data.completed).toFixed(1)}%` : 'No completed runs';
    $('history-totals').textContent = `${cached ? 'Cached, possibly outdated. ' : ''}Completed ${data.completed}; wins ${data.wins}; losses ${data.losses}; played-to-completion win rate ${rate}. Damage ${data.damage}; healing ${data.healed}; kills ${data.kills}; recruits ${data.recruits}; bosses ${data.bossesDefeated}. Tracking since ${date(data.trackedSince)}; no historical backfill.`;
    for (const category of data.categories) {
      $('history-categories').append(node('li', `${category.challenge_type || category.campaign_mode}: ${OUTCOMES[category.status]} ${category.attempts}${category.test_record ? ' (test)' : ''}`));
    }
  }

  function detail(body, payload, full) {
    body.replaceChildren();
    const fields = [
      ['Outcome', OUTCOMES[payload.status]], ['Started (device time)', date(payload.startedAt)],
      ['Last observed (device time)', date(payload.observedAt)], ['Completeness', payload.completeness],
      ['Wave reached / cleared', `${payload.waveReached} / ${payload.wavesCleared}`],
      ['Battles resolved', payload.battlesResolved], ['Score', payload.score], ['Paid recruits', payload.recruits],
      ['Paid Fire purchases', payload.firePurchases], ['Upgrades bought', payload.upgradesBought],
      ['Player damage / healing', `${payload.damage} / ${payload.healed}`], ['Kills / bosses defeated', `${payload.kills} / ${payload.bossesDefeated}`],
      ['Player losses', payload.playerLosses], ['Living Tier 3 Ice units', payload.iceSurvivors],
    ];
    const list = document.createElement('dl');
    for (const [label, value] of fields) list.append(node('dt', label), node('dd', String(value)));
    body.append(list);
    if (!full) return;
    if (!Array.isArray(payload.participants) || !Array.isArray(payload.unitStats)) throw new Error('Invalid run detail response');
    body.append(node('h4', 'Last battle participants (before post-battle healing)'));
    for (const unit of payload.participants) {
      body.append(node('p', `${unit.name}, Tier ${unit.tier} ${unit.element}: ${unit.survived ? 'survived' : 'lost'}, HP ${unit.hp}/${unit.maxHp}`));
    }
    body.append(node('h4', 'Per-definition recruitment and combat (including dead/sold units)'));
    for (const unit of payload.unitStats) {
      body.append(node('p', `${unit.name}, Tier ${unit.tier}: recruits ${unit.recruits}, damage ${unit.damage}, healing ${unit.healed}, kills ${unit.kills}`));
    }
  }

  function render(pending, epoch, owner) {
    const visible = new Map(_records.filter(row => matches(row.summary)).map(row => [row.id, row]));
    for (const row of pending) {
      if ((owner && row.ownerId === owner) || (row.ownerId === null && row.guestFlowId === RunHistory.getStatus().guestFlowId)) {
        if (matches(row.payload)) visible.set(row.id, { id: row.id, summary: row.payload, local: row });
      }
    }
    $('history-records').replaceChildren();
    if (!visible.size) $('history-records').append(node('p', 'No records in this view. Staging runs require Show test records.'));
    for (const row of visible.values()) {
      const card = document.createElement('details');
      const summary = row.summary;
      card.append(node('summary', `${OUTCOMES[summary.status]} - ${modeName(summary)} - ${date(summary.startedAt)}${summary.isTest ? ' - TEST' : ''}${row.local ? ' - browser pending' : ''}`));
      const body = document.createElement('div');
      detail(body, summary, false);
      card.append(body);
      if (row.local?.error) card.append(node('p', `Upload error: ${row.local.error}${row.local.permanentError ? ' (not automatically retried)' : ''}`));
      let loaded = false;
      let loading = false;
      card.addEventListener('toggle', async () => {
        if (!card.open || loaded || loading) return;
        loading = true;
        try {
          if (row.local) detail(body, row.local.payload, true);
          else {
            const result = await Backend.fetchHistoryDetail(row.id);
            if (epoch !== _epoch || owner !== Backend.getUserId() || !card.isConnected) return;
            if (!result.ok) throw new Error(result.error);
            if (!Array.isArray(result.data) || result.data.length !== 1) throw new Error('Run details are no longer available');
            detail(body, result.data[0].payload, true);
          }
          loaded = true;
        } catch (error) {
          if (epoch === _epoch && owner === Backend.getUserId()) {
            detail(body, summary, false);
            body.append(node('p', `Squad details unavailable: ${error.message}. Close and reopen this record to retry.`));
            console.warn('[RunHistoryUI] Details unavailable:', error?.name || 'Error');
          }
        } finally { loading = false; }
      });
      $('history-records').append(card);
    }
  }

  async function load(append = false) {
    if (_recordsOwner !== Backend.getUserId()) append = false;
    clearChangedOwner();
    const epoch = ++_epoch;
    const owner = Backend.getUserId();
    $('history-read-status').textContent = 'Loading private history...';
    $('history-more').classList.add('hidden');
    try {
      const [page, aggregate, pending] = await Promise.all([
        Backend.fetchHistory({ cursor: append ? _cursor : null, mode: $('history-mode').value, includeTests: $('history-tests').checked }),
        Backend.fetchHistoryTotals(), RunHistory.pending(),
      ]);
      if (epoch !== _epoch || owner !== Backend.getUserId()) return;
      if (!append) _records = [];
      if (page.ok) {
        if (!Array.isArray(page.data.records) || typeof page.data.hasMore !== 'boolean') throw new Error('Invalid history page response');
        _records = append ? [..._records, ...page.data.records] : page.data.records;
        _cursor = page.data.cursor;
        $('history-more').classList.toggle('hidden', !page.data.hasMore);
        totals(aggregate.ok ? aggregate.data : null);
        $('history-read-status').textContent = aggregate.ok ? 'Private cloud history; pending browser checkpoints may be newer.' : `Cloud list loaded; totals failed: ${aggregate.error}`;
        if (owner && aggregate.ok) await RunHistoryStore.setCache(owner, _records, aggregate.data);
      } else {
        const cache = owner && !append ? await RunHistoryStore.getCache(owner) : null;
        if (epoch !== _epoch || owner !== Backend.getUserId()) return;
        if (cache) _records = cache.records;
        totals(aggregate.ok ? aggregate.data : cache?.totals, !aggregate.ok && Boolean(cache));
        $('history-read-status').textContent = `Cloud history unavailable: ${page.error}. ${cache ? `Incomplete cached pages from ${date(cache.observedAt)}.` : 'Showing available browser-pending records only.'}`;
      }
      if (epoch === _epoch && owner === Backend.getUserId()) render(pending, epoch, owner);
    } catch (error) {
      if (epoch === _epoch) errorMessage('history-read-status', error);
    }
  }

  function selectSection(account) {
    $('history-list-section').classList.toggle('hidden', account);
    $('history-account-section').classList.toggle('hidden', !account);
    $('history-show-list').setAttribute('aria-pressed', String(!account));
    $('history-show-account').setAttribute('aria-pressed', String(account));
  }

  function resetAccount() {
    _authEpoch++;
    Backend.cancelCodeVerification();
    _pendingAuth = null;
    _verifying = false;
    $('history-account-email').value = '';
    $('history-account-code').value = '';
    $('history-switch-confirm').checked = false;
    $('history-account-email').disabled = false;
    $('history-account-kind').disabled = false;
    $('history-request-code').disabled = false;
    $('history-request-code').textContent = 'Request code';
    $('history-code-form').classList.add('hidden');
    $('history-code-form').querySelector('button').disabled = false;
    const guest = Backend.getUser()?.is_anonymous;
    $('history-account-kind').querySelector('[value="link"]').disabled = !guest;
    $('history-account-kind').value = guest ? 'link' : 'existing';
    $('history-switch-warning').classList.toggle('hidden', Boolean(guest));
    $('history-account-status').textContent = '';
    $('history-delete-confirm').checked = false;
    $('history-delete').disabled = true;
    $('history-privacy-status').textContent = '';
  }

  function close() {
    _epoch++;
    $('history-overlay').classList.add('hidden');
    resetAccount();
    if (_focus?.isConnected) _focus.focus();
  }

  function open(account = false) {
    if (RunHistory.getStatus().active) {
      UI.showMessage('Account and History actions are available from home, outside a run.');
      return;
    }
    UI.hideAllOverlays();
    _focus = document.activeElement;
    $('history-overlay').classList.remove('hidden');
    resetAccount();
    selectSection(account);
    $('history-close').focus();
    status().catch(error => errorMessage('history-sync-status', error));
    load();
  }

  function init() {
    if (_initialized) return;
    _initialized = true;
    for (const id of ['btn-run-history', 'btn-history-account']) $(id).classList.remove('hidden');
    $('btn-run-history').addEventListener('click', () => open());
    $('btn-history-account').addEventListener('click', () => open(true));
    $('history-close').addEventListener('click', close);
    $('history-show-list').addEventListener('click', () => selectSection(false));
    $('history-show-account').addEventListener('click', () => selectSection(true));
    $('history-mode').addEventListener('change', () => load());
    $('history-tests').addEventListener('change', () => load());
    $('history-more').addEventListener('click', () => load(true));
    for (const [id, action] of [['history-retry', () => RunHistory.flush(true)], ['history-bind', () => RunHistory.bindUnassigned()]]) {
      $(id).addEventListener('click', async () => {
        $(id).disabled = true;
        try { await action(); await status(); await load(); }
        catch (error) { errorMessage('history-sync-status', error); }
        finally { $(id).disabled = false; }
      });
    }
    $('history-account-kind').addEventListener('change', () => {
      $('history-switch-warning').classList.toggle('hidden', $('history-account-kind').value !== 'existing');
      $('history-switch-confirm').checked = false;
    });
    $('history-account-cancel').addEventListener('click', resetAccount);
    $('history-delete-confirm').addEventListener('change', () => {
      $('history-delete').disabled = !$('history-delete-confirm').checked;
    });
    $('history-export').addEventListener('click', async () => {
      const button = $('history-export');
      button.disabled = true;
      $('history-privacy-status').textContent = 'Preparing your history download...';
      try {
        const result = await Backend.exportHistory();
        if (!result.ok) throw new Error(result.error);
        const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `shape-strikers-history-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        $('history-privacy-status').textContent = `Downloaded ${result.data.records.length} cloud record(s). Browser-pending records upload first; download again after they sync.`;
      } catch (error) { errorMessage('history-privacy-status', error); }
      finally { button.disabled = false; }
    });
    $('history-delete').addEventListener('click', async () => {
      if (!$('history-delete-confirm').checked) return;
      $('history-delete').disabled = true;
      $('history-delete-confirm').disabled = true;
      $('history-privacy-status').textContent = 'Deleting your run history...';
      try {
        const result = await RunHistory.eraseHistory();
        _epoch++;
        _records = [];
        _cursor = null;
        $('history-delete-confirm').checked = false;
        $('history-privacy-status').textContent = `Deleted ${result.deleted} cloud record(s) and ${result.local} browser record(s).`;
        await status();
        await load();
      } catch (error) {
        errorMessage('history-privacy-status', error);
        $('history-delete').disabled = !$('history-delete-confirm').checked;
      } finally { $('history-delete-confirm').disabled = false; }
    });
    $('history-account-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (_verifying) {
        $('history-account-status').textContent = 'Verification is in progress; cancel it before requesting another code.';
        return;
      }
      const epoch = ++_authEpoch;
      const request = _pendingAuth || {
        kind: $('history-account-kind').value, email: $('history-account-email').value.trim(), sourceId: Backend.getUserId(),
      };
      $('history-request-code').disabled = true;
      try {
        const result = request.kind === 'link' ? await Backend.requestLinkEmail(request.email)
          : await Backend.requestExistingAccount(request.email, $('history-switch-confirm').checked);
        if (epoch !== _authEpoch) return;
        if (!result.ok) throw new Error(result.error);
        if (request.sourceId !== Backend.getUserId()) throw new Error('Account changed; request a new code');
        _pendingAuth = request;
        $('history-account-email').disabled = true;
        $('history-account-kind').disabled = true;
        $('history-request-code').textContent = 'Resend code';
        $('history-code-form').classList.remove('hidden');
        $('history-account-status').textContent = 'Code requested. Check your email; never share the code.';
        $('history-account-code').focus();
      } catch (error) { if (epoch === _authEpoch) errorMessage('history-account-status', error); }
      finally { if (epoch === _authEpoch) $('history-request-code').disabled = false; }
    });
    $('history-code-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!_pendingAuth) {
        $('history-account-status').textContent = 'Request a code before trying to verify.';
        return;
      }
      if (_verifying) return;
      const epoch = _authEpoch;
      const button = event.currentTarget.querySelector('button');
      button.disabled = true;
      _verifying = true;
      $('history-request-code').disabled = true;
      try {
        const result = await Backend.verifyAccountCode({ ..._pendingAuth, token: $('history-account-code').value.trim() });
        if (epoch !== _authEpoch) return;
        if (!result.ok) throw new Error(result.error);
        resetAccount();
        $('history-account-status').textContent = 'Code verified. Linking preserves your guest identity; a different account reloads the game.';
        await status();
      } catch (error) { if (epoch === _authEpoch) errorMessage('history-account-status', error); }
      finally {
        if (epoch === _authEpoch) {
          _verifying = false;
          button.disabled = false;
          $('history-request-code').disabled = false;
        }
      }
    });
    $('history-overlay').addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const focusable = [...$('history-overlay').querySelectorAll('a[href], button, input, select, summary, [tabindex="0"]')]
        .filter(element => !element.disabled && element.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    RunHistory.subscribe(() => { status().catch(error => errorMessage('history-sync-status', error)); });
    Backend.subscribeAuth(({ previousId, user }) => {
      clearChangedOwner();
      if (previousId && previousId !== user?.id) resetAccount();
      status().catch(error => errorMessage('history-sync-status', error));
    });
    status().catch(error => errorMessage('history-sync-status', error));
  }

  return { init, open, close };
})();
