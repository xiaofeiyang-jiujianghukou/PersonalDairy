import type {
  Entry,
  EntryCreateInput,
  EntryUpdateInput,
  MonthSummary,
  SearchResult,
  SummaryReadResult,
} from '@diary/shared';

const API_BASE_KEY = 'diary.apiBase';

/** 读取用户配置的日记服务器地址(留空 = 同源,即当前页面自带的日记服务)。 */
export function getApiBase(): string {
  try {
    return (localStorage.getItem(API_BASE_KEY) ?? '').trim().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** 设置日记服务器地址(手机端 App 指向你电脑上的日记服务)。 */
export function setApiBase(value: string): void {
  try {
    localStorage.setItem(API_BASE_KEY, value.trim());
  } catch {
    /* 忽略 */
  }
}

function resolve(url: string): string {
  const base = getApiBase();
  return base ? `${base}${url}` : url;
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolve(url), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () =>
    http<{
      ok: boolean;
      aiConfigured: boolean;
      textModel: string;
      visionModel: string;
      dataDir: string;
    }>('/api/health'),

  listByDate: (date: string) => http<Entry[]>(`/api/entries?date=${date}`),
  listByMonth: (month: string) => http<Entry[]>(`/api/entries?month=${month}`),

  create: (input: EntryCreateInput) =>
    http<Entry>('/api/entries', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: EntryUpdateInput) =>
    http<Entry>(`/api/entries/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: string) => http<{ ok: boolean }>(`/api/entries/${id}`, { method: 'DELETE' }),

  search: (q: string) => http<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),

  summaryRead: (month: string) => http<SummaryReadResult>(`/api/summary?month=${month}`),
  summaryGenerate: (month: string) =>
    http<{ summary: MonthSummary; model: string }>('/api/summary', {
      method: 'POST',
      body: JSON.stringify({ month }),
    }),
};

/** 导出下载地址(带服务器基址)。 */
export function exportUrl(): string {
  return resolve('/api/export');
}
