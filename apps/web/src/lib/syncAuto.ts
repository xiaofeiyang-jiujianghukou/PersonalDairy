import { getSyncEngine, getSyncKey, getSyncPartner, isPhoneMode, syncNow, relayPullOnly } from '../api';
import { RelaySocket, type RelayStatus } from './relaySocket';

let syncing = false;
let syncingSince = 0;
/** 同步标志最长持有时间:超过就认为上次同步卡死(请求挂住等),强制夺回。 */
const SYNC_STUCK_MS = 90_000;

/** 申请同步权。false = 已有同步在进行(且未卡死)。 */
function beginSync(): boolean {
  if (syncing) {
    if (Date.now() - syncingSince < SYNC_STUCK_MS) return false;
    syncing = false; // 上次明显卡死 → 夺回,否则这台设备永远不会再同步
  }
  syncing = true;
  syncingSince = Date.now();
  return true;
}
function endSync(): void {
  syncing = false;
  syncingSince = 0;
}
let socket: RelaySocket | null = null;
let wsStatus: RelayStatus = 'idle';
let timer: ReturnType<typeof setTimeout> | null = null;
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
      if (!beginSync()) return;
      try {
        const engine = getSyncEngine();
        await engine.onLocalWrite(); // 通知在线端
        await engine.drain(); // 收下对端的 need/数据
      } catch {
        /* 静默 */
      } finally {
        endSync();
      }
    })();
  }, delay);
}

/**
 * 在线常驻同步(**纯事件驱动,无定时轮询**)。
 *
 *   ① 长轮询常驻:POST /api/relay/wait 由服务端挂起,一有新消息(含对端的
 *      notify / need / 数据 / "有端加入"广播)立刻唤醒 → 拉取并处理。这是"事件",
 *      不是轮询:没有新消息时服务端不返回、客户端不发请求。
 *   ② 对账(不是定时,而是事件触发):
 *      - 登录/冷启动(App.tsx 调 autoSync)
 *      - App 从后台回到前台(visibilitychange → visible)
 *      - 网络恢复(online 事件)
 *      - 多端同时上线的竞态:由服务端在 hello 时广播"有端加入"解决(见 index.ts),
 *        老端收到即比对索取 —— 所以不需要周期性 hello。
 *   ③ 写入时:scheduleSync 去抖后 notify + 广播增量 + 拉一次。
 *
 * 为什么②里要有"回前台/网络恢复":长轮询连接在系统休眠、切网时可能被静默掐断,
 * 那台端不会再收到唤醒。用这两个**真实事件**补一次对账,即可回到一致状态。
 */
export function startRelayLoop(): void {
  stopRelayLoop();
  loopAborted = false;

  // 主通道:WebSocket 即时唤醒(连上后长轮询就停,不再产生空闲请求)
  socket = new RelaySocket({
    onWake: () => {
      if (!isPhoneMode() || !getSyncKey()) return;
      if (!beginSync()) return;
      void getSyncEngine()
        .drain()
        .catch(() => {})
        .finally(() => endSync());
    },
    onOpen: () => reconcileNow(), // 首次连上 / 重连成功 → 立刻对账一次,补齐断线期间的变化
    onStatus: (st) => {
      wsStatus = st;
    },
  });
  socket.start();

  // 兜底:长轮询循环常驻,但**只在 WS 未连通时才真正发请求**(见 relayWaitLoop)
  void relayWaitLoop();

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
}

/** 当前唤醒通道:'ws' 为主,'poll' 表示正在用长轮询兜底。 */
export function getSyncChannel(): 'ws' | 'poll' {
  return wsStatus === 'open' ? 'ws' : 'poll';
}

/** 事件触发的一次完整对账(握手交换水位 → 按需补传 → 拉净)。 */
export function reconcileNow(): void {
  if (!isPhoneMode() || !getSyncKey()) return;
  if (!beginSync()) return;
  void doSync()
    .catch(() => {})
    .finally(() => endSync());
}

function onVisibility(): void {
  if (document.visibilityState !== 'visible') return;
  socket?.reconnectNow(); // 被系统冻结过 → 立刻重连,不等退避
  reconcileNow(); // 并做一次完整对账,补齐冻结期间错过的变化
}

function onOnline(): void {
  socket?.reconnectNow(); // 切网后原连接必死 → 立刻重连
  reconcileNow();
}

/** 长轮询主线:等被唤醒 → 拉数并处理控制消息;超时 → 立刻重新挂上;出错 → 退避重连。 */
async function relayWaitLoop(): Promise<void> {
  while (!loopAborted) {
    if (!isPhoneMode() || !getSyncKey() || syncing) {
      await sleep(2000);
      continue;
    }
    // WebSocket 健康 → 唤醒由它承担,这里不发任何请求(避免空闲流量)
    if (socket?.connected) {
      await sleep(1000);
      continue;
    }
    try {
      const handled = await getSyncEngine().waitAndPull();
      if (loopAborted) return;
      if (!handled) continue;
    } catch {
      if (loopAborted) return;
      await sleep(3000); // 出错退避(WS 恢复后会自动接管)
    }
  }
}

export function stopRelayLoop(): void {
  loopAborted = true;
  socket?.stop();
  socket = null;
  wsStatus = 'idle';
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
}
