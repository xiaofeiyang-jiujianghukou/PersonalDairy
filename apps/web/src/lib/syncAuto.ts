import { getSyncEngine, getSyncKey, getSyncPartner, isPhoneMode, syncNow, relayPullOnly } from '../api';

let syncing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let loopTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let loopAborted = false;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 自动同步(登录 / 打开 App)。
 *
 * 新协议(水位线协商 + 区间补传 + 主端选举,实现见 packages/shared/src/syncEngine.ts):
 *   1) /hello 上报本端水位与"按来源设备的水位向量",拿回各端水位 + 主端;
 *   2) 凡是有我没有的数据(或比我新)的对端 → 定向索取 (我有, 他有] 区间;
 *   3) 对端把该区间分小批加密推回云端,本端拉取合并。
 *
 * 不再需要"清空游标/清空水位"这类全量兜底:是否缺数据由**水位向量**判定,
 * 因此"游标跑到前面"导致永远漏收的老问题从设计上消失了。
 */
export async function autoSync(): Promise<{ ok: boolean; pushed?: number; pulled?: number }> {
  if (!isPhoneMode() || !getSyncKey() || syncing) return { ok: false };
  syncing = true;
  try {
    if (getSyncPartner()) {
      try {
        const r = await syncNow(); // 点对点直连(可选)
        return { ok: true, pulled: r.pulled };
      } catch {
        /* 点对点不可达 → 走云端中继 */
      }
    }
    const r = await getSyncEngine().runOnce();
    return { ok: true, pushed: r.pushed, pulled: r.pulled };
  } catch {
    return { ok: false };
  } finally {
    syncing = false;
  }
}

/** 实际同步一次(增量):拉取并对账。 */
async function doSync(): Promise<{ pushed: number; pulled: number }> {
  return getSyncEngine().runOnce();
}

/**
 * 本地内容有变化后调用:广播"我更新到 xxxa"给在线端(对端会来索取区间),
 * 并顺手把云端待处理消息拉一遍(含对端的应答)。
 */
export function scheduleSync(delay = 800): void {
  if (!isPhoneMode() || !getSyncKey()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      if (syncing) return;
      syncing = true;
      try {
        const engine = getSyncEngine();
        await engine.onLocalWrite(); // 通知在线端
        await engine.drain(); // 收下对端的 need/数据
      } catch {
        /* 静默 */
      } finally {
        syncing = false;
      }
    })();
  }, delay);
}

/**
 * 在线常驻同步:
 *   主线 = 长轮询等"有没有新消息"(服务端挂起,毫秒级唤醒)→ 有则拉取并处理;
 *   定时 = 每 reconcileMs 做一次完整对账(hello 交换水位 + 按需补传),兜住
 *          "长轮询丢事件""多端同时上线时的注册竞态"等情况;
 *   兜底 = 每 intervalMs 强拉一次。
 */
export function startRelayLoop(intervalMs = 60000, reconcileMs = 45000): void {
  stopRelayLoop();
  loopAborted = false;
  void relayWaitLoop();
  loopTimer = setInterval(() => {
    if (!isPhoneMode() || !getSyncKey() || syncing) return;
    void relayPullOnly().catch(() => {});
  }, intervalMs);
  reconcileTimer = setInterval(() => {
    if (!isPhoneMode() || !getSyncKey() || syncing) return;
    syncing = true;
    void doSync()
      .catch(() => {})
      .finally(() => {
        syncing = false;
      });
  }, reconcileMs);
}

/** 长轮询主线:等被唤醒 → 拉数并处理控制消息;超时 → 继续等;出错 → 退避重试。 */
async function relayWaitLoop(): Promise<void> {
  while (!loopAborted) {
    if (!isPhoneMode() || !getSyncKey() || syncing) {
      await sleep(2000);
      continue;
    }
    try {
      const handled = await getSyncEngine().waitAndPull();
      if (loopAborted) return;
      if (!handled) continue;
    } catch {
      if (loopAborted) return;
      await sleep(3000); // 出错退避,别空转
    }
  }
}

export function stopRelayLoop(): void {
  loopAborted = true;
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}
