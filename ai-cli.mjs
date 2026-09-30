import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDatabase } from './database.mjs';
import { createAIBridge, validateAIReview, AIReviewValidationError, AIReviewConflict } from './ai-bridge.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

class CLIError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function localServerURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { throw new CLIError('INVALID_SERVER_URL', 'WAY_SERVER_URL должен указывать на локальный HTTP-сервер localhost или 127.0.0.1 без пути.'); }
}

function loadReview(filename) {
  let buffer;
  try { buffer = readFileSync(path.resolve(filename)); }
  catch { throw new CLIError('REVIEW_FILE_UNAVAILABLE', 'Не удалось прочитать файл обзора.'); }
  if (buffer.length > 200_000) throw new CLIError('INVALID_REVIEW', 'Файл обзора превышает лимит 200 КБ.');
  let data;
  try { data = JSON.parse(buffer.toString('utf8')); }
  catch { throw new CLIError('INVALID_REVIEW', 'Файл обзора содержит некорректный JSON.'); }
  return validateAIReview(data);
}

function exportMetadata(result, transport) {
  return { operation: 'export', transport, ok: !!result.ok, revision: result.revision ?? null,
    currentRevision: result.currentRevision ?? null, exportedAt: result.exportedAt ?? null,
    exportId: result.exportId ?? null, files: result.files ?? null, automaticAI: false,
    error: result.ok ? null : 'Выгрузка AI не обновлена. Проверьте локальный контекст и папку данных.' };
}

function reviewMetadata(result, transport) {
  return { operation: 'review', transport, ok: !!result.review && !result.error,
    sourceRevision: result.review?.sourceRevision ?? null, generatedAt: result.review?.generatedAt ?? null,
    status: result.review?.status ?? null, stale: !!result.stale, dataChanged: !!result.dataChanged,
    currentRevision: result.currentRevision ?? null, updatedAt: result.updatedAt ?? null,
    aiExport: result.aiExport ? { ok: !!result.aiExport.ok, revision: result.aiExport.revision ?? null } : null,
    error: result.error ? 'Обзор не подтверждён. Проверьте текущие данные и формат обзора.' : null };
}

async function tryAPI(origin, operation, document) {
  let response;
  try {
    response = await fetch(`${origin}/api/ai/${operation === 'export' ? 'export' : 'review'}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { 'X-Way-Client': 'local-v1', 'Content-Type': 'application/json' },
      body: JSON.stringify(operation === 'export' ? {} : { review: document }),
    });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw new CLIError('API_UNAVAILABLE', 'Локальный API не ответил надёжно. Повторите запрос; автоматическая offline-запись после таймаута не выполняется.');
  }
  // An older local server has no AI routes. Opening the same SQLite directly
  // is then safe from an older server's nonexistent AI exporter.
  if ([404, 405].includes(response.status)) return null;
  if (!response.ok) {
    const message = response.status === 409 ? 'Обзор не сохранён: на диске уже есть более новая версия. Прочитайте текущий обзор и подготовьте обновление.'
      : response.status === 400 ? 'Обзор или запрос не прошёл проверку локального API.'
      : `Локальный API вернул ошибку ${response.status}; offline-перезапись не выполняется.`;
    throw new CLIError(response.status === 409 ? 'REVIEW_CONFLICT' : 'API_ERROR', message);
  }
  let result;
  try { result = await response.json(); }
  catch { throw new CLIError('INVALID_API_RESPONSE', 'Локальный API вернул непонятный ответ; offline-перезапись не выполняется.'); }
  if (operation === 'export' && typeof result?.ok !== 'boolean' || operation === 'review' && !result?.review) throw new CLIError('INVALID_API_RESPONSE', 'Локальный API вернул неполный результат.');
  return operation === 'export' ? exportMetadata(result, 'api') : reviewMetadata(result, 'api');
}

/** Returns metadata only. It never starts a server or edits application records. */
export async function runCLI(args = process.argv.slice(2), env = process.env) {
  const [operation, filename, ...extra] = args;
  if (!['export', 'review'].includes(operation) || extra.length || operation === 'export' && filename !== undefined || operation === 'review' && !filename) throw new CLIError('USAGE', 'Использование: node ai-cli.mjs export | node ai-cli.mjs review путь-к-обзору.json');
  const document = operation === 'review' ? loadReview(filename) : null;
  const dataDir = path.resolve(env.WAY_DATA_DIR || path.join(root, 'private'));
  // A custom data directory must not accidentally target the default browser's
  // database. It uses files directly unless its server URL is explicitly given.
  const origin = env.WAY_SERVER_URL ? localServerURL(env.WAY_SERVER_URL)
    : env.WAY_DATA_DIR ? null : localServerURL(`http://127.0.0.1:${env.PORT || 4173}`);
  if (origin) {
    const result = await tryAPI(origin, operation, document);
    if (result) return result;
  }
  const database = openDatabase({ dataDir });
  try {
    const bridge = createAIBridge({ dataDir });
    if (operation === 'export') return exportMetadata(bridge.exportSnapshot(database.read()), 'offline');
    const result = bridge.writeReview(document, database.read().revision);
    const aiExport = bridge.exportSnapshot(database.read());
    return reviewMetadata({ ...result, aiExport }, 'offline');
  } finally { database.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCLI();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof CLIError ? error.code : error instanceof AIReviewConflict ? 'REVIEW_CONFLICT' : error instanceof AIReviewValidationError ? 'INVALID_REVIEW' : 'LOCAL_ERROR';
    const message = error instanceof CLIError ? error.message : error instanceof AIReviewConflict ? 'Более старый обзор не может заменить текущий.'
      : error instanceof AIReviewValidationError ? 'Обзор не прошёл проверку формата или версии базы.' : 'Локальная операция не завершена. Проверьте Node.js, доступ к базе и папке AI.';
    // No raw review, answers, financial data or parser excerpts reach stdout.
    process.stdout.write(`${JSON.stringify({ ok: false, operation: ['export', 'review'].includes(process.argv[2]) ? process.argv[2] : null, code, error: message })}\n`);
    process.exitCode = 1;
  }
}
