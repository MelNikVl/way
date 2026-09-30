import { validateImport } from './core.mjs';

const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal(a[key], b[key]));
}

// Older open pages write their entire in-memory snapshot on every input event.
// Absence in that snapshot is not sufficient evidence that a stored answer was deleted.
function retainDictionaryKeys(incoming, existing) {
  if (!existing) return incoming;
  const retained = copy(incoming);
  function retain(next, previous) {
    if (!object(next) || !object(previous)) return copy(next);
    const result = copy(previous);
    for (const [name, value] of Object.entries(next)) result[name] = retain(value, previous[name]);
    return result;
  }
  for (const name of ['answers', 'entries', 'reviews', 'milestones', 'finances']) {
    retained[name] = retain(incoming[name], existing[name]);
  }
  return retained;
}

/** Three-way merge. Arrays are atomic; deletions and competing leaf edits conflict. */
export function mergeStates(base, local, remote, preference = 'local') {
  const conflicts = [];
  function merge(before, left, right, path) {
    if (equal(left, right)) return copy(left);
    if (equal(left, before)) return copy(right);
    if (equal(right, before)) return copy(left);
    if (object(left) && object(right) && (object(before) || before === undefined)) {
      const result = {};
      for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(left), ...Object.keys(right)])) {
        const value = merge(before?.[key], left[key], right[key], path ? `${path}.${key}` : key);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    conflicts.push({ path: path || '*', base: copy(before), local: copy(left), remote: copy(right) });
    return copy(preference === 'remote' ? right : left);
  }
  return { state: merge(base, local, remote, ''), conflicts };
}

