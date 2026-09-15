import { getSyncEngine, getSyncKey, getSyncPartner, isPhoneMode, syncNow, receiveRelayMail } from '../api';
import type { SyncEnvelope } from '@diary/shared/syncEngine';
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

/**
 * 自动同步(登录 / 打开 App)。
 *
 * 协议(水位线协商 + 区间补传 + 主端选举,实现见 packages/shared/src/syncEngine.ts):
 *   1) /hello 上报本端水位与"按来源设备的水位向量",拿回各端水位 + 主端;
 *   2) 凡是有我没有的数据(或比我新)的**在线**对端 → 定向索取 (我有, 他有] 区间;
 *   3) 对端把该区间加密后经 WebSocket **直投**回来,本端收到即合并。
 *
 * 服务端零存储:离线端不会有任何东西排队,缺口靠下次双方在线时的向量对账补齐。
 */
export async function autoSync(): Promise<{ ok: boolean; pushed?: number; pulled?: number }> {
  if (!isPhoneMode() || !getSyncKey() || syncing) return { ok: false };
  syncing = true;
  try {
    if (getSyncPartner()) {
      try {
        const r = await syncNow(); // 点对点直连(可选,局域网内)
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

/**
 * 本地内容有变化后调用:广播"我更新到 xxxa"给在线端(对端收到会来索取区间)。
 * 数据由对端**直投**回来,所以这里不再需要"顺手拉一遍"。
 */
export function scheduleSync(delay = 800): void {
  if (!isPhoneMode() || !getSyncKey()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      if (!beginSync()) return;
      try {
        await getSyncEngine().onLocalWrite(); // 通知在线端
      } catch {
        /* 静默 */
      } finally {
        endSync();
      }
    })();
  }, delay);
}

/**
 * 在线常驻同步(**纯事件驱动,无轮询**)。
 *
 *   ① WebSocket 常驻 —— 它**既是数据通道,也是在线判据**。服务端把信封
 *      (notify / need / 加密数据)直接推过来,收到就交给引擎处理:
 *      这就是"我这边写完,你那边秒级收到并合并"。
 *   ② 对账(事件触发,不是定时):
 *      - 登录/冷启动(App.tsx 调 autoSync)
 *      - WS 首次连上 / 重连成功(补齐断线期间错过的变化)
 *      - App 从后台回到前台(visibilitychange → visible)
 *      - 网络恢复(online 事件)
 *   ③ 写入时:scheduleSync 去抖后 notify + 广播增量。
 *
 * 服务端对离线端不投递,所以"重连后立刻对账"就是全部的补偿手段 —— 协议自愈,不会漏。
 */
export function startRelayLoop(): void {
  stopRelayLoop();

  socket = new RelaySocket({
    onMail: (envelope) => {
      if (!isPhoneMode() || !getSyncKey()) return;
      // 服务端直投过来的信封 → 直接交给引擎解密合并(不再有"取件"这一步)
      void receiveRelayMail(envelope as SyncEnvelope).catch(() => {});
    },
    onOpen: () => reconcileNow(), // 首次连上 / 重连成功 → 立刻对账一次
    onStatus: (st) => {
      wsStatus = st;
    },
  });
  socket.start();

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
}

/** 当前数据通道是否连通(连上 = 能实时收发;断开 = 离线,不做补偿性拉取)。 */
export function getSyncChannel(): 'ws' | 'offline' {
  return wsStatus === 'open' ? 'ws' : 'offline';
}

/** 事件触发的一次完整对账(握手交换水位 → 按需索取区间 → 广播本端水位)。 */
export function reconcileNow(): void {
  if (!isPhoneMode() || !getSyncKey()) return;
  if (!beginSync()) return;
  void getSyncEngine()
    .runOnce()
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

export function stopRelayLoop(): void {
  socket?.stop();
  socket = null;
  wsStatus = 'idle';
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
}
