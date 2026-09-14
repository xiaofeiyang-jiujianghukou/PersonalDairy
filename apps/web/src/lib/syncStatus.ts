/**
 * 同步状态提示(全局):"同步中…" → "同步成功 N 条" → 3 秒后消失。
 *
 * 引擎在"发现自己的水位低于最高水位"时开始向对端索取,并在这里广播状态;
 * 界面只需订阅,不必关心同步细节。
 */
export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'done'; merged: number };

type Listener = (s: SyncStatus) => void;
const listeners = new Set<Listener>();
let current: SyncStatus = { kind: 'idle' };

export function onSyncStatus(cb: Listener): () => void {
  listeners.add(cb);
  cb(current);
  return () => {
    listeners.delete(cb);
  };
}

export function emitSyncStatus(s: SyncStatus): void {
  current = s;
  for (const l of listeners) {
    try {
      l(s);
    } catch {
      /* 单个订阅者出错不影响其它 */
    }
  }
}

/** 引擎事件 → 界面状态。 */
export function handleEngineSyncEvent(e: { phase: 'start' | 'done'; merged?: number }): void {
  if (e.phase === 'start') {
    emitSyncStatus({ kind: 'syncing' });
    return;
  }
  // 一条都没同步到 → 不弹"同步成功 0 条数据"(那是误导,而且很吵)
  if ((e.merged ?? 0) <= 0) {
    emitSyncStatus({ kind: 'idle' });
    return;
  }
  emitSyncStatus({ kind: 'done', merged: e.merged ?? 0 });
}