/** Local-first storage, serialized optimistic DB writes, and explicit conflict resolution. */
export function createSync({ key, storage, fetch: request = globalThis.fetch, onState = () => {}, onStatus = () => {},
  timers = globalThis, debounceMs = 350 }) {
  const metaKey = `${key}-sync`;
  const conflictKey = `${key}-conflict`;
  const headers = { 'X-Way-Client': 'local-v1' };
  let current = null;
  let baseState = null;
  let revision = 0;
  let updatedAt = null;
  let initialized = false;
  let closed = false;
  let dirty = false;
  let timer = null;
  let running = null;
  let starting = null;
  let conflict = null;

  function status(kind, extra = {}) {
    if (!closed) onStatus({ kind, revision, updatedAt, ...extra });
  }
  function result() { return { state: copy(current), revision, updatedAt }; }
  function cancelTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }
  function readState() {
    const value = storage.getItem(key);
    return value === null ? null : validateImport(value);
  }
  function refreshLocal() {
    const latest = readState();
    if (latest && !equal(current, latest)) {
      current = retainDictionaryKeys(latest, current);
      storage.setItem(key, JSON.stringify(current));
      dirty = true;
      if (!closed) onState(copy(current));
    }
  }
  function publish(state) {
    const next = validateImport(state);
    const changed = !equal(current, next);
    storage.setItem(key, JSON.stringify(next));
    current = next;
    if (changed && !closed) onState(copy(next));
  }
  function saveMeta(remote) {
    storage.setItem(metaKey, JSON.stringify({ baseState: remote.state, revision: remote.revision, updatedAt: remote.updatedAt }));
    baseState = copy(remote.state);
    revision = remote.revision;
    updatedAt = remote.updatedAt;
  }
  function parseRemote(data) {
    if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      !(data.updatedAt === null || typeof data.updatedAt === 'string')) throw new Error('Некорректный ответ базы.');
    return { state: data.state === null ? null : validateImport(data.state), revision: data.revision, updatedAt: data.updatedAt };
  }
  async function getRemote() {
    const response = await request('/api/state', { headers, cache: 'no-store' });
    if (!response.ok) throw new Error(`База недоступна (${response.status}).`);
    return parseRemote(await response.json());
  }
  function rememberConflict(remote, merged, ancestor = baseState, extra = {}) {
    conflict = { baseState: copy(ancestor), localState: copy(current), remoteState: copy(remote.state),
      mergedState: copy(merged.state), revision: remote.revision, updatedAt: remote.updatedAt, conflicts: merged.conflicts, ...extra };
    storage.setItem(conflictKey, JSON.stringify(conflict));
    dirty = true;
    cancelTimer();
    status('conflict', { message: 'В браузере и базе есть разные изменения. Обе версии сохранены; выберите нужную.', conflicts: copy(merged.conflicts) });
  }
  function reconcile(remote) {
    refreshLocal();
    if (remote.state === null) {
      saveMeta(remote);
      dirty = current !== null;
      return;
    }
    if (!current || equal(current, remote.state)) {
      publish(remote.state);
      saveMeta(remote);
      dirty = false;
      conflict = null;
      storage.removeItem(conflictKey);
      return;
    }
    if (baseState === null) {
      rememberConflict(remote, { state: current, conflicts: [{ path: '*', local: copy(current), remote: copy(remote.state) }] });
      return;
    }
    const merged = mergeStates(baseState, current, remote.state);
    if (merged.conflicts.length) {
      rememberConflict(remote, merged);
      return;
    }
    publish(merged.state);
    saveMeta(remote);
    dirty = !equal(current, remote.state);
    conflict = null;
    storage.removeItem(conflictKey);
  }
  function offline(error) {
    status(conflict ? 'conflict' : 'offline', {
      message: conflict ? 'Различие версий ещё не разрешено. База недоступна; можно повторить выбор после запуска сервера.'
        : 'Изменения остались в этом браузере. Сохранение в базу пока не подтверждено.',
      error: error?.message ?? String(error), ...(conflict ? { conflicts: copy(conflict.conflicts) } : {}),
    });
  }
  function schedule() {
    cancelTimer();
    if (!closed && initialized && !conflict) timer = timers.setTimeout(() => { timer = null; void flush(); }, debounceMs);
  }

  async function start(localState, { hasLocal = true } = {}) {
    if (starting) return starting;
    if (initialized) return result();
    current = hasLocal ? validateImport(localState) : null;
    // The caller may have a fresh personal seed even when there is no saved state.
    const seed = validateImport(localState);
    try {
      const meta = JSON.parse(storage.getItem(metaKey) ?? 'null');
      if (meta && Number.isSafeInteger(meta.revision) && meta.revision >= 0) {
        baseState = meta.baseState === null ? null : validateImport(meta.baseState);
        revision = meta.revision;
        updatedAt = meta.updatedAt ?? null;
      }
    } catch { /* An invalid baseline must never authorize overwriting the database. */ }
    try {
      const saved = JSON.parse(storage.getItem(conflictKey) ?? 'null');
      if (saved && Array.isArray(saved.conflicts) && saved.conflicts.length) {
        conflict = { ...saved, localState: validateImport(saved.localState), remoteState: validateImport(saved.remoteState),
          baseState: saved.baseState === null ? null : validateImport(saved.baseState),
          ...(saved.source === 'browser' ? { databaseBaseState: saved.databaseBaseState === null ? null : validateImport(saved.databaseBaseState) } : {}) };
        if (!current) publish(conflict.localState);
      }
    } catch { /* Keep malformed recovery data untouched; normal reconciliation remains conservative. */ }
    starting = (async () => {
      status('syncing');
      try {
        const remote = await getRemote();
        if (closed) return result();
        // A first-time browser should receive the DB before falling back to its seed.
        if (!current && remote.state === null) publish(seed);
        if (conflict) {
          status('conflict', { message: 'Сохранено неразрешённое различие версий. Выберите нужную версию.', conflicts: copy(conflict.conflicts) });
        } else reconcile(remote);
        initialized = true;
        if (dirty && !conflict) await flush();
        else if (!conflict) status('saved');
      } catch (error) {
        if (!current) publish(seed);
        initialized = true;
        dirty = true;
        offline(error);
      }
      return result();
    })();
    return starting;
  }

  function queue(state) {
    current = validateImport(state);
    dirty = true;
    if (conflict) {
      // Preserve ongoing typing as well as the remote version while uploads are paused.
      conflict.localState = copy(current);
      storage.setItem(conflictKey, JSON.stringify(conflict));
      status('conflict', { message: 'Новый ответ сохранён в браузере. Для базы сначала разрешите различие версий.', conflicts: copy(conflict.conflicts) });
    } else {
      status('syncing');
      schedule();
    }
  }

  async function drain() {
    status('syncing');
    let collisions = 0;
    try {
      // A failed startup GET leaves the baseline unknown. Always read it before POST.
      if (baseState === null && revision === 0) reconcile(await getRemote());
      while (!closed && dirty && !conflict) {
        refreshLocal();
        const sent = copy(current);
        const sentRevision = revision;
        const response = await request('/api/state', {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: sent, baseRevision: sentRevision }),
        });
        if (closed) return result();
        if (response.status === 409) {
          const remote = parseRemote(await response.json());
          reconcile(remote);
          if (++collisions >= 4 && dirty && !conflict) throw new Error('База меняется в другой вкладке. Повторите сохранение.');
          continue;
        }
        if (!response.ok) throw new Error(`База недоступна (${response.status}).`);
        const acknowledgement = await response.json();
        const remote = parseRemote({ ...acknowledgement, state: own(acknowledgement, 'state') ? acknowledgement.state : sent });
        if (remote.state === null) throw new Error('База не подтвердила сохранение.');
        refreshLocal();
        // Normally the server echoes sent. This merge also preserves edits made while POST was in flight.
        const merged = mergeStates(sent, current, remote.state);
        if (merged.conflicts.length) {
          rememberConflict(remote, merged, sent);
          break;
        }
        publish(merged.state);
        saveMeta(remote);
        dirty = !equal(current, remote.state);
        collisions = 0;
      }
      if (!conflict && !dirty) status('saved');
    } catch (error) { dirty = true; offline(error); }
    return result();
  }

  async function flush() {
    cancelTimer();
    if (closed || conflict || !initialized) return result();
    if (running) return running;
    if (!dirty) { status('saved'); return result(); }
    running = drain();
    try { return await running; } finally { running = null; }
  }

  async function resolve(choice) {
    if (!['local', 'remote'].includes(choice)) throw new Error('Выберите local или remote.');
    if (!conflict || closed) return result();
    cancelTimer();
    if (running) await running;
    const savedConflict = copy(conflict);
    status('syncing');
    try {
      const remote = await getRemote();
      refreshLocal();
      let selected;
      if (savedConflict.source === 'browser') {
        selected = mergeStates(savedConflict.baseState, current, savedConflict.remoteState, choice).state;
        if (remote.state !== null) {
          selected = savedConflict.databaseBaseState === null
            ? (equal(selected, remote.state) || choice === 'local' ? selected : remote.state)
            : mergeStates(savedConflict.databaseBaseState, selected, remote.state, choice).state;
        }
      } else {
        selected = remote.state === null || savedConflict.baseState === null
          ? (choice === 'local' || remote.state === null ? current : remote.state)
          : mergeStates(savedConflict.baseState, current, remote.state, choice).state;
      }
      // Keep the versions after resolution as a recovery record; a new conflict replaces it.
      storage.setItem(`${conflictKey}-resolved`, JSON.stringify({ ...savedConflict, choice, resolvedAt: new Date().toISOString() }));
      publish(selected);
      saveMeta(remote);
      conflict = null;
      storage.removeItem(conflictKey);
      dirty = !equal(current, remote.state);
      return await flush();
    } catch (error) { offline(error); return result(); }
  }

  function handleStorage(event) {
    if (closed || event.key !== key || event.newValue === null) return;
    try {
      const incoming = retainDictionaryKeys(validateImport(event.newValue), current);
      if (equal(incoming, current)) { publish(current); return; }
      let previous = current;
      if (event.oldValue !== null && event.oldValue !== undefined) {
        try { previous = validateImport(event.oldValue); } catch { /* Missing legacy baseline: preserve keys, use the current snapshot. */ }
      }
      const otherTab = copy(current);
      const merged = current ? mergeStates(previous, incoming, current) : { state: incoming, conflicts: [] };
      publish(merged.state);
      if (merged.conflicts.length) {
        rememberConflict({ state: otherTab, revision, updatedAt }, merged, previous,
          { source: 'browser', databaseBaseState: copy(baseState) });
      } else queue(current);
    } catch (error) { offline(error); }
  }

  function close() { closed = true; cancelTimer(); }
  return { start, queue, flush, resolve, handleStorage, close };
}
