import type {
  Entry,
  EntryCreateInput,
  EntryUpdateInput,
  MonthSummary,
  SearchResult,
  SummaryReadResult,
} from '@diary/shared';

/** 本地存储后端抽象:IndexedDB(手机)或内存(测试/无痕)。 */
export interface LocalBackend {
  getAll(): Promise<Entry[]>;
  put(entries: Entry[]): Promise<void>;
}

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** 共享同一个 IndexedDB 数据库(entries + images 两个对象仓库,版本 2)。 */
const DB_NAME = 'personal-diary';
const DB_VERSION = 2;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** 内存后端(测试/无痕环境)。 */
export class MemoryBackend implements LocalBackend {
  private rows = new Map<string, Entry>();
  getAll(): Promise<Entry[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  put(entries: Entry[]): Promise<void> {
    for (const e of entries) this.rows.set(e.id, e);
    return Promise.resolve();
  }
}

/** IndexedDB 后端(手机 WebView / 浏览器离线存储)。 */
export class IdbBackend implements LocalBackend {
  private readonly store = 'entries';

  private tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return openDb().then((d) => d.transaction(this.store, mode).objectStore(this.store));
  }

  async getAll(): Promise<Entry[]> {
    const store = await this.tx('readonly');
    return new Promise<Entry[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as Entry[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async put(entries: Entry[]): Promise<void> {
    const store = await this.tx('readwrite');
    return new Promise<void>((resolve, reject) => {
      const tx = store.transaction;
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const e of entries) store.put(e);
    });
  }
}

// ---------- 图片库(内容寻址,blob 存储) ----------
export async function putImage(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('images', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore('images').put({ id, blob });
  });
}

export async function getImage(id: string): Promise<Blob | null> {
  const db = await openDb();
  return new Promise<Blob | null>((resolve, reject) => {
    const req = db.transaction('images', 'readonly').objectStore('images').get(id);
    req.onsuccess = () => resolve((req.result as { blob?: Blob } | null)?.blob ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function listImageIds(): Promise<string[]> {
  const db = await openDb();
  return new Promise<string[]>((resolve, reject) => {
    const req = db.transaction('images', 'readonly').objectStore('images').getAllKeys();
    req.onsuccess = () => resolve((req.result as string[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

const nowIso = () => new Date().toISOString();
// 真实设备标识(曾写死为 'phone' → 电脑端条目被标成手机来源,水位向量失真)
import { getDeviceId } from './device';
const DEVICE = (): string => getDeviceId();

/** 基于任意后端,构建与远端 api 同签名的方法(本地优先)。 */
export function createLocalApi(backend: LocalBackend) {
  async function withWrite(fn: (all: Entry[]) => Entry[]): Promise<void> {
    await backend.put(await fn(await backend.getAll()));
  }

  return {
    async listByDate(date: string): Promise<Entry[]> {
      return (await backend.getAll())
        .filter((e) => e.date === date && !e.deletedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async listByMonth(month: string): Promise<Entry[]> {
      return (await backend.getAll())
        .filter((e) => e.date.startsWith(month) && !e.deletedAt)
        .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    },
    async getAll(): Promise<Entry[]> {
      return (await backend.getAll()).filter((e) => !e.deletedAt);
    },
    async create(input: EntryCreateInput): Promise<Entry> {
      const ts = nowIso();
      const e: Entry = {
        id: uid(),
        date: input.date,
        content: input.content,
        deviceId: DEVICE(),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
      };
      await withWrite((all) => [...all, e]);
      return e;
    },
    async update(id: string, input: EntryUpdateInput): Promise<Entry | null> {
      const ts = nowIso();
      let updated: Entry | null = null;
      await withWrite((all) =>
        all.map((e) => {
          if (e.id !== id) return e;
          updated = { ...e, date: input.date ?? e.date, content: input.content ?? e.content, deviceId: DEVICE(), updatedAt: ts };
          return updated;
        }),
      );
      return updated;
    },
    async remove(id: string): Promise<{ ok: boolean }> {
      const ts = nowIso();
      let ok = false;
      await withWrite((all) =>
        all.map((e) => {
          if (e.id !== id || e.deletedAt) return e;
          ok = true;
          return { ...e, deletedAt: ts, deviceId: DEVICE(), updatedAt: ts };
        }),
      );
      return { ok };
    },
    async search(q: string): Promise<SearchResult[]> {
      const needle = q.trim().toLowerCase();
      if (!needle) return [];
      return (await backend.getAll())
        .filter((e) => !e.deletedAt && e.content.toLowerCase().includes(needle))
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((e) => {
          const idx = e.content.toLowerCase().indexOf(needle);
          const start = idx < 0 ? 0 : Math.max(0, idx - 20);
          const end = idx < 0 ? 80 : Math.min(e.content.length, idx + needle.length + 46);
          return {
            id: e.id,
            date: e.date,
            content: e.content,
            snippet: (start > 0 ? '…' : '') + e.content.slice(start, end) + (end < e.content.length ? '…' : ''),
          };
        });
    },
    summaryRead: async (_month: string): Promise<SummaryReadResult> => ({ exists: false }),
    summaryGenerate: async (_month: string): Promise<{ summary: MonthSummary; model: string }> => {
      throw new Error('本地模式暂不支持 AI 小结,请连接电脑后生成');
    },
    health: async () => ({ ok: true, aiConfigured: false, textModel: '', visionModel: '', dataDir: 'local' }),
  };
}

/** 便于测试:暴露后端。 */
export const _test = { MemoryBackend, createLocalApi };
