import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { openDatabase, RevisionConflict, StateValidationError } from './database.mjs';
import { createServer } from './server.mjs';
import { defaultState, dateKey } from './core.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'way-db-test-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('way-db-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return {
    directory,
    open(options = {}) { const database = openDatabase({ dataDir: directory, ...options }); closers.push(() => database.close()); return database; },
    async server() {
      const server = createServer({ dataDir: directory });
      assert.equal(server.listening, false);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      let stopped = false;
      const close = () => new Promise((resolve, reject) => {
        if (stopped) { resolve(); return; }
        stopped = true;
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      closers.push(close);
      return { server, close, port: server.address().port };
    },
  };
}

const sample = answer => { const state = defaultState(); state.answers.testQuestion = answer; return state; };

function request(port, route = '/api/state', { method = 'GET', headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: {
      'X-Way-Client': 'local-v1', ...(data === undefined ? {} : { 'Content-Type': 'application/json', ...(chunked ? {} : { 'Content-Length': Buffer.byteLength(data) }) }), ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined && chunked) {
      for (let start = 0; start < data.length; start += 32_000) req.write(data.slice(start, start + 32_000));
      req.end();
    } else req.end(data);
  });
}

test('SQLite state survives close and reopen with revision and timestamp intact', t => {
  const f = fixture(t);
  const database = f.open({ now: () => new Date('2026-09-30T12:00:00Z') });
  assert.deepEqual(database.read(), { state: null, revision: 0, updatedAt: null });
  const state = sample('Синтетический тестовый ответ');
  const saved = database.write(state, 0);
  assert.deepEqual(saved, { revision: 1, updatedAt: '2026-09-30T12:00:00.000Z' });
  database.close();
  const reopened = f.open();
  assert.deepEqual(reopened.read(), { state, ...saved });
  assert.deepEqual(reopened.listBackups(), { snapshots: [], daily: [] });
});

test('optimistic concurrency across two connections prevents overwriting newer answers', t => {
  const f = fixture(t), first = f.open(), second = f.open();
  first.write(sample('Первая версия'), 0);
  assert.throws(() => second.write(sample('Устаревшая версия'), 0), error => {
    assert.ok(error instanceof RevisionConflict);
    assert.equal(error.current.revision, 1);
    assert.equal(error.current.state.answers.testQuestion, 'Первая версия');
    return true;
  });
  assert.equal(second.read().revision, 1);
  assert.equal(first.listBackups().snapshots.length, 0);
  second.write(sample('Актуальное изменение'), 1);
  assert.equal(first.read().state.answers.testQuestion, 'Актуальное изменение');
});

test('changed writes create immutable first daily backups and retain 50 previous revisions', t => {
  const f = fixture(t);
  let now = new Date(2026, 8, 30, 12);
  const database = f.open({ now: () => now });
  database.write(sample('v1'), 0);
  database.write(sample('v2'), 1);
  const firstFile = path.join(f.directory, 'backups', `${dateKey(now)}.json`);
  const initialBackup = readFileSync(firstFile, 'utf8');
  assert.equal(JSON.parse(initialBackup).state.answers.testQuestion, 'v1');
  database.write(sample('v3'), 2);
  assert.equal(readFileSync(firstFile, 'utf8'), initialBackup);
  now = new Date(2026, 9, 1, 12);
  for (let revision = 3; revision < 56; revision++) database.write(sample(`v${revision + 1}`), revision);
  const backups = database.listBackups();
  assert.equal(backups.snapshots.length, 50);
  assert.equal(backups.snapshots[0].revision, 55);
  assert.equal(backups.snapshots.at(-1).revision, 6);
  assert.equal(backups.daily.length, 2);
  assert.equal(backups.daily[0].revision, 3);
  assert.equal(JSON.stringify(backups).includes('state'), false);
  assert.equal(readdirSync(path.join(f.directory, 'backups')).some(name => name.endsWith('.tmp')), false);
});

test('identical normalized state does not create a new revision or backup', t => {
  const database = fixture(t).open();
  const state = sample('same');
  state.answers.second = 'other';
  const result = database.write(state, 0);
  state.answers = { second: 'other', testQuestion: 'same' };
  assert.deepEqual(database.write(state, 1), result);
  assert.deepEqual(database.listBackups(), { snapshots: [], daily: [] });
});

