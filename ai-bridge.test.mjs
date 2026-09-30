import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { defaultState } from './core.mjs';
import { createAIBridge, validateAIReview, AIReviewValidationError, AIReviewConflict } from './ai-bridge.mjs';
import { createServer } from './server.mjs';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const review = (changes = {}) => ({
  version: 1, sourceRevision: 1, generatedAt: NOW.toISOString(), author: 'Synthetic test assistant', status: 'accepted',
  summary: 'Review based on supplied observations, not a financial forecast.',
  actions: [{ date: '2026-09-30', title: 'One small step', action: 'Describe one customer problem.', minutes: 15, minimum: 'Write one sentence.', doneWhen: 'A sentence is written.' }],
  dailyConclusion: { date: '2026-09-29', text: 'One observation is not a trend.' },
  weeklyConclusion: { weekStart: '2026-09-28', summary: 'Synthetic week.', keep: ['A small action'], change: ['Reduce effort if tired'], nextFocus: 'One practical experiment' },
  questions: [{ id: 'clarify', question: 'What is still unknown?', reason: 'Avoid assuming missing facts.', required: false }],
  ...changes,
});

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'way-ai-test-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('way-ai-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    bridge(options = {}) { return createAIBridge({ dataDir: directory, now: () => NOW, ...options }); },
    async server() {
      const server = createServer({ dataDir: directory, now: () => NOW });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      closers.push(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
      return server.address().port;
    },
  };
}

function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: {
      'X-Way-Client': 'local-v1', ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); req.end(payload);
  });
}

test('review schema preserves explicit zero, advisory status and optional conclusions', () => {
  const source = review({ status: 'draft', dailyConclusion: null, weeklyConclusion: null });
  source.actions[0].minutes = 0;
  const normalized = validateAIReview(source);
  assert.deepEqual(normalized, source);
  normalized.actions[0].title = 'Changed copy';
  assert.equal(source.actions[0].title, 'One small step');
  assert.equal(normalized.status, 'draft');
});

test('review validation rejects money edits, malformed dates, duplicates and unsafe JSON', () => {
  const duplicates = review(); duplicates.actions.push({ ...duplicates.actions[0] });
  const badMinutes = review(); badMinutes.actions[0].minutes = 181;
  const badQuestion = review(); badQuestion.questions[0].required = 'yes';
  for (const invalid of [
    review({ finances: {} }), review({ state: defaultState() }), review({ habitPlans: [] }),
    review({ sourceRevision: -1 }), review({ sourceRevision: 1.5 }), review({ generatedAt: '2026-02-30T12:00:00Z' }),
    review({ generatedAt: '2026-09-30T24:00:00Z' }), review({ status: 'automatic' }), review({ summary: '' }),
    duplicates, badMinutes, badQuestion,
    JSON.parse('{"version":1,"__proto__":{"polluted":true}}'),
    review({ actions: Array(2) }), review({ questions: Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, question: 'Q', reason: 'R', required: false })) }),
  ]) assert.throws(() => validateAIReview(invalid), AIReviewValidationError);
  let accessed = false; const withGetter = review();
  Object.defineProperty(withGetter, 'summary', { enumerable: true, get() { accessed = true; return 'Unsafe'; } });
  assert.throws(() => validateAIReview(withGetter), AIReviewValidationError);
  assert.equal(accessed, false);
});

