import { getApiBase, getToken } from '../api';
import { getDeviceId } from './device';

/**
 * 中继的 WebSocket 即时唤醒通道(主通道)。
 *
 * 定位:只负责"有新消息了,快去拉"这一个信号 —— 业务数据仍然走 HTTP 的
 * need / serve / pull(见 packages/shared/src/syncEngine.ts),所以:
 *   · WS 只是**延迟优化**,断掉不影响正确性;
 *   · WS 不可用时由长轮询兜底(syncAuto 里只在 WS 未连通时才跑轮询循环);
 *   · 断线重连成功后立刻做一次完整对账,补齐断线期间可能错过的变化。
 *
 * 鉴权:浏览器/WebView 的 WebSocket API **不能带自定义请求头**,因此先用 Bearer
 * 换一张一次性短时票据(POST /api/relay/ws-ticket),再用 ?ticket= 建连 ——
 * 避免把长期 token 放进 URL(会进 nginx 日志)。
 */

export type RelayStatus = 'idle' | 'connecting' | 'open' | 'closed';

interface RelaySocketOptions {
  /** 收到"有新消息"唤醒。 */
  onWake: () => void;
  /** 连接建立(首次或重连成功)。用于立即对账。 */
  onOpen?: () => void;
  /** 状态变化。 */
  onStatus?: (s: RelayStatus) => void;
}

const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];

function wsBase(): string {
  const base = getApiBase();
  if (base) return base.replace(/^http/i, 'ws');
  const loc = typeof location !== 'undefined' ? location : null;
  if (!loc) return '';
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}`;
}

export class RelaySocket {
  private readonly o: RelaySocketOptions;
  private ws: WebSocket | null = null;
  private stopped = true;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openedAt = 0;

  constructor(o: RelaySocketOptions) {
    this.o = o;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 立即重连(不等退避)。用于"回到前台 / 网络恢复"这类真实事件。 */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.connected) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.retry = 0;
    void this.connect();
  }

  start(): void {
    this.stopped = false;
    this.retry = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    this.ws = null;
    this.o.onStatus?.('idle');
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const wait = BACKOFF_MS[Math.min(this.retry, BACKOFF_MS.length - 1)] ?? 30000;
    this.retry++;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, wait);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const token = getToken();
    if (!token) {
      this.scheduleReconnect();
      return;
    }
    this.o.onStatus?.('connecting');
    let ticket = '';
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/relay/ws-ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deviceId: getDeviceId() }),
      });
      if (!res.ok) throw new Error(`ticket ${res.status}`);
      const j = (await res.json()) as { ticket?: string };
      ticket = String(j.ticket ?? '');
      if (!ticket) throw new Error('ticket 为空');
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const url = `${wsBase()}/api/relay/ws?ticket=${encodeURIComponent(ticket)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.openedAt = Date.now();
      this.retry = 0; // 连上即重置退避
      this.o.onStatus?.('open');
      this.o.onOpen?.(); // 重连成功后立刻对账一次
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string };
        if (msg?.type === 'wake') this.o.onWake();
      } catch {
        /* 非 JSON 忽略 */
      }
    };
    ws.onerror = () => {
      /* onclose 会紧跟其后统一处理 */
    };
    ws.onclose = () => {
      const lived = Date.now() - this.openedAt;
      this.ws = null;
      this.o.onStatus?.('closed');
      // 连接稳定存活过一段时间 → 这次失败不算"连续失败",退避从头开始
      if (lived > 10000) this.retry = 0;
      this.scheduleReconnect();
    };
  }
}
