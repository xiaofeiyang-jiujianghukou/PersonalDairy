/**
 * 数据变更通知:同步把对端条目合并进本地后,通知当前打开的视图重新读取,
 * 避免"数据已同步、界面却要手动切标签页才刷新"。
 */
type Cb = () => void;
const subs = new Set<Cb>();

/** 订阅数据变更,返回取消订阅函数。 */
export function onDataChanged(cb: Cb): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** 广播"本地数据已变更"(如同步合并了新条目)。 */
export function emitDataChanged(): void {
  for (const cb of Array.from(subs)) {
    try {
      cb();
    } catch {
      /* 单个订阅者出错不影响其它 */
    }
  }
}
