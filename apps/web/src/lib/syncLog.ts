import type { SyncLogCategory } from '@diary/shared/syncEngine';

/**
 * 结构化同步日志(每台终端独立存一份在 localStorage)。
 *
 * 相比旧的纯字符串数组,这里把每条日志拆成 { ts, cat, msg },让「日志管理」界面
 * 能按类别过滤(写日记 / 发通知 / 收通知 / 水位 / 区间 / 同步 / 错误),也便于导出。
 */

export interface SyncLogEntry {
  /** 完整 ISO 时间戳(UTC)。 */
  ts: string;
  cat: SyncLogCategory;
  msg: string;
}

export const SYNC_LOG_KEY = 'diary.synclog';
/** 单机最多保留多少条(旧日志滚动淘汰)。 */
const CAP = 800;

/** 类别 → 中文名(日志界面过滤按钮用)。 */
export const SYNC_LOG_CAT_LABELS: Record<SyncLogCategory, string> = {
  write: '写日记',
  notify: '发通知',
  recvNotify: '收通知',
  watermark: '水位',
  range: '区间',
  sync: '同步',
  error: '错误',
};

/** 追加一条日志。任何异常都吞掉(日志绝不能反过来影响业务)。 */
export function logSync(cat: SyncLogCategory, msg: string): void {
  try {
    const arr = readSyncLog();
    arr.push({ ts: new Date().toISOString(), cat, msg });
    localStorage.setItem(SYNC_LOG_KEY, JSON.stringify(arr.slice(-CAP)));
  } catch {
    /* 忽略:无 localStorage / 隐私模式等 */
  }
}

/** 读取全部日志(旧的在前)。兼容旧版「纯字符串数组」格式。 */
export function readSyncLog(): SyncLogEntry[] {
  try {
    const raw = localStorage.getItem(SYNC_LOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<SyncLogEntry | string>)
      .map((x): SyncLogEntry | null => {
        if (typeof x === 'string') {
          // 旧格式:字符串里自带 "HH:MM:SS.mmm " 前缀,没有类别 → 归入 sync
          const m = /^\d{2}:\d{2}:\d{2}\.\d{3}\s?(.*)$/.exec(x);
          return m ? { ts: '', cat: 'sync', msg: m[1] ?? x } : { ts: '', cat: 'sync', msg: x };
        }
        if (x && typeof x === 'object' && typeof (x as SyncLogEntry).msg === 'string') {
          return {
            ts: typeof (x as SyncLogEntry).ts === 'string' ? (x as SyncLogEntry).ts : '',
            cat: (x as SyncLogEntry).cat ?? 'sync',
            msg: (x as SyncLogEntry).msg,
          };
        }
        return null;
      })
      .filter((x): x is SyncLogEntry => Boolean(x));
  } catch {
    return [];
  }
}

/** 清空本机日志。 */
export function clearSyncLog(): void {
  try {
    localStorage.setItem(SYNC_LOG_KEY, '[]');
  } catch {
    /* 忽略 */
  }
}

/** 把日志渲染成可复制/导出的纯文本。 */
export function formatSyncLog(entries: SyncLogEntry[]): string {
  return entries
    .map((e) => {
      const t = e.ts ? new Date(e.ts).toISOString().slice(11, 23) : '--:--:--.---';
      return `${t} [${SYNC_LOG_CAT_LABELS[e.cat] ?? e.cat}] ${e.msg}`;
    })
    .join('\n');
}
