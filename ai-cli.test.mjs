import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { openDatabase } from './database.mjs';
import { defaultState } from './core.mjs';
import { createServer } from './server.mjs';

const CLI = fileURLToPath(new URL('./ai-cli.mjs', import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'way-cli-test-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('way-cli-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const database = openDatabase({ dataDir: directory });
  closers.push(() => database.close());
  return {
    directory, database,
    run(args, env = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true, env: { ...process.env, WAY_DATA_DIR: directory, WAY_SERVER_URL: '', ...env } });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject);
        child.on('close', status => {
          let json; try { json = JSON.parse(stdout); } catch {}
          resolve({ status, stdout, stderr, json });
        });
      });
    },
    async server(legacy = false) {
      const server = legacy ? http.createServer((_req, res) => { res.writeHead(404); res.end('Old server'); }) : createServer({ dataDir: directory });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      closers.push(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
      return `http://127.0.0.1:${server.address().port}`;
    },
  };
}

function draft(sourceRevision, generatedAt = new Date().toISOString()) {
  return { version: 1, sourceRevision, generatedAt, author: 'Synthetic test author', status: 'accepted', summary: 'DO_NOT_LOG_REVIEW_CONTENT',
    actions: [], dailyConclusion: null, weeklyConclusion: null, questions: [] };
}

test('offline CLI exports a live SQLite connection without changing records or logging private data', async t => {
  const f = fixture(t), state = defaultState();
  state.answers.values = 'DO_NOT_LOG_PRIVATE_ANSWER';
  f.database.write(state, 0);
  const result = await f.run(['export']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.transport, 'offline');
  assert.equal(result.json.revision, 1);
  assert.equal(result.stdout.includes(state.answers.values), false);
  assert.equal(result.json.automaticAI, false);
  assert.deepEqual(f.database.read().state, state);
  assert.equal(f.database.read().revision, 1);
  const exported = JSON.parse(readFileSync(path.join(f.directory, 'ai', 'snapshot.json'), 'utf8'));
  assert.equal(exported.state.answers.values, state.answers.values);
});

test('offline CLI validates and archives advice while keeping the database revision unchanged', async t => {
  const f = fixture(t); f.database.write(defaultState(), 0);
  const filename = path.join(f.directory, 'candidate.json');
  const first = draft(1, '2026-09-01T12:00:00.000Z');
  writeFileSync(filename, JSON.stringify(first));
  let result = await f.run(['review', filename]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.sourceRevision, 1);
  assert.equal(result.json.status, 'accepted');
  assert.equal(result.stdout.includes(first.summary), false);
  writeFileSync(filename, JSON.stringify(draft(1, '2026-09-02T12:00:00.000Z')));
  result = await f.run(['review', filename]);
  assert.equal(result.status, 0);
  assert.equal(readdirSync(path.join(f.directory, 'ai', 'review-history')).length, 1);
  assert.equal(f.database.read().revision, 1);
  writeFileSync(filename, JSON.stringify(first));
  result = await f.run(['review', filename]);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, 'REVIEW_CONFLICT');
  writeFileSync(filename, JSON.stringify(draft(2)));
  result = await f.run(['review', filename]);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, 'INVALID_REVIEW');
  assert.equal(f.database.read().revision, 1);
});

test('CLI prefers the explicitly selected API and returns only metadata for accepted reviews', async t => {
  const f = fixture(t); f.database.write(defaultState(), 0);
  const origin = await f.server();
  let result = await f.run(['export'], { WAY_SERVER_URL: origin });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.transport, 'api');
  assert.equal(result.json.revision, 1);
  const filename = path.join(f.directory, 'candidate.json');
  writeFileSync(filename, JSON.stringify(draft(1)));
  result = await f.run(['review', filename], { WAY_SERVER_URL: origin });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.transport, 'api');
  assert.equal(result.json.currentRevision, 1);
  assert.equal(result.stdout.includes('DO_NOT_LOG_REVIEW_CONTENT'), false);
  assert.equal(result.stdout.includes('Synthetic test author'), false);
  assert.equal(f.database.read().revision, 1);
});

test('CLI falls back for an older local server that does not implement AI API routes', async t => {
  const f = fixture(t); f.database.write(defaultState(), 0);
  const origin = await f.server(true);
  const result = await f.run(['export'], { WAY_SERVER_URL: origin });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.transport, 'offline');
  assert.equal(result.json.revision, 1);
});

test('CLI reports invalid JSON and nonlocal URLs without echoing file contents', async t => {
  const f = fixture(t), filename = path.join(f.directory, 'bad.json');
  writeFileSync(filename, '{ "summary": "DO_NOT_LOG_BROKEN_REVIEW" invalid }');
  let result = await f.run(['review', filename]);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, 'INVALID_REVIEW');
  assert.equal(result.stdout.includes('DO_NOT_LOG_BROKEN_REVIEW'), false);
  assert.equal(result.stderr.includes('DO_NOT_LOG_BROKEN_REVIEW'), false);
  result = await f.run(['export'], { WAY_SERVER_URL: 'https://example.org' });
  assert.equal(result.status, 1);
  assert.equal(result.json.code, 'INVALID_SERVER_URL');
  assert.equal(f.database.read().revision, 0);
});

test('CLI export failure is visible but cannot erase committed application data', async t => {
  const f = fixture(t); f.database.write(defaultState(), 0);
  writeFileSync(path.join(f.directory, 'ai'), 'Blocked destination');
  const result = await f.run(['export']);
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.equal(f.database.read().revision, 1);
});
