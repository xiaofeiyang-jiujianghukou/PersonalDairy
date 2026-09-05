import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  Entry,
  EntryCreateInput,
  EntryUpdateInput,
  MonthSummary,
  SearchResult,
} from '@diary/shared';

let db: DatabaseSync | null = null;

/** 初始化数据库(建库、建表)。使用 Node 内置 sqlite,零原生依赖。 */
export function initDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);

    CREATE TABLE IF NOT EXISTS summaries (
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      content TEXT NOT NULL,
      entries_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (year, month)
    );
  `);
  return db;
}

function getDb(): DatabaseSync {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

const nowIso = () => new Date().toISOString();

function rowToEntry(row: Record<string, unknown>): Entry {
  return {
    id: Number(row.id),
    date: String(row.date),
    content: String(row.content),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listEntriesByDate(date: string): Entry[] {
  const rows = getDb()
    .prepare('SELECT * FROM entries WHERE date = ? ORDER BY created_at ASC, id ASC')
    .all(date) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function listEntriesByMonth(month: string): Entry[] {
  const rows = getDb()
    .prepare('SELECT * FROM entries WHERE date LIKE ? ORDER BY date ASC, created_at ASC, id ASC')
    .all(`${month}-%`) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function listAllEntries(): Entry[] {
  const rows = getDb()
    .prepare('SELECT * FROM entries ORDER BY date ASC, created_at ASC, id ASC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function getEntry(id: number): Entry | null {
  const row = getDb().prepare('SELECT * FROM entries WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEntry(row) : null;
}

export function createEntry(input: EntryCreateInput): Entry {
  const ts = nowIso();
  const res = getDb()
    .prepare('INSERT INTO entries (date, content, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(input.date, input.content, ts, ts);
  const id = Number(res.lastInsertRowid);
  return {
    id,
    date: input.date,
    content: input.content,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function updateEntry(id: number, input: EntryUpdateInput): Entry | null {
  const existing = getEntry(id);
  if (!existing) return null;
  const date = input.date ?? existing.date;
  const content = input.content ?? existing.content;
  const ts = nowIso();
  getDb()
    .prepare('UPDATE entries SET date = ?, content = ?, updated_at = ? WHERE id = ?')
    .run(date, content, ts, id);
  return getEntry(id);
}

export function deleteEntry(id: number): boolean {
  const res = getDb().prepare('DELETE FROM entries WHERE id = ?').run(id);
  return res.changes > 0;
}

/** 转义 LIKE 通配符,实现字面量子串搜索。 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function searchEntries(query: string): SearchResult[] {
  const needle = query.trim();
  if (!needle) return [];
  const pattern = `%${escapeLike(needle)}%`;
  const rows = getDb()
    .prepare(
      "SELECT * FROM entries WHERE content LIKE ? ESCAPE '\\' ORDER BY date DESC, id DESC LIMIT 100",
    )
    .all(pattern) as Record<string, unknown>[];

  return rows.map((row) => {
    const content = String(row.content);
    const idx = content.toLowerCase().indexOf(needle.toLowerCase());
    const start = idx < 0 ? 0 : Math.max(0, idx - 24);
    const end = idx < 0 ? 80 : Math.min(content.length, idx + needle.length + 56);
    const snippet =
      (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
    return {
      id: Number(row.id),
      date: String(row.date),
      content,
      snippet,
    };
  });
}

/** 计算当月日记的内容指纹,用于判断小结是否需要重新生成。 */
export function entriesHash(entries: Entry[]): string {
  const payload = entries
    .map((e) => `${e.id}|${e.updatedAt}|${e.content}`)
    .join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

export function getSummary(year: number, month: number): MonthSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM summaries WHERE year = ? AND month = ?')
    .get(year, month) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    year: Number(row.year),
    month: Number(row.month),
    content: String(row.content),
    entriesHash: String(row.entries_hash),
    createdAt: String(row.created_at),
  };
}

export function upsertSummary(
  year: number,
  month: number,
  content: string,
  hash: string,
): MonthSummary {
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO summaries (year, month, content, entries_hash, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (year, month) DO UPDATE SET
         content = excluded.content,
         entries_hash = excluded.entries_hash,
         created_at = excluded.created_at`,
    )
    .run(year, month, content, hash, ts);
  return { year, month, content, entriesHash: hash, createdAt: ts };
}
