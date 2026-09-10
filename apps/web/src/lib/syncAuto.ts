import {
  getRelayCursor,
  getSyncKey,
  getSyncPartner,
  isPhoneMode,
  relayPullOnly,
  relaySyncNow,
  relayWaitOnce,
  setRelayCursor,
  syncNow,
  setLastSyncAt,
} from '../api';

let syncing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let loopTimer: ReturnType<typeof setInterval> | null = null;
let loopAborted = false;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 自动同步(登录/打开 App 时):**全量**。
 * 先清空本机同步水位 → 把本地全部日记推给中继、并拉取对端全部(增量+消费导致的"数据丢失/换机"因此能自动找回)。
 * 无需手动点"同步":打开即同步。优先点对点直连,不可达自动降级为经中继(P2)。
 */
/**
 * 自动同步(登录/打开 App 时):**全量对账**。
 * 把本机同步游标归零 → 从中继**全量拉取**(分页,能补回之前错过的消息,如换密钥/换机后漏掉的对端更新),
 * 并**只推本机新增增量**(不再清空水位,避免每次登录全量重推导致中继膨胀)。
 * 无需手动点"同步":打开即同步。优先点对点直连,不可达自动降级为经中继。
 */
export async function autoSync(): Promise<{ ok: boolean; pushed?: number; pulled?: number }> {
  if (!isPhoneMode() || !getSyncKey() || syncing) return { ok: false };
  syncing = true;
  try {
    setLastSyncAt(''); // 登录/打开=全量:清水位→推全部
    setRelayCursor(0); // 归零游标 → 全量拉取(分页),补回之前错过的对端更新(换密钥/换机漏掉的)
    const r = await doSync();
    return { ok: true, pushed: r.pushed, pulled: r.pulled };
  } catch {
    return { ok: false };
  } finally {
    syncing = false;
  }
}

/** 实际同步:有配对地址走点对点,否则走云端密文中继。返回 推送/拉取 条数。 */
async function doSync(): Promise<{ pushed: number; pulled: number }> {
  if (getSyncPartner()) {
    try {
      const r = await syncNow(); // 点对点直连
      return { pushed: 0, pulled: r.pulled };
    } catch {
      /* 点对点不可达 → 走中继 */
    }
  }
  return relaySyncNow();
}

/** 内容有变化后,延迟触发一次自动同步(去抖,增量)。 */
export function scheduleSync(delay = 1200): void {
  if (!isPhoneMode() || !getSyncKey()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      if (syncing) return;
      syncing = true;
      try {
        await doSync();
      } catch {
        /* 静默 */
      } finally {
        syncing = false;
      }
    })();
  }, delay);
}

/**
 * 启动"在线常驻"同步(即时 + 克制):
 * 主线 = 长轮询等待"有没有新消息"(服务端挂起,毫秒级唤醒),有→按游标拉取;
 * 兜底 = 每 intervalMs 秒强制拉一次,防长轮询事件丢失 / 断线重连遗漏。
 * 只读不写;写入只在保存时通过 scheduleSync 触发一次,避免每次轮询空推中继膨胀。
 */
export function startRelayLoop(intervalMs = 60000): void {
  stopRelayLoop();
  loopAborted = false;
  void relayWaitLoop();
  loopTimer = setInterval(() => {
    if (!isPhoneMode() || !getSyncKey() || syncing) return;
    void relayPullOnly().catch(() => {});
  }, intervalMs);
}

/** 长轮询主线:等被唤醒 → 拉数;超时 → 继续等;出错 → 退避重试。 */
async function relayWaitLoop(): Promise<void> {
  while (!loopAborted) {
    if (!isPhoneMode() || !getSyncKey() || syncing) {
      await sleep(2000);
      continue;
    }
    try {
      const cursor = getRelayCursor();
      const r = await relayWaitOnce(cursor);
      if (loopAborted) return;
      if (!r.hasNew || syncing) continue;
      syncing = true;
      try {
        await relayPullOnly();
      } finally {
        syncing = false;
      }
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
}
