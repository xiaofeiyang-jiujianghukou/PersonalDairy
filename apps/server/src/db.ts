import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  Entry,
  EntryCreateInput,
  EntryUpdateInput,
  MonthSummary,
  SearchResult,
} from '@diary/shared';

let db: DatabaseSync | null = null;

/**
 * 初始化数据库(建库、建表)与迁移。
 * 使用 Node 内置 sqlite,零原生依赖。
 */
export function initDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
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

    -- 账号鉴权(本期用户名+密码;手机号/微信登录预留)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL UNIQUE,      -- 稳定公开用户ID(微信式,非账号)
      username TEXT NOT NULL UNIQUE, -- 登录账号(可改,每半年一次)
      password_hash TEXT NOT NULL,
      nickname TEXT,                 -- 昵称
      avatar TEXT,                   -- 头像(diary-img 引用)
      username_changed_at TEXT,      -- 上次改账号时间(半年冷却)
      email TEXT,                    -- 绑定的邮箱(可解绑)
      phone TEXT,                    -- 预留:手机号登录
      oauth TEXT,                    -- 预留:微信/OAuth 标识
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- P2:跨网络密文中继(先落桶、再取走;只存加密载荷,不通读)
    CREATE TABLE IF NOT EXISTS relay (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      from_device TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_relay_user ON relay(user_id, consumed);
  `);
  migrateIfNeeded(db);
  getDeviceId(db); // 确保本设备标识存在
  return db;
}

/** 检测旧版(自增整数 id)表并把数据迁移为 UUID 主键 + 墓碑结构。 */
function migrateIfNeeded(d: DatabaseSync): void {
  // 用户表补齐新列(找回密码/资料:uid/nickname/avatar/username_changed_at/email)
  const ucols = (d.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
  const addCol = (name: string, def: string) => {
    if (!ucols.includes(name)) d.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
  };
  addCol('uid', 'TEXT');
  addCol('nickname', 'TEXT');
  addCol('avatar', 'TEXT');
  addCol('username_changed_at', 'TEXT');
  addCol('email', 'TEXT');
  // 给老用户补 uid + 昵称(uid 作为稳定身份,账号可改)
  const noUid = d.prepare('SELECT id, username FROM users WHERE uid IS NULL').all() as Array<{ id: number; username: string }>;
  for (const u of noUid) {
    d.prepare('UPDATE users SET uid = ?, nickname = COALESCE(nickname, username), username_changed_at = created_at WHERE id = ?').run(randomUUID(), u.id);
  }

  const cols = (d.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (cols.includes('deleted_at')) return; // 已是 v2

  const rows = d.prepare('SELECT id, date, content, created_at, updated_at FROM entries').all() as
    Array<Record<string, unknown>>;
  const device = getDeviceId(d);

  d.exec('BEGIN');
  try {
    d.exec('DROP TABLE IF EXISTS entries');
    d.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        content TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
    `);
    const ins = d.prepare(
      'INSERT INTO entries (id, date, content, device_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) {
      ins.run(
        String(randomUUID()),
        String(r.date),
        String(r.content),
        String(device),
        String(r.created_at),
        String(r.updated_at),
        null,
      );
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function getDeviceId(d: DatabaseSync): string {
  const row = d.prepare("SELECT value FROM meta WHERE key = 'device_id'").get() as
    | { value: string }
    | undefined;
  if (row?.value) return row.value;
  const id = randomUUID();
  d.prepare("INSERT INTO meta (key, value) VALUES ('device_id', ?)").run(id);
  return id;
}

function getDb(): DatabaseSync {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

const nowIso = () => new Date().toISOString();

function rowToEntry(row: Record<string, unknown>): Entry {
  return {
    id: String(row.id),
    date: String(row.date),
    content: String(row.content),
    deviceId: row.device_id ? String(row.device_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  };
}

/** 读接口统一排除已删除(墓碑)的记录。 */
const NOT_DELETED = 'deleted_at IS NULL';

export function listEntriesByDate(date: string): Entry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM entries WHERE date = ? AND ${NOT_DELETED} ORDER BY created_at ASC, id ASC`)
    .all(date) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function listEntriesByMonth(month: string): Entry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM entries WHERE date LIKE ? AND ${NOT_DELETED} ORDER BY date ASC, created_at ASC, id ASC`,
    )
    .all(`${month}-%`) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function listAllEntries(): Entry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM entries WHERE ${NOT_DELETED} ORDER BY date ASC, created_at ASC, id ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function getEntry(id: string): Entry | null {
  const row = getDb().prepare('SELECT * FROM entries WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEntry(row) : null;
}

export function createEntry(input: EntryCreateInput): Entry {
  const ts = nowIso();
  const id = randomUUID();
  const device = getDeviceId(getDb());
  getDb()
    .prepare(
      'INSERT INTO entries (id, date, content, device_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, input.date, input.content, device, ts, ts, null);
  return {
    id,
    date: input.date,
    content: input.content,
    deviceId: device,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  };
}

export function updateEntry(id: string, input: EntryUpdateInput): Entry | null {
  const existing = getEntry(id);
  if (!existing) return null;
  const date = input.date ?? existing.date;
  const content = input.content ?? existing.content;
  const ts = nowIso();
  const device = getDeviceId(getDb());
  getDb()
    .prepare('UPDATE entries SET date = ?, content = ?, device_id = ?, updated_at = ? WHERE id = ?')
    .run(date, content, device, ts, id);
  return getEntry(id);
}

/** 软删除:写墓碑(deleted_at),同步时据此传播删除,而非物理删除。 */
export function deleteEntry(id: string): boolean {
  const ts = nowIso();
  const res = getDb()
    .prepare('UPDATE entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(ts, ts, id);
  return res.changes > 0;
}

/** 彻底清理已删除条目(供未来手动/归档使用)。 */
export function purgeDeleted(): number {
  const res = getDb().prepare('DELETE FROM entries WHERE deleted_at IS NOT NULL').run();
  return Number(res.changes);
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
      `SELECT * FROM entries WHERE content LIKE ? ESCAPE '\\' AND ${NOT_DELETED} ORDER BY date DESC, id DESC LIMIT 100`,
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
      id: String(row.id),
      date: String(row.date),
      content,
      snippet,
    };
  });
}

/** 导出全量条目(含墓碑),供同步交换。 */
export function getAllEntriesForSync(): Entry[] {
  const rows = getDb().prepare('SELECT * FROM entries ORDER BY id ASC').all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToEntry);
}

/**
 * 把另一设备送来的条目合并进本地(last-writer-wins,按 updated_at)。
 * 返回被采用(写入)的条数。
 */
export function applySyncedEntries(entries: Entry[]): number {
  const d = getDb();
  const stmt = d.prepare('SELECT updated_at FROM entries WHERE id = ?');
  const upsert = d.prepare(
    `INSERT INTO entries (id, date, content, device_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       date = excluded.date,
       content = excluded.content,
       device_id = excluded.device_id,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`,
  );
  let applied = 0;
  d.exec('BEGIN');
  try {
    for (const e of entries) {
      if (!e || typeof e.id !== 'string' || typeof e.date !== 'string' || typeof e.content !== 'string') {
        continue;
      }
      const row = stmt.get(e.id) as { updated_at: string } | undefined;
      if (row && e.updatedAt <= row.updated_at) continue; // 本地更新,跳过
      upsert.run(e.id, e.date, e.content, e.deviceId ?? '', e.createdAt, e.updatedAt, e.deletedAt ?? null);
      applied++;
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return applied;
}

/** 计算当月日记的内容指纹,用于判断小结是否需要重新生成。 */
export function entriesHash(entries: Entry[]): string {
  const payload = entries.map((e) => `${e.id}|${e.updatedAt}|${e.content}`).join('\n');
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

// ================= 账号鉴权 =================

export interface AuthUser {
  id: number;
  uid: string | null;
  username: string;
  nickname: string | null;
  avatar: string | null;
  email: string | null;
  phone: string | null;
  oauth: string | null;
}

/** scrypt 密码哈希:盐:hash(64 字节)。 */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = scryptSync(pw, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** 修改用户密码(校验后由调用方保证身份;成功返回 true)。 */
export function changePassword(userId: number, newPassword: string): boolean {
  const hash = hashPassword(newPassword);
  const ts = nowIso();
  const res = getDb()
    .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hash, ts, userId);
  return res.changes > 0;
}

export function createUser(username: string, password: string, email?: string | null): AuthUser | null {
  const ts = nowIso();
  const hash = hashPassword(password);
  const uid = randomUUID();
  try {
    const res = getDb()
      .prepare('INSERT INTO users (uid, username, password_hash, nickname, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uid, username, hash, username, email ?? null, ts, ts);
    return { id: Number(res.lastInsertRowid), uid, username, nickname: username, avatar: null, email: email ?? null, phone: null, oauth: null };
  } catch {
    return null; // 用户名冲突等
  }
}

/** 用已哈希的密码建用户(注册邮箱验证通过后,不重复哈希)。 */
export function createUserWithHash(username: string, passwordHash: string, email?: string | null): AuthUser | null {
  const ts = nowIso();
  const uid = randomUUID();
  try {
    const res = getDb()
      .prepare('INSERT INTO users (uid, username, password_hash, nickname, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uid, username, passwordHash, username, email ?? null, ts, ts);
    return { id: Number(res.lastInsertRowid), uid, username, nickname: username, avatar: null, email: email ?? null, phone: null, oauth: null };
  } catch {
    return null;
  }
}

export function findUserByUsername(username: string): (AuthUser & { passwordHash: string }) | null {
  const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    uid: row.uid ? String(row.uid) : null,
    username: String(row.username),
    nickname: row.nickname ? String(row.nickname) : null,
    avatar: row.avatar ? String(row.avatar) : null,
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    oauth: row.oauth ? String(row.oauth) : null,
    passwordHash: String(row.password_hash),
  };
}

/** 绑定/更新用户的邮箱。 */
export function setUserEmail(userId: number, email: string): boolean {
  const ts = nowIso();
  const res = getDb().prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(email, ts, userId);
  return res.changes > 0;
}

/** 解绑邮箱。 */
export function unbindEmail(userId: number): boolean {
  const ts = nowIso();
  const res = getDb().prepare('UPDATE users SET email = NULL, updated_at = ? WHERE id = ?').run(ts, userId);
  return res.changes > 0;
}

/** 更新昵称/头像。 */
export function updateProfile(userId: number, fields: { nickname?: string; avatar?: string | null }): boolean {
  const sets: string[] = [];
  const vals: Array<string | null> = [];
  if (typeof fields.nickname === 'string') {
    sets.push('nickname = ?');
    vals.push(fields.nickname.trim());
  }
  if (fields.avatar !== undefined) {
    sets.push('avatar = ?');
    vals.push(fields.avatar);
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  vals.push(nowIso());
  vals.push(String(userId));
  const res = getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return res.changes > 0;
}

/** 修改登录账号(半年冷却)。成功返回 true;冷却期返回 false。 */
export function changeUsername(userId: number, oldChangedAt: string | null, newUsername: string): boolean {
  const ts = nowIso();
  const cooldown = 180 * 24 * 3600 * 1000; // 半年
  if (oldChangedAt) {
    const last = new Date(oldChangedAt).getTime();
    if (Date.now() - last < cooldown) return false;
  }
  const res = getDb()
    .prepare('UPDATE users SET username = ?, username_changed_at = ?, updated_at = ? WHERE id = ?')
    .run(newUsername, ts, ts, userId);
  return res.changes > 0;
}

/** 按邮箱找用户(注册时判断邮箱是否已被占用)。 */
export function findUserByEmail(email: string): { id: number; username: string } | null {
  const row = getDb().prepare('SELECT id, username FROM users WHERE email = ?').get(email) as
    | { id: number; username: string }
    | undefined;
  return row ?? null;
}

export function createSession(userId: number, ttlMs = 30 * 24 * 3600 * 1000): string {
  const token = randomBytes(32).toString('hex');
  const ts = nowIso();
  const exp = new Date(Date.now() + ttlMs).toISOString();
  getDb()
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, ts, exp);
  return token;
}

export function getUserByToken(token: string): AuthUser | null {
  const row = getDb()
    .prepare(
      `SELECT u.id, u.uid, u.username, u.nickname, u.avatar, u.email, u.phone, u.oauth FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, nowIso()) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    uid: row.uid ? String(row.uid) : null,
    username: String(row.username),
    nickname: row.nickname ? String(row.nickname) : null,
    avatar: row.avatar ? String(row.avatar) : null,
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    oauth: row.oauth ? String(row.oauth) : null,
  };
}

export function deleteSession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** 按 id 取完整公开资料(含账号修改时间,用于展示/改资料)。 */
export function getUserById(userId: number): {
  id: number;
  uid: string | null;
  username: string;
  nickname: string | null;
  avatar: string | null;
  email: string | null;
  usernameChangedAt: string | null;
} | null {
  const row = getDb().prepare('SELECT id, uid, username, nickname, avatar, email, username_changed_at FROM users WHERE id = ?').get(userId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    uid: row.uid ? String(row.uid) : null,
    username: String(row.username),
    nickname: row.nickname ? String(row.nickname) : null,
    avatar: row.avatar ? String(row.avatar) : null,
    email: row.email ? String(row.email) : null,
    usernameChangedAt: row.username_changed_at ? String(row.username_changed_at) : null,
  };
}

/** 删除某用户的所有会话(密码重置后强制重新登录)。 */
export function deleteSessionsForUser(userId: number): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ================= 跨网络中继(P2:先落桶、再取走,只存加密载荷) =================

export function putRelay(userId: number, fromDevice: string, payload: string): void {
  getDb()
    .prepare('INSERT INTO relay (user_id, from_device, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, fromDevice, payload, nowIso());
}

/** 取走"非本设备"发出的未消费载荷,并标记已消费(由对端处理)。 */
export function pullRelay(
  userId: number,
  exclDevice: string,
  limit = 50,
): Array<{ id: number; from: string; payload: string }> {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const rows = d
      .prepare(
        'SELECT id, from_device, payload FROM relay WHERE user_id=? AND consumed=0 AND from_device<>? ORDER BY id ASC LIMIT ?',
      )
      .all(userId, exclDevice, limit) as Array<Record<string, unknown>>;
    if (rows.length) {
      const ids = rows.map((r) => Number(r.id));
      const placeholders = ids.map(() => '?').join(',');
      d.prepare(`UPDATE relay SET consumed=1 WHERE id IN (${placeholders})`).run(...ids);
    }
    d.exec('COMMIT');
    return rows.map((r) => ({ id: Number(r.id), from: String(r.from_device), payload: String(r.payload) }));
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}
