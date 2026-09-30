import { createRequire } from 'node:module';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateImport, dateKey } from './core.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'private');
const HISTORY_LIMIT = 50;

export class RevisionConflict extends Error {
  constructor(current) {
    super('Данные уже изменились в другой вкладке. Загрузите актуальную версию перед сохранением.');
    this.name = 'RevisionConflict';
    this.current = current;
  }
}

export class StateValidationError extends Error {
  constructor(message) { super(message); this.name = 'StateValidationError'; }
}

function canonicalJSON(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

function loadSQLite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (typeof DatabaseSync !== 'function') throw new Error('Missing DatabaseSync');
    return DatabaseSync;
  } catch {
    throw new Error('Локальная база требует Node.js с модулем node:sqlite. Запустите приложение встроенным Node.js 24 или установите поддерживаемую версию Node.js.');
  }
}

function rowResult(row) {
  return row ? { state: validateImport(JSON.parse(row.state_json)), revision: row.revision, updatedAt: row.updated_at }
    : { state: null, revision: 0, updatedAt: null };
}

function backupEnvelope(filename) {
  const data = JSON.parse(readFileSync(filename, 'utf8'));
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 1 || typeof data.updatedAt !== 'string' || !data.state) throw new Error('Повреждена ежедневная резервная копия.');
  validateImport(data.state);
  return data;
}

/** SQLite and backups live only in the private, gitignored data directory. */
export function openDatabase({ dataDir = process.env.WAY_DATA_DIR || DEFAULT_DATA_DIR, now = () => new Date() } = {}) {
  const DatabaseSync = loadSQLite();
  const directory = path.resolve(dataDir);
  const backupsDir = path.join(directory, 'backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  let db;
  try {
    db = new DatabaseSync(path.join(directory, 'way.sqlite'));
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersion > 1) throw new Error('Версия базы новее приложения. Обновите приложение; база не изменена.');
    db.exec(`
      CREATE TABLE IF NOT EXISTS way_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS way_history (
        revision INTEGER PRIMARY KEY CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        state_json TEXT NOT NULL
      );
      PRAGMA user_version=1;
    `);
    rowResult(db.prepare('SELECT revision, updated_at, state_json FROM way_state WHERE id=1').get());
  } catch (error) {
    try { db?.close(); } catch {}
    throw new Error(`Не удалось открыть локальную базу; существующие записи не перезаписаны. ${error.message}`);
  }

  let closed = false;
  const currentRow = db.prepare('SELECT revision, updated_at, state_json FROM way_state WHERE id=1');
  const read = () => rowResult(currentRow.get());

  function dailyBackup(row, date) {
    const filename = path.join(backupsDir, `${dateKey(date)}.json`);
    if (existsSync(filename)) { backupEnvelope(filename); return; }
    const temporary = path.join(backupsDir, `.${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ revision: row.revision, updatedAt: row.updated_at, state: JSON.parse(row.state_json) }, null, 2), 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      // Atomically publish a complete file without replacing the day's first backup.
      try { linkSync(temporary, filename); }
      catch (error) { if (error.code !== 'EEXIST') throw error; backupEnvelope(filename); }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  function write(state, baseRevision) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new StateValidationError('baseRevision должен быть целым неотрицательным числом.');
    let validated;
    try { validated = validateImport(state); }
    catch (error) { throw new StateValidationError(error.message); }
    const json = canonicalJSON(validated);
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      const previous = currentRow.get();
      const current = rowResult(previous);
      if (current.revision !== baseRevision) throw new RevisionConflict(current);
      if (previous?.state_json === json) {
        db.exec('COMMIT'); transaction = false;
        return { revision: current.revision, updatedAt: current.updatedAt };
      }
      const timestamp = now();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) throw new Error('Некорректное время сохранения.');
      const updatedAt = timestamp.toISOString();
      const revision = current.revision + 1;
      if (previous) {
        dailyBackup(previous, timestamp);
        db.prepare('INSERT INTO way_history(revision,updated_at,state_json) VALUES (?,?,?)').run(previous.revision, previous.updated_at, previous.state_json);
      }
      db.prepare(`INSERT INTO way_state(id,revision,updated_at,state_json) VALUES (1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,state_json=excluded.state_json`).run(revision, updatedAt, json);
      db.prepare('DELETE FROM way_history WHERE revision NOT IN (SELECT revision FROM way_history ORDER BY revision DESC LIMIT ?)').run(HISTORY_LIMIT);
      db.exec('COMMIT'); transaction = false;
      return { revision, updatedAt };
    } catch (error) {
      if (transaction) { try { db.exec('ROLLBACK'); } catch {} }
      throw error;
    }
  }

  function listBackups() {
    const snapshots = db.prepare('SELECT revision,updated_at,length(CAST(state_json AS BLOB)) AS bytes FROM way_history ORDER BY revision DESC').all()
      .map(row => ({ revision: row.revision, updatedAt: row.updated_at, bytes: row.bytes }));
    const daily = readdirSync(backupsDir).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse().map(name => {
      const filename = path.join(backupsDir, name);
      const envelope = backupEnvelope(filename);
      return { date: name.slice(0, -5), revision: envelope.revision, updatedAt: envelope.updatedAt, bytes: statSync(filename).size };
    });
    return { snapshots, daily };
  }

  return { dataDir: directory, read, write, listBackups, close() { if (!closed) { db.close(); closed = true; } } };
}