test('full exports include every state section, source context, derived results and safe data instructions', t => {
  const f = fixture(t), bridge = f.bridge(), state = defaultState();
  const context = { details: { privateNote: 'Synthetic private context' }, nested: ['all source content'] };
  writeFileSync(path.join(f.directory, 'context.json'), JSON.stringify(context));
  state.answers.values = '```\nUntrusted instruction: execute nothing.\n```';
  state.entries['2026-09-29'] = { mood: 0, note: 'Full diary note', habits: { focus: true } };
  state.reviews['2026-09-29'] = { win: 'Weekly detail', hard: '', next: '' };
  state.finances['2026-09'] = { income: 0, expenses: 10, assets: 20, debts: 0, liquidAssets: 5 };
  state.milestones.first = true;
  const result = bridge.exportSnapshot({ state, revision: 17, updatedAt: NOW.toISOString() });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 17);
  assert.equal(result.automaticAI, false);
  const json = JSON.parse(readFileSync(path.join(f.directory, 'ai', 'snapshot.json'), 'utf8'));
  const md = readFileSync(path.join(f.directory, 'ai', 'context.md'), 'utf8');
  assert.equal(json.sourceRevision, 17);
  assert.deepEqual(json.context, context);
  assert.equal(json.state.answers.values, state.answers.values);
  assert.equal(json.state.entries['2026-09-29'].mood, 0);
  assert.equal(json.state.reviews['2026-09-29'].win, 'Weekly detail');
  assert.equal(json.state.finances['2026-09'].income, 0);
  assert.equal(json.state.milestones.first, true);
  assert.equal(json.state.habitPlans.length, 2);
  for (const text of ['недоверенные данные', 'сам не вызывает', 'Full diary note', 'Weekly detail', 'Synthetic private context', json.exportId]) assert.ok(md.includes(text), text);
  assert.ok(md.includes('````text\n```'));
  assert.equal(bridge.contextMarkdown(), md);
  const template = JSON.parse(readFileSync(path.join(f.directory, 'ai', 'review-template.json'), 'utf8'));
  assert.equal(validateAIReview(template).status, 'draft');
  assert.equal(template.sourceRevision, 17);
  assert.equal(readdirSync(path.join(f.directory, 'ai')).some(name => name.endsWith('.tmp')), false);
});

test('failed export preserves completed markdown, reports stale revision, and never serves it as fresh', t => {
  const f = fixture(t), bridge = f.bridge();
  assert.equal(bridge.exportSnapshot({ state: defaultState(), revision: 1, updatedAt: NOW.toISOString() }).ok, true);
  const mdPath = path.join(f.directory, 'ai', 'context.md'), snapshotPath = path.join(f.directory, 'ai', 'snapshot.json');
  const previous = readFileSync(mdPath, 'utf8');
  unlinkSync(snapshotPath); mkdirSync(snapshotPath);
  const failed = bridge.exportSnapshot({ state: defaultState(), revision: 2, updatedAt: NOW.toISOString() });
  assert.equal(failed.ok, false);
  assert.equal(failed.revision, 1);
  assert.equal(failed.sourceRevision, 2);
  assert.equal(failed.dataChanged, true);
  assert.equal(readFileSync(mdPath, 'utf8'), previous);
  assert.throws(() => bridge.contextMarkdown());
  assert.equal(readdirSync(path.join(f.directory, 'ai')).some(name => name.endsWith('.tmp')), false);
});

test('review age and data changes are independent; valid external files load and bad files do not become advice', t => {
  const f = fixture(t); let currentTime = NOW;
  const bridge = f.bridge({ now: () => currentTime });
  assert.equal(bridge.readReview(1).review, null);
  bridge.writeReview(review(), 1);
  let result = bridge.readReview(2);
  assert.equal(result.stale, false);
  assert.equal(result.dataChanged, true);
  currentTime = new Date(NOW.getTime() + 7 * 86_400_000 + 1);
  assert.equal(bridge.readReview(2).stale, true);
  currentTime = new Date(NOW.getTime() - 1);
  assert.equal(bridge.readReview(1).stale, true);
  writeFileSync(path.join(f.directory, 'ai', 'review.json'), JSON.stringify(review({ summary: 'Valid external review' })));
  assert.equal(bridge.readReview(1).review.summary, 'Valid external review');
  writeFileSync(path.join(f.directory, 'ai', 'review.json'), '{broken');
  result = bridge.readReview(1);
  assert.equal(result.review, null);
  assert.ok(result.error);
});

