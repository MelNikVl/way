import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState } from './core.mjs';
import { createSync, mergeStates } from './sync.mjs';

const key = 'test-way';
const clone = value => JSON.parse(JSON.stringify(value));
function memory(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: name => data.get(name) ?? null, setItem: (name, value) => data.set(name, value), removeItem: name => data.delete(name) };
}
function fakeServer(initial = null) {
  const server = { state: clone(initial), revision: initial ? 1 : 0, updatedAt: initial ? '2026-09-30T10:00:00.000Z' : null, posts: [], online: true };
  server.payload = () => clone({ state: server.state, revision: server.revision, updatedAt: server.updatedAt });
  server.external = state => { server.state = clone(state); server.revision++; server.updatedAt = '2026-09-30T12:00:00.000Z'; };
  server.fetch = async (url, options = {}) => {
    assert.equal(url, '/api/state');
    assert.equal(options.headers['X-Way-Client'], 'local-v1');
    if (!server.online) throw new Error('Network offline');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      server.posts.push(body);
      if (body.baseRevision !== server.revision) return { ok: false, status: 409, json: async () => server.payload() };
      server.state = clone(body.state);
      server.revision++;
      server.updatedAt = '2026-09-30T11:00:00.000Z';
      // The production server acknowledges the revision without echoing private data.
      return { ok: true, status: 200, json: async () => ({ revision: server.revision, updatedAt: server.updatedAt }) };
    }
    return { ok: true, status: 200, json: async () => server.payload() };
  };
  return server;
}
function setup(server, local = null, base = null, request = server.fetch) {
  const storage = memory();
  if (local) storage.setItem(key, JSON.stringify(local));
  if (base) storage.setItem(`${key}-sync`, JSON.stringify(base));
  const statuses = [], states = [], scheduled = new Map();
  let sequence = 0;
  const timers = { setTimeout(fn) { const id = ++sequence; scheduled.set(id, fn); return id; }, clearTimeout(id) { scheduled.delete(id); } };
  const sync = createSync({ key, storage, fetch: request, timers, onStatus: value => statuses.push(value), onState: value => states.push(value) });
  const queue = state => { storage.setItem(key, JSON.stringify(state)); sync.queue(state); };
  return { sync, storage, statuses, states, queue, scheduled };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('migrates existing browser answers into an empty database and saves baseline', async () => {
  const local = defaultState(); local.answers.profession = 'Engineer';
  const server = fakeServer();
  const app = setup(server, local);
  const result = await app.sync.start(local, { hasLocal: true });
  assert.deepEqual(server.state, local);
  assert.equal(result.revision, 1);
  assert.deepEqual(JSON.parse(app.storage.getItem(`${key}-sync`)).baseState, local);
  assert.equal(app.statuses.at(-1).kind, 'saved');
  assert.equal(server.posts.length, 1);
});

test('a browser without local answers restores the database, not the default seed', async () => {
  const remote = defaultState(); remote.answers.profession = 'Designer';
  const server = fakeServer(remote);
  const app = setup(server);
  const result = await app.sync.start(defaultState(), { hasLocal: false });
  assert.deepEqual(result.state, remote);
  assert.deepEqual(JSON.parse(app.storage.getItem(key)), remote);
  assert.equal(app.states.length, 1);
  assert.equal(server.posts.length, 0);
});

test('disjoint offline answers and database edits merge and both survive a reload', async () => {
  const base = defaultState();
  const local = clone(base); local.answers.skills = 'SQL';
  const remote = clone(base); remote.answers.values = 'Family';
  const server = fakeServer(base); const baseline = server.payload(); server.external(remote);
  const app = setup(server, local, { baseState: baseline.state, ...baseline });
  const result = await app.sync.start(local);
  assert.equal(result.state.answers.skills, 'SQL');
  assert.equal(result.state.answers.values, 'Family');
  assert.deepEqual(result.state, server.state);
  assert.equal(app.statuses.at(-1).kind, 'saved');
});

test('different local and remote values without a baseline require a choice', async () => {
  const local = defaultState(); local.answers.profession = 'Engineer';
  const remote = clone(local); remote.answers.profession = 'Designer';
  const server = fakeServer(remote);
  const app = setup(server, local);
  await app.sync.start(local);
  assert.equal(app.statuses.at(-1).kind, 'conflict');
  assert.equal(server.posts.length, 0);
  assert.deepEqual(JSON.parse(app.storage.getItem(key)), local);
  const preserved = JSON.parse(app.storage.getItem(`${key}-conflict`));
  assert.deepEqual(preserved.localState, local);
  assert.deepEqual(preserved.remoteState, remote);
  await app.sync.resolve('remote');
  assert.deepEqual(JSON.parse(app.storage.getItem(key)), remote);
  assert.equal(app.statuses.at(-1).kind, 'saved');
});

test('same-answer conflict pauses uploads and a fresh resolution preserves disjoint changes', async () => {
  const base = defaultState(); base.answers.profession = 'Before';
  const local = clone(base); local.answers.profession = 'Local'; local.answers.skills = 'SQL';
  const remote = clone(base); remote.answers.profession = 'Remote'; remote.answers.values = 'Family';
  const server = fakeServer(base), baseline = server.payload(); server.external(remote);
  const app = setup(server, local, { baseState: baseline.state, ...baseline });
  await app.sync.start(local);
  assert.equal(app.statuses.at(-1).kind, 'conflict');
  assert.equal(app.statuses.at(-1).conflicts[0].path, 'answers.profession');
  const continued = clone(local); continued.answers.energy = 'Morning'; app.queue(continued);
  await app.sync.flush();
  assert.equal(server.posts.length, 0);
  remote.answers.newer = 'Added while deciding'; server.external(remote);
  await app.sync.resolve('local');
  assert.deepEqual(server.state.answers, { profession: 'Local', skills: 'SQL', energy: 'Morning', values: 'Family', newer: 'Added while deciding' });
  assert.equal(app.storage.getItem(`${key}-conflict`), null);
  assert.ok(app.storage.getItem(`${key}-conflict-resolved`));
});

test('a POST 409 merges latest DB changes and retries with the new revision', async () => {
  const base = defaultState(), server = fakeServer(base), app = setup(server, base);
  await app.sync.start(base);
  const remote = clone(base); remote.answers.values = 'Freedom'; server.external(remote);
  const local = clone(base); local.answers.skills = 'Python'; app.queue(local);
  await app.sync.flush();
  assert.deepEqual(server.state.answers, { skills: 'Python', values: 'Freedom' });
  assert.equal(server.posts.length, 2);
  assert.equal(server.posts[1].baseRevision, 2);
  assert.equal(app.statuses.at(-1).kind, 'saved');
});

test('typing while POST is in flight is coalesced into the next serialized write', async () => {
  const base = defaultState(), server = fakeServer(base), gate = deferred(), entered = deferred();
  let inFlight = 0, maximum = 0, held = false;
  const app = setup(server, base, null, async (url, options) => {
    if (options.method !== 'POST') return server.fetch(url, options);
    inFlight++; maximum = Math.max(maximum, inFlight);
    if (!held) { held = true; entered.resolve(); await gate.promise; }
    const response = await server.fetch(url, options); inFlight--; return response;
  });
  await app.sync.start(base);
  const first = clone(base); first.answers.profession = 'Eng'; app.queue(first);
  const saving = app.sync.flush(); await entered.promise;
  const second = clone(first); second.answers.profession = 'Engineer'; second.answers.skills = 'SQL'; app.queue(second);
  gate.resolve(); await saving;
  assert.deepEqual(server.state, second);
  assert.equal(server.posts.length, 2);
  assert.equal(maximum, 1);
  assert.equal(app.statuses.at(-1).kind, 'saved');
});

test('offline edits remain local and retry only on explicit flush or a new edit', async () => {
  const base = defaultState(), server = fakeServer(base), app = setup(server, base);
  await app.sync.start(base);
  server.online = false;
  const local = clone(base); local.answers.skills = 'SQL'; app.queue(local);
  await app.sync.flush();
  assert.equal(app.statuses.at(-1).kind, 'offline');
  assert.deepEqual(JSON.parse(app.storage.getItem(key)), local);
  assert.deepEqual(server.state, base);
  assert.equal(app.scheduled.size, 0);
  server.online = true; await app.sync.flush();
  assert.deepEqual(server.state, local);
  assert.equal(app.statuses.at(-1).kind, 'saved');
});

test('legacy tab storage changes are saved by the upgraded tab', async () => {
  const base = defaultState(), server = fakeServer(base), app = setup(server, base);
  await app.sync.start(base);
  const next = clone(base); next.answers.profession = 'New answer in old tab';
  app.storage.setItem(key, JSON.stringify(next));
  app.sync.handleStorage({ key, newValue: JSON.stringify(next) });
  await app.sync.flush();
  assert.deepEqual(server.state, next);
  assert.deepEqual(app.states.at(-1), next);
});

test('two stale legacy tabs retain each other’s missing answers while explicit empty answers clear', async () => {
  const base = defaultState(), server = fakeServer(base), app = setup(server, base);
  await app.sync.start(base);
  function legacyWrite(state) {
    const oldValue = app.storage.getItem(key), newValue = JSON.stringify(state);
    app.storage.setItem(key, newValue);
    app.sync.handleStorage({ key, oldValue, newValue });
  }
  const firstTab = clone(base); firstTab.answers.skills = 'SQL';
  legacyWrite(firstTab); await app.sync.flush();
  const secondTab = clone(base); secondTab.answers.values = 'Family';
  legacyWrite(secondTab); await app.sync.flush();
  assert.deepEqual(server.state.answers, { skills: 'SQL', values: 'Family' });
  firstTab.answers.skills = 'SQL and Python';
  legacyWrite(firstTab); await app.sync.flush();
  assert.deepEqual(server.state.answers, { skills: 'SQL and Python', values: 'Family' });
  secondTab.answers.values = '';
  legacyWrite(secondTab); await app.sync.flush();
  assert.deepEqual(server.state.answers, { skills: 'SQL and Python', values: '' });
  assert.deepEqual(JSON.parse(app.storage.getItem(key)), server.state);
  // A stale identical edit still repairs the storage value if it omitted retained keys.
  legacyWrite(secondTab);
  assert.deepEqual(JSON.parse(app.storage.getItem(key)), server.state);
});

test('concurrent same-answer browser conflict retains a pending other-tab version across reload', async () => {
  const base = defaultState(); base.answers.profession = 'Before';
  const server = fakeServer(base), app = setup(server, base);
  await app.sync.start(base);
  const pending = clone(base); pending.answers.profession = 'Pending in upgraded tab'; app.queue(pending);
  const incoming = clone(base); incoming.answers.profession = 'Legacy tab answer';
  app.storage.setItem(key, JSON.stringify(incoming));
  app.sync.handleStorage({ key, oldValue: JSON.stringify(base), newValue: JSON.stringify(incoming) });
  await app.sync.flush();
  assert.equal(app.statuses.at(-1).kind, 'conflict');
  assert.equal(server.posts.length, 0);
  const recovery = JSON.parse(app.storage.getItem(`${key}-conflict`));
  assert.equal(recovery.localState.answers.profession, 'Legacy tab answer');
  assert.equal(recovery.remoteState.answers.profession, 'Pending in upgraded tab');
  app.sync.close();
  const reloadedStatuses = [];
  const reloaded = createSync({ key, storage: app.storage, fetch: server.fetch, onStatus: value => reloadedStatuses.push(value) });
  await reloaded.start(JSON.parse(app.storage.getItem(key)));
  assert.equal(reloadedStatuses.at(-1).kind, 'conflict');
  assert.equal(server.posts.length, 0);
  await reloaded.resolve('remote');
  assert.equal(server.state.answers.profession, 'Pending in upgraded tab');
  assert.equal(reloadedStatuses.at(-1).kind, 'saved');
  reloaded.close();
});

test('offline first load reads DB before retry and never overwrites an unknown remote state', async () => {
  const local = defaultState(); local.answers.profession = 'Local';
  const remote = clone(local); remote.answers.profession = 'Remote';
  const server = fakeServer(remote); server.online = false;
  const app = setup(server, local); await app.sync.start(local);
  assert.equal(app.statuses.at(-1).kind, 'offline');
  server.online = true; await app.sync.flush();
  assert.equal(app.statuses.at(-1).kind, 'conflict');
  assert.equal(server.posts.length, 0);
  assert.deepEqual(server.state, remote);
});

test('merge respects deletions, atomic habit lists, and independent nested daily entries', () => {
  const base = { answers: { deleteMe: 'Old' }, habitPlans: [{ id: 'one', title: 'Old' }], entries: {} };
  const local = { answers: {}, habitPlans: [{ id: 'one', title: 'Local' }], entries: { today: { mood: 7 } } };
  const remote = { answers: { deleteMe: 'New' }, habitPlans: [{ id: 'one', title: 'Remote' }], entries: { today: { energy: 8 } } };
  const result = mergeStates(base, local, remote);
  assert.deepEqual(result.conflicts.map(value => value.path), ['answers.deleteMe', 'habitPlans']);
  assert.deepEqual(result.state.answers, {});
  assert.deepEqual(result.state.entries, { today: { mood: 7, energy: 8 } });
});
