import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDatabase, RevisionConflict, StateValidationError } from './database.mjs';
import { createAIBridge, AIReviewValidationError, AIReviewConflict } from './ai-bridge.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Set(['index.html', 'styles.css', 'app.mjs', 'content.mjs', 'core.mjs', 'evidence.mjs', 'sync.mjs', 'personal-plan.mjs', 'budget.mjs', 'today.mjs', 'favicon.svg']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const MAX_BODY_BYTES = 2_000_000;
const responseHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

class HTTPError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJSON(res, status, data) {
  res.writeHead(status, { ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function validateRequestSource(req) {
  const host = req.headers.host;
  const match = typeof host === 'string' && /^(127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?$/.exec(host);
  if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) throw new HTTPError(403, 'Доступ разрешён только через localhost или 127.0.0.1.');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new HTTPError(403, 'Разрешены только локальные подключения.');
  const origin = `http://${host}`;
  if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new HTTPError(403, 'Запрос с другого адреса запрещён.');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HTTPError(403, 'Межсайтовый запрос запрещён.');
  return origin;
}

function readJSON(req) {
  if (!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(req.headers['content-type'] || '')) throw new HTTPError(415, 'Ожидался Content-Type: application/json.');
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) { req.resume(); throw new HTTPError(413, 'Запрос превышает лимит 2 МБ.'); }
  return new Promise((resolve, reject) => {
    let total = 0;
    let chunks = [];
    let exceeded = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!exceeded) { exceeded = true; chunks = []; reject(new HTTPError(413, 'Запрос превышает лимит 2 МБ.')); }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HTTPError(400, 'Некорректный JSON.')); }
    });
    req.on('aborted', () => reject(new HTTPError(400, 'Передача данных прервана.')));
    req.on('error', () => reject(new HTTPError(400, 'Не удалось прочитать запрос.')));
  });
}

/** Create an isolated local server; importing this module never opens a port. */
export function createServer({ dataDir, now } = {}) {
  const storage = openDatabase({ dataDir, now });
  const ai = createAIBridge({ dataDir: storage.dataDir, now });
  const refreshAIExport = () => {
    try { return ai.exportSnapshot(storage.read()); }
    catch { return { ...ai.status(), ok: false, error: 'Выгрузка AI не обновлена; сохранение данных приложения проверяется отдельно.' }; }
  };
  refreshAIExport();
  const server = http.createServer(async (req, res) => {
    try {
      const origin = validateRequestSource(req);
      let url;
      try { url = new URL(req.url, origin); }
      catch { throw new HTTPError(400, 'Некорректный адрес запроса.'); }
      if (url.origin !== origin) throw new HTTPError(403, 'Адрес запроса не совпадает с локальным сервером.');
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-way-client'] !== 'local-v1') throw new HTTPError(403, 'Отсутствует заголовок локального приложения.');
        if (url.pathname === '/api/state' && req.method === 'GET') { sendJSON(res, 200, storage.read()); return; }
        if (url.pathname === '/api/backups' && req.method === 'GET') { sendJSON(res, 200, storage.listBackups()); return; }
        if (url.pathname === '/api/ai/export' && req.method === 'GET') { sendJSON(res, 200, ai.status(storage.read().revision)); return; }
        if (url.pathname === '/api/ai/export' && req.method === 'POST') {
          const input = await readJSON(req);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new HTTPError(400, 'Обновление выгрузки принимает пустой объект JSON.');
          sendJSON(res, 200, refreshAIExport()); return;
        }
        if (url.pathname === '/api/ai/context' && req.method === 'GET') {
          if (!ai.status().ok) throw new HTTPError(503, 'Выгрузка контекста AI недоступна; проверьте /api/ai/export. Данные приложения сохранены отдельно.');
          res.writeHead(200, { ...responseHeaders, 'Content-Type': 'text/markdown; charset=utf-8' });
          res.end(ai.contextMarkdown()); return;
        }
        if (url.pathname === '/api/ai/review' && req.method === 'GET') { sendJSON(res, 200, ai.readReview(storage.read().revision)); return; }
        if (url.pathname === '/api/ai/review' && req.method === 'POST') {
          const input = await readJSON(req);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'review')) throw new HTTPError(400, 'Ожидалось единственное поле review.');
          const result = ai.writeReview(input.review, storage.read().revision);
          sendJSON(res, 200, { ...result, aiExport: refreshAIExport() }); return;
        }
        if (url.pathname === '/api/state' && req.method === 'POST') {
          const input = await readJSON(req);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['state', 'baseRevision'].includes(key)) || !Object.hasOwn(input, 'state') || !Object.hasOwn(input, 'baseRevision')) throw new HTTPError(400, 'Ожидались поля state и baseRevision.');
          const result = storage.write(input.state, input.baseRevision);
          // Export failure is independent of the already committed DB write.
          sendJSON(res, 200, { ...result, aiExport: refreshAIExport() }); return;
        }
        throw new HTTPError(['/api/state', '/api/backups', '/api/ai/export', '/api/ai/context', '/api/ai/review'].includes(url.pathname) ? 405 : 404, 'Метод или адрес API не поддерживается.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HTTPError(405, 'Метод не поддерживается.');
      let file;
      try { file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); }
      catch { throw new HTTPError(400, 'Некорректный адрес файла.'); }
      if (!publicFiles.has(file) && file !== 'private/context.json') throw new HTTPError(404, 'Файл не найден.');
      const filename = file === 'private/context.json' ? path.join(storage.dataDir, 'context.json') : path.join(root, file);
      let data;
      try { data = await readFile(filename); }
      catch (error) { if (error.code === 'ENOENT') throw new HTTPError(404, 'Файл не найден.'); throw error; }
      res.writeHead(200, { ...responseHeaders, 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      if (error instanceof RevisionConflict) { sendJSON(res, 409, { error: error.message, ...error.current }); return; }
      if (error instanceof AIReviewConflict) { sendJSON(res, 409, { ...error.current, error: error.message }); return; }
      if (error instanceof AIReviewValidationError) { sendJSON(res, 400, { error: error.message }); return; }
      if (error instanceof StateValidationError) { sendJSON(res, 400, { error: error.message }); return; }
      if (error instanceof HTTPError) { sendJSON(res, error.status, { error: error.message }); return; }
      sendJSON(res, 500, { error: 'Локальная база или файл недоступны. Сохранение не подтверждено; сохраните резервную копию и повторите запрос.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => storage.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = process.env.PORT === undefined ? 4173 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
    const server = createServer();
    server.on('error', error => { console.error(`Не удалось запустить локальный сервер: ${error.code || 'ошибка подключения'}.`); process.exitCode = 1; server.close(); });
    server.listen(port, '127.0.0.1', () => console.log(`Путь маленьких шагов: http://127.0.0.1:${server.address().port}`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