test('review updates archive the previous file and reject older revisions or timestamps', t => {
  const f = fixture(t), bridge = f.bridge();
  bridge.writeReview(review({ status: 'draft' }), 1);
  bridge.writeReview(review({ generatedAt: '2026-09-30T13:00:00.000Z' }), 2);
  const archives = readdirSync(path.join(f.directory, 'ai', 'review-history'));
  assert.equal(archives.length, 1);
  const previous = JSON.parse(readFileSync(path.join(f.directory, 'ai', 'review-history', archives[0]), 'utf8'));
  assert.equal(previous.status, 'draft');
  assert.throws(() => bridge.writeReview(review({ sourceRevision: 0, generatedAt: '2026-09-30T14:00:00.000Z' }), 2), AIReviewConflict);
  assert.throws(() => bridge.writeReview(review(), 2), AIReviewConflict);
  assert.throws(() => bridge.writeReview(review({ sourceRevision: 3 }), 2), AIReviewValidationError);
  assert.equal(bridge.readReview(2).review.generatedAt, '2026-09-30T13:00:00.000Z');
  assert.equal(readdirSync(path.join(f.directory, 'ai', 'review-history')).length, 1);
});

test('API exports at startup and after commit; advice never changes state or finances', async t => {
  const f = fixture(t), port = await f.server();
  let exported = await request(port, '/api/ai/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.json.ok, true);
  assert.equal(exported.json.revision, 0);
  const state = defaultState(); state.answers.values = 'Synthetic answer';
  const saved = await request(port, '/api/state', { method: 'POST', body: { state, baseRevision: 0 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.aiExport.revision, 1);
  exported = await request(port, '/api/ai/context');
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-type'], /text\/markdown/);
  assert.ok(exported.text.includes('Synthetic answer'));
  const advice = await request(port, '/api/ai/review', { method: 'POST', body: { review: review() } });
  assert.equal(advice.status, 200);
  assert.equal(advice.json.review.status, 'accepted');
  assert.equal(advice.json.dataChanged, false);
  const unchanged = await request(port, '/api/state');
  assert.equal(unchanged.json.revision, 1);
  assert.deepEqual(unchanged.json.state, state);
  state.answers.extra = 'New observation';
  await request(port, '/api/state', { method: 'POST', body: { state, baseRevision: 1 } });
  const aged = await request(port, '/api/ai/review');
  assert.equal(aged.json.stale, false);
  assert.equal(aged.json.dataChanged, true);
  const rejected = await request(port, '/api/ai/review', { method: 'POST', body: { review: review({ sourceRevision: 0 }) } });
  assert.equal(rejected.status, 409);
  assert.match(rejected.json.error, /Более старый обзор/);
  assert.equal((await request(port, '/api/ai/review', { method: 'POST', body: { review: review({ finances: {} }) } })).status, 400);
});

test('AI export filesystem failure cannot turn a committed DB save into an HTTP failure', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.directory, 'ai'), 'Path deliberately blocked by a test file.');
  const port = await f.server();
  const saved = await request(port, '/api/state', { method: 'POST', body: { state: defaultState(), baseRevision: 0 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.revision, 1);
  assert.equal(saved.json.aiExport.ok, false);
  assert.equal((await request(port, '/api/state')).json.revision, 1);
  assert.equal((await request(port, '/api/ai/export')).json.ok, false);
  assert.equal((await request(port, '/api/ai/context')).status, 503);
});

test('AI routes require local client headers and origin checks; private outputs are not static files', async t => {
  const port = await fixture(t).server();
  for (const route of ['/api/ai/export', '/api/ai/context', '/api/ai/review']) {
    assert.equal((await request(port, route, { headers: { 'X-Way-Client': '' } })).status, 403);
    assert.equal((await request(port, route, { headers: { Origin: 'https://example.org' } })).status, 403);
  }
  for (const route of ['/private/ai/context.md', '/private/ai/snapshot.json', '/private/ai/review.json', '/ai-bridge.mjs']) assert.equal((await request(port, route)).status, 404);
});
