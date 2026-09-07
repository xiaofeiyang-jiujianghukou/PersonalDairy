import type { Entry } from './index';

/**
 * 同步合并引擎 —— 只依赖数据模型,与传输方式(局域网直连 / 中继 / 隧道)无关。
 * 规则:同一 id 采用最后写入者胜出(last-writer-wins),按 updated_at 比较;
 *       若胜出方带 deleted_at,则删除(墓碑)在合并后生效。
 */

/** 取较新的那一条(同时间则取 a,保证确定性)。 */
export function newerEntry(a: Entry, b: Entry): Entry {
  return a.updatedAt >= b.updatedAt ? a : b;
}

/**
 * 把"来自另一设备的条目"合并进本地。
 * @param existing 本地已有条目(可能为 null)
 * @param incoming 另一设备送来的条目
 * @returns 应写入本地的结果;若本地更新或相等则返回 null(不采用)
 */
export function applyIncoming(existing: Entry | null, incoming: Entry): Entry | null {
  if (!existing) return incoming;
  // 仅当 incoming 严格更新时才覆盖,避免本地较新数据被旧数据回退
  if (incoming.updatedAt > existing.updatedAt) return incoming;
  return null;
}

/**
 * 一次性合并两个设备各自的全量条目(小数据量简易同步用,幂等)。
 * 返回合并后"应保存"的条目集(含墓碑),可据此写回任一端的存储。
 */
export function reconcileFull(ours: Entry[], theirs: Entry[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const e of ours) byId.set(e.id, e);
  for (const e of theirs) {
    const cur = byId.get(e.id);
    if (!cur) byId.set(e.id, e);
    else byId.set(e.id, newerEntry(cur, e));
  }
  return [...byId.values()];
}
