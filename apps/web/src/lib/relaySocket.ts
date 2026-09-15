import { getApiBase, getToken } from '../api';
import { getDeviceId } from './device';

/**
 * 中继的 WebSocket 通道 —— **既是数据通道,也是在线判据**。
 *
 * 定位:服务端把信封(notify / need / 加密数据)**直接推过来**,收到即交给引擎处理
 * (见 packages/shared/src/syncEngine.ts 的 receive())。数据不再走 HTTP 取件,
 * 服务端也不做任何暂存 —— 离线就收不到,靠下次上线时的水位向量对账补齐。
 *
 * 可靠性:手机被系统冻结时服务端会因收不到应用层心跳而断开它;客户端这边也有看门狗
 * 发现"悄悄死掉的连接"。任何一侧重连成功都会立刻做一次完整对账,把缺口补回来。
 *
 * 鉴权:浏览器/WebView 的 WebSocket API **不能带自定义请求头**,因此先用 Bearer
 * 换一张一次性短时票据(POST /api/relay/ws-ticket),再用 ?ticket= 建连 ——
 * 避免把长期 token 放进 URL(会进 nginx 日志)。
 */

export type RelayStatus = 'idle' | 'connecting' | 'open' | 'closed';

interface RelaySocketOptions {
  /** 收到服务端**直投**过来的信封(notify / need / 加密数据)。 */
  onMail: (envelope: unknown) => void;
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
  private keepalive: ReturnType<typeof setInterval> | null = null;
  /** 看门狗:上次收到服务端任何消息的时间(用于发现"连接悄悄死了")。 */
  private lastInbound = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private openedAt = 0;
  /** 大信封的分片重组缓冲:分片 id → { total, parts }。 */
  private readonly chunkBuf = new Map<string, { total: number; parts: string[] }>();

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
    this.stopKeepalive();
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

  /**
   * 应用层心跳(每 15 秒)。
   * 只发一条 ping,不拉数据 —— 目的有两个:
   *   ① 让服务端确认"这个客户端的 JS 真的活着"(网络栈自动回的 pong 不能证明这点);
   *   ② App 被系统冻结时,JS 停摆 → 服务端 40 秒后断开(不再虚报在线) →
   *      恢复后客户端重连并立即对账。
   */
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive();
    this.lastInbound = Date.now();
    /*
     * 半开连接看门狗。
     * 网络路径悄悄失效时(移动网络尤其常见:NAT 超时、切基站、信号瞬断),
     * 客户端收不到任何 close 事件,会一直以为自己连着 —— "断线自动重连"于是永远
     * 不会触发(实测就卡在这里)。服务端每 25 秒发一条 JSON 心跳,这里只要 45 秒
     * 没收到任何东西,就主动断开,交给既有的重连逻辑。
     */
    this.watchdog = setInterval(() => {
      if (this.lastInbound && Date.now() - this.lastInbound > 45000) {
        this.o.onStatus?.(this.connected ? 'open' : 'idle');
        try {
          this.ws?.close();
        } catch {
          /* 忽略 */
        }
      }
    }, 10000);
    this.keepalive = setInterval(() => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* 忽略 */
      }
    }, 15000);
  }

  private stopKeepalive(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.lastInbound = 0;
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
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
      // 同样必须有超时:否则票据请求挂住会让重连逻辑永远卡在 connecting
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
      let res: Response;
      try {
        res = await fetch(`${base}/api/relay/ws-ticket`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ deviceId: getDeviceId() }),
          ...(ctl ? { signal: ctl.signal } : {}),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
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
      this.startKeepalive(ws);
      this.o.onOpen?.(); // 重连成功后立刻对账一次
    };
    ws.onmessage = (ev) => {
      this.lastInbound = Date.now(); // 有消息就说明链路是活的
      let msg: {
        type?: string;
        envelope?: unknown;
        chunk?: { id?: string; seq?: number; total?: number; data?: string };
      };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return; // 非 JSON(或心跳)忽略
      }
      if (msg?.type !== 'mail') return; // ping / ready 等控制帧不在这里处理
      // 小信封:一帧就是一个完整信封
      if (msg.envelope !== undefined) {
        this.o.onMail(msg.envelope);
        return;
      }
      // 大信封:分片 → 重组后再交给引擎
      const ch = msg.chunk;
      if (
        !ch ||
        typeof ch.id !== 'string' ||
        typeof ch.seq !== 'number' ||
        typeof ch.total !== 'number' ||
        typeof ch.data !== 'string'
      ) {
        return;
      }
      const buf = this.chunkBuf.get(ch.id) ?? { total: ch.total, parts: [] };
      buf.total = ch.total;
      buf.parts[ch.seq] = ch.data;
      this.chunkBuf.set(ch.id, buf);
      let got = 0;
      for (const p of buf.parts) if (typeof p === 'string') got++;
      if (got < buf.total) return;
      this.chunkBuf.delete(ch.id);
      try {
        this.o.onMail(JSON.parse(buf.parts.join('')));
      } catch {
        /* 重组后仍解析失败 → 丢弃这一封 */
      }
    };
    ws.onerror = () => {
      /* onclose 会紧跟其后统一处理 */
    };
    ws.onclose = () => {
      const lived = Date.now() - this.openedAt;
      this.stopKeepalive();
      this.ws = null;
      this.o.onStatus?.('closed');
      // 连接稳定存活过一段时间 → 这次失败不算"连续失败",退避从头开始
      if (lived > 10000) this.retry = 0;
      this.scheduleReconnect();
    };
  }
}
