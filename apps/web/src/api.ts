import type {
  Entry,
  EntryCreateInput,
  EntryUpdateInput,
  MonthSummary,
  SearchResult,
  SummaryReadResult,
} from '@diary/shared';

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
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
  update: (id: number, input: EntryUpdateInput) =>
    http<Entry>(`/api/entries/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: number) => http<{ ok: boolean }>(`/api/entries/${id}`, { method: 'DELETE' }),

  search: (q: string) => http<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),

  summaryRead: (month: string) => http<SummaryReadResult>(`/api/summary?month=${month}`),
  summaryGenerate: (month: string) =>
    http<{ summary: MonthSummary; model: string }>('/api/summary', {
      method: 'POST',
      body: JSON.stringify({ month }),
    }),
};