test('invalid input and failed pre-write backup leave the saved state intact', t => {
  const f = fixture(t), database = f.open();
  database.write(sample('Safe version'), 0);
  for (const invalid of [{ version: 2 }, { version: 1, profile: { income: -1 } }]) assert.throws(() => database.write(invalid, 1), StateValidationError);
  assert.throws(() => database.write(sample('Bad revision'), 1.5), StateValidationError);
  writeFileSync(path.join(f.directory, 'backups', `${dateKey()}.json`), 'broken backup');
  assert.throws(() => database.write(sample('Must not save'), 1));
  assert.equal(database.read().revision, 1);
  assert.equal(database.read().state.answers.testQuestion, 'Safe version');
});

test('HTTP API survives a server restart and returns actionable conflicts and backup metadata', async t => {
  const f = fixture(t);
  let running = await f.server();
  const empty = await request(running.port);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { state: null, revision: 0, updatedAt: null });
  const first = await request(running.port, '/api/state', { method: 'POST', body: { state: sample('Persisted answer'), baseRevision: 0 } });
  assert.equal(first.status, 200);
  assert.equal(first.json.revision, 1);
  await running.close();
  running = await f.server();
  const restored = await request(running.port);
  assert.equal(restored.json.state.answers.testQuestion, 'Persisted answer');
  assert.equal(restored.json.updatedAt, first.json.updatedAt);
  const conflict = await request(running.port, '/api/state', { method: 'POST', body: { state: sample('Stale answer'), baseRevision: 0 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.revision, 1);
  assert.equal(conflict.json.state.answers.testQuestion, 'Persisted answer');
  const second = await request(running.port, '/api/state', { method: 'POST', body: { state: sample('Updated answer'), baseRevision: 1 } });
  assert.equal(second.status, 200);
  const backups = await request(running.port, '/api/backups');
  assert.equal(backups.json.snapshots.length, 1);
  assert.equal(backups.json.daily.length, 1);
  assert.equal(backups.text.includes('Persisted answer'), false);
  assert.equal(backups.text.includes('state'), false);
  for (const route of ['/private/way.sqlite', '/private/way.sqlite-wal', '/private/backups/2026-09-30.json', '/database.mjs', '/.git/config', '/%2e%2e%2fpackage.json']) assert.equal((await request(running.port, route)).status, 404, route);
});

test('HTTP host, origin and client-header checks protect reads and writes', async t => {
  const { port } = await fixture(t).server();
  for (const headers of [
    { Host: `evil.example:${port}` }, { Host: `127.0.0.1.evil.example:${port}` }, { Host: 'localhost:65536' },
    { Host: 'localhost:0' }, { Host: `2130706433:${port}` }, { Origin: 'https://evil.example' },
    { Origin: 'null' }, { Origin: `http://localhost:${port}` },
    { 'X-Way-Client': '' }, { 'X-Way-Client': 'wrong' }, { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    assert.equal((await request(port, '/api/state', { headers })).status, 403, JSON.stringify(headers));
    assert.equal((await request(port, '/api/state', { method: 'POST', headers, body: { state: sample('Unsafe'), baseRevision: 0 } })).status, 403, JSON.stringify(headers));
  }
  const accepted = await request(port, '/api/state', { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers['access-control-allow-origin'], undefined);
  assert.equal(accepted.headers['cache-control'], 'no-store');
  assert.equal((await request(port)).json.revision, 0);
});

test('HTTP rejects malformed, oversized, and invalid writes without mutating storage', async t => {
  const { port } = await fixture(t).server();
  for (const [options, status] of [
    [{ body: '{invalid' }, 400],
    [{ body: { state: { version: 2 }, baseRevision: 0 } }, 400],
    [{ body: { state: sample('x'), baseRevision: -1 } }, 400],
    [{ body: { state: sample('x'), baseRevision: 0, extra: true } }, 400],
    [{ body: { state: sample('x') } }, 400],
    [{ headers: { 'Content-Type': 'text/plain' }, body: '{}' }, 415],
    [{ body: 'x'.repeat(2_000_001) }, 413],
    [{ body: 'x'.repeat(2_000_001), chunked: true }, 413],
  ]) assert.equal((await request(port, '/api/state', { method: 'POST', ...options })).status, status);
  assert.equal((await request(port, '/api/state', { method: 'PUT', body: '{}' })).status, 405);
  assert.equal((await request(port)).json.revision, 0);
});
