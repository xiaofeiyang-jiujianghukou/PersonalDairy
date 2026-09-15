/**
 * 多端同步协议引擎(与宿主解耦:浏览器 / Node / 测试都能用)。
 *
 * 核心原则:**在线即同步,离线不同步**。
 *   服务端不存任何东西 —— 信封只在两台**同时在线**的设备之间由服务端 WebSocket 直投。
 *   离线端错过的东西,靠它下次上线时的「水位向量对账」补齐(协议本身自愈)。
 *
 * 协议(按需求方的方案):
 *   水位线 watermark = 本端已知的"最新更新时间点"(本地全部条目 updatedAt 的最大值,ISO 字符串可比大小)。
 *   水位向量 vector  = { 来源 deviceId: 我拥有的该来源最新 updatedAt } —— 只有向量才能发现
 *                      "我缺了别人更早写的那批数据"(单标量水位会把旧数据当成对方已有)。
 *
 *   场景 1 —— 任一端写入(对端在线):
 *     写入端 notify(xxxa) 直投 → 各在线端比较自身 xxxb:
 *       若 xxxb < xxxa → 定向 need(from=xxxb, to=xxxa) 给写入端;
 *       写入端收到 need → 取本地 (xxxb, xxxa] 区间条目,分小批加密**直投**回去;
 *       请求端收到即解密、LWW 合并(见 receive())。
 *     对端不在线 → 直投送达 0,不做任何暂存;等下次双方在线时对账补齐。
 *
 *   场景 2 —— 新端登录(已有端在线):
 *     /hello 上报本端水位 → 服务端返回各端水位 + 主端;
 *     新端若落后 → 向水位更高的**在线**端(优先主端)发 need 请求区间补传。
 *
 *   场景 3 —— 新端上线时:
 *     服务端向其它在线端广播一条「有端加入」(带上新端的水位/向量) →
 *     它们反向比对,发现自己缺什么就主动来索取。
 *
 * 引擎只处理"协议";加解密、存储、HTTP/WS 都由宿主注入(见 SyncTransport / SyncStore / SyncCipher)。
 */

export interface DiaryEntry {
  id: string;
  date: string;
  content: string;
  deviceId?: string;
  createdAt?: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/**
 * AI 对话消息(陪伴 / 心理导师)。与日记一样**只存在终端**,经由同一套加密信箱链路同步。
 * 消息一旦生成就不再修改 → 合并时按 id 去重即可,不存在冲突。
 */
export interface ChatMessage {
  id: string;
  /** 对话所属线程:'companion' | 'mentor' | … */
  thread: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface PeerDevice {
  deviceId: string;
  /** 全局最新时间点(用于展示与主端选举)。 */
  watermark: string;
  /**
   * 按"来源设备"的水位向量:{ 来源deviceId: 我拥有的该来源最新 updatedAt }。
   * 只有向量才能发现"我缺了别人更早写的那批数据"(单标量水位会把旧数据当成对方已有)。
   */
  vector?: Record<string, string>;
  /** 对方本地条目数(含墓碑)。用于"数量对不上就必须补全"的兜底判断。 */
  count?: number;
  loginAt: number;
  lastSeen: number;
  online?: boolean;
}

export type SyncKind = 'data' | 'notify' | 'need';

/** 结构化日志类别(宿主据此在「日志管理」里过滤展示)。 */
export type SyncLogCategory =
  | 'write' // 写日记(本机新建/修改/删除)
  | 'notify' // 发通知:告诉在线端「我更新了」
  | 'recvNotify' // 收通知:收到对端「我更新了」
  | 'watermark' // 获取水位:握手交换各端水位/向量
  | 'range' // 水位区间:发起索取 / 补传 / 收到区间数据
  | 'sync' // 通用同步(广播增量、合并、会话状态)
  | 'error'; // 错误

/** 水位向量:来源设备 → 我拥有的该来源最新更新时间点。 */
export type WatermarkVector = Record<string, string>;

/**
 * 服务端通过 WebSocket 直投过来的一个信封。
 * 结构就是过去信箱里取出来的那一条 —— 只是现在不再经过任何存储。
 */
export interface SyncEnvelope {
  kind: SyncKind;
  from: string;
  to: string;
  payload: string;
}

export interface SyncTransport {
  hello(p: {
    deviceId: string;
    watermark: string;
    vector: WatermarkVector;
    count: number;
  }): Promise<{ leader: string | null; devices: PeerDevice[] }>;
  heartbeat(p: {
    deviceId: string;
    watermark: string;
    vector: WatermarkVector;
    count: number;
  }): Promise<{ leader: string | null; devices: PeerDevice[] }>;
  notify(p: { deviceId: string; watermark: string; vector: WatermarkVector; count: number }): Promise<void>;
  /** 请求 origin 这台来源设备在 (fromWatermark, toWatermark] 区间内的数据。 */
  need(p: {
    deviceId: string;
    to: string;
    origin: string;
    fromWatermark: string;
    toWatermark: string;
  }): Promise<void>;
  /** 定向推送一批加密数据给 to。 */
  push(p: { deviceId: string; to: string; payload: string }): Promise<void>;
}

export interface SyncStore {
  all(): Promise<DiaryEntry[]>;
  put(entries: DiaryEntry[]): Promise<void>;
  exportMedia(ids: string[]): Promise<Array<{ id: string; dataUrl: string }>>;
  importMedia(items: Array<{ id: string; dataUrl: string }>): Promise<void>;
  localMediaIds(): Promise<string[]>;
  /** 本机全部 AI 对话消息(可选:宿主不实现则不同步对话)。 */
  chatAll?(): Promise<ChatMessage[]>;
  /** 写入对端带来的对话消息(按 id 去重)。 */
  chatPut?(messages: ChatMessage[]): Promise<void>;
}

export interface SyncCipher {
  encrypt(obj: unknown): Promise<unknown>;
  decrypt(obj: unknown): Promise<unknown>;
}

export interface SyncEngineOptions {
  deviceId: string;
  transport: SyncTransport;
  store: SyncStore;
  cipher: SyncCipher;
  state: {
    /**
     * 广播水位(上次"兼容广播"推到哪里),用于只推增量。
     * 注意:这里**没有游标** —— 新协议按时间区间协商,收件靠**服务端 WebSocket 直投**。
     */
    getPushedAt?(): string;
    setPushedAt?(v: string): void;
  };
  /** 合并了对端条目后回调(用于刷新界面)。 */
  onChange?: () => void;
  /** 诊断日志(带类别,供结构化存储与界面过滤)。 */
  log?: (msg: string, cat?: SyncLogCategory) => void;
  /** 单条推送的目标字节上限(超过则分批)。 */
  chunkBytes?: number;
  /** 每次推送附带多少条最近的 AI 对话(靠 id 去重,自带自愈能力)。 */
  chatCarry?: number;
  /**
   * 同步状态回调(供界面提示):
   *   'start' —— 发现自己的水位低于最高水位,开始向对端索取数据;
   *   'done'  —— 这一轮同步结束,merged 是本轮合并进来的条数。
   */
  onSyncEvent?: (e: { phase: 'start' | 'done'; merged?: number }) => void;
  /**
   * 同一个区间请求的去重窗口(毫秒,默认 60 秒)。
   * 超出窗口后,下一个事件(登录/收到通知/有端加入)会**重新索取** —— 因为
   * need 可能因为"对端当时不在线/请求丢失"而始终没被满足,不能只发一次就永远放弃。
   */
  requestRetryMs?: number;
}

/**
 * 时间戳是否"合理"(用于水位/向量计算)。
 *
 * 背景:库里可能存在**异常未来时间**的条目 —— 例如早期同步测试中为了让"删除"在 LWW 里
 * 必胜,把墓碑的 updatedAt 设成了 2099-01-01。这类值一旦参与水位计算,会把水位顶到 2099,
 * 之后任何新条目("现在"的时间)都小于它,按来源比对时向量看似没变 → 精确区间协商失效,
 * 退化成每次全量补传。
 *
 * 处理:水位/向量只统计"不超过当前时间 + 1 天"的时间戳;异常条目本身仍会正常同步
 * (会被"条目数兜底"或首次全量带过去)。
 */
const FUTURE_SKEW_MS = 24 * 3600 * 1000;
function plausibleTime(iso: string, now = Date.now()): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now + FUTURE_SKEW_MS;
}

/**
 * 把条目的 updatedAt 规范化为"合理时间"(幂等)。
 *
 * 历史包袱:早期 LWW 测试为了让"删除"必胜,把墓碑 updatedAt 写成了 2099-01-01。
 * 这类值不但会顶高水位,还会在合并时"永远更新"从而压住真实修改。
 * 规范化规则:updatedAt 合理 → 原样返回;不合理 → 退回 deletedAt(删除时刻,语义最贴近)
 * → 再退 createdAt → 再退"现在"。
 *
 * 在"写入本地前"调用(本地修复 + 合并对端数据),因此无论数据从哪来都会被修正,
 * 各端独立自愈后自然收敛到同一时间,不需要手工改数据库。
 */
export function normalizeEntryTimestamps<
  T extends { updatedAt?: string; createdAt?: string; deletedAt?: string | null },
>(e: T, now = Date.now()): T {
  if (plausibleTime(String(e.updatedAt ?? ''), now)) return e;
  const candidates = [e.deletedAt ?? '', e.createdAt ?? ''];
  const fallback = candidates.find((c) => plausibleTime(c, now)) || new Date(now).toISOString();
  return { ...e, updatedAt: fallback };
}

/** 从 markdown 里抽出媒体引用 id(与 apps/web 的 extractMediaIds 行为一致的最小实现)。 */
function mediaIdsOf(content: string): string[] {
  const out: string[] = [];
  const re = /diary-(?:img|video):([0-9a-fA-F]{8,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content ?? ''))) out.push(m[1]!);
  return out;
}

export class SyncEngine {
  private readonly o: Required<Pick<SyncEngineOptions, 'deviceId' | 'transport' | 'store' | 'cipher' | 'state'>> &
    SyncEngineOptions;
  /** 已广播过的水位(避免重复 notify 刷屏)。 */
  private lastNotified = '';
  /** 已请求过的区间 → 上次请求时间(超过窗口允许重试,见 requestRetryMs)。 */
  private readonly requested = new Map<string, number>();
  private leader: string | null = null;
  private busy = false;
  /** 诊断:最近一次同步/错误情况(界面上可直接显示,便于实机排查)。 */
  /** 最近一次随行带出去的对话 id —— 对话变化时即使没有日记增量也要推送。 */
  private lastChatPushed = '';
  /** 同步会话:发现落后 → 提示"同步中";数据到齐 → 提示"同步成功 N 条"。 */
  private syncSession: { open: boolean; merged: number; since: number } | null = null;
  private diag = {
    lastSyncAt: '',
    lastError: '',
    lastErrorAt: '',
    lastMerged: 0,
    lastHandled: 0,
    lastRequested: 0,
    leader: '',
  };

  constructor(opts: SyncEngineOptions) {
    this.o = opts as never;
  }

  /** 随每次推送携带的最近对话(固定条数,靠 id 去重)。 */
  private async carryChat(): Promise<ChatMessage[]> {
    if (!this.o.store.chatAll) return [];
    try {
      const all = await this.o.store.chatAll();
      const n = this.o.chatCarry ?? 60;
      return all
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .slice(-n);
    } catch {
      return [];
    }
  }

  /** 合并对端带来的对话(按 id 去重,幂等)。返回新写入条数。 */
  async mergeChat(remote: ChatMessage[] | undefined): Promise<number> {
    if (!remote?.length || !this.o.store.chatAll || !this.o.store.chatPut) return 0;
    const local = await this.o.store.chatAll();
    const seen = new Set(local.map((m) => m.id));
    const fresh = remote.filter(
      (m) => m && m.id && (m.role === 'user' || m.role === 'assistant') && m.content && !seen.has(m.id),
    );
    if (!fresh.length) return 0;
    await this.o.store.chatPut(fresh);
    return fresh.length;
  }

  private log(msg: string, cat: SyncLogCategory = 'sync'): void {
    this.o.log?.(`[sync:${this.o.deviceId.slice(0, 8)}] ${msg}`, cat);
  }

  /** 本端水位线 = 本地全部条目 updatedAt 的最大值(删除也是更新,故含墓碑)。 */
  async watermark(): Promise<string> {
    const all = await this.o.store.all();
    const now = Date.now();
    let wm = '';
    for (const e of all) {
      const u = String(e.updatedAt ?? '');
      if (u && u > wm && plausibleTime(u, now)) wm = u;
    }
    return wm;
  }

  /**
   * 本地自愈:把库里 updatedAt 异常的条目规范化后写回。
   * 例:早期测试留下的 2099 墓碑 → 改成其 deletedAt(删除时刻)。
   * 幂等、可反复调用;每次登录跑一次,代价是一次全表扫描。
   */
  async repairLocalTimestamps(): Promise<number> {
    const all = await this.o.store.all();
    const now = Date.now();
    const fixed: DiaryEntry[] = [];
    for (const e of all) {
      const n = normalizeEntryTimestamps(e, now);
      if (n.updatedAt !== e.updatedAt) fixed.push(n);
    }
    if (fixed.length) {
      await this.o.store.put(fixed);
      this.log(`本地时间自愈 ${fixed.length} 条(异常未来时间 → 真实时间)`);
    }
    return fixed.length;
  }

  /** 本地条目数(含墓碑;同步收敛后各端应一致,不一致说明有缺口)。 */
  async count(): Promise<number> {
    return (await this.o.store.all()).length;
  }

  /** 水位向量:按来源设备分别记录"我有的最新时间点"。(条目自带 origin deviceId) */
  async watermarkVector(): Promise<WatermarkVector> {
    const all = await this.o.store.all();
    const now = Date.now();
    const v: WatermarkVector = {};
    for (const e of all) {
      const origin = e.deviceId || 'unknown';
      const u = String(e.updatedAt ?? '');
      if (!u || !plausibleTime(u, now)) continue;
      if (!v[origin] || u > v[origin]) v[origin] = u;
    }
    return v;
  }

  getLeader(): string | null {
    return this.leader;
  }

  /** 同步诊断快照(全本地状态,供界面展示)。 */
  diagnostics(): {
    lastSyncAt: string;
    lastError: string;
    lastErrorAt: string;
    lastMerged: number;
    lastHandled: number;
    lastRequested: number;
    leader: string;
  } {
    return { ...this.diag, leader: this.leader ?? '' };
  }

  /** 发现水位落后(要向对端索取)时开启一次"同步中"。 */
  private openSyncSession(): void {
    if (this.syncSession?.open) return;
    this.syncSession = { open: true, merged: 0, since: Date.now() };
    this.o.onSyncEvent?.({ phase: 'start' });
    this.log('同步中…(发现缺口,开始向对端索取)');
    /*
     * 直投模式下没有"取件收尾"这个时机(数据是被推过来的),所以自带一个兜底:
     * 45 秒还没补齐就收起提示 —— 对端可能已经离线/被冻结,别让界面永远挂着"同步中"。
     */
    if (typeof setTimeout === 'function') {
      const openedAt = this.syncSession.since;
      setTimeout(() => {
        if (this.syncSession?.open && this.syncSession.since === openedAt) this.closeSyncSession();
      }, 45_000);
    }
  }

  /** 结束一次同步,并把"本轮合并了多少条"报给界面。 */
  private closeSyncSession(): void {
    const s = this.syncSession;
    if (!s?.open) return;
    this.syncSession = null;
    this.o.onSyncEvent?.({ phase: 'done', merged: s.merged });
    this.log(`同步结束:合并 ${s.merged} 条`);
  }

  /** 合并计数(条目 + 对话)累加到当前同步会话。 */
  private addMerged(n: number): void {
    if (n > 0 && this.syncSession?.open) this.syncSession.merged += n;
  }

  private fail(stage: string, e: unknown): void {
    // 记下堆栈的第一段(含文件/行号),否则只能看到报错文字、定位不到出处
    const where = String((e as Error)?.stack ?? '')
      .split('\n')
      .slice(1, 3)
      .map((l) => l.trim().replace(/^at\s+/, ''))
      .join(' ← ');
    this.diag.lastError = `${stage}: ${(e as Error)?.message ?? String(e)}`;
    this.diag.lastErrorAt = new Date().toISOString();
    this.log(`✖ ${this.diag.lastError}${where ? `  【${where}】` : ''}`, 'error');
  }

  /**
   * 只改了对话(没写日记)时,也要把对话推给在线端。
   * 否则"聊完一句就关掉"的内容永远出不去 —— 实测 bug。
   */
  private async carryChatIfNeeded(): Promise<number> {
    if (!this.o.store.chatAll) return 0;
    const chat = await this.carryChat();
    const newest = chat[chat.length - 1]?.id ?? '';
    if (!newest || newest === this.lastChatPushed) return 0;
    try {
      const enc = await this.o.cipher.encrypt({
        entries: [],
        images: [],
        localImageIds: await this.o.store.localMediaIds(),
        chat,
      });
      await this.o.transport.push({ deviceId: this.o.deviceId, to: '', payload: JSON.stringify(enc) });
      this.lastChatPushed = newest;
      this.log(`随行带出对话 ${chat.length} 条`);
      return chat.length;
    } catch (e) {
      this.fail('推送对话', e);
      return 0;
    }
  }

  // ---------------- 写入端:广播"我更新了" ----------------
  async onLocalWrite(): Promise<void> {
    // (a) 兼容广播:把"上次广播之后的新数据"推到中继。
    //     新协议靠对端来索取区间,但旧版本客户端只会拉广播数据,不广播它们就收不到更新;
    //     顺带也让中继自己保留一份近期增量,新设备即使没有在线对端也能恢复。
    await this.broadcastDelta();
    await this.carryChatIfNeeded(); // 只改了对话(没写日记)时也要带出去
    // (b) 通知在线端(新协议:对端按需索取区间)
    const wm = await this.watermark();
    if (!wm || wm === this.lastNotified) return;
    this.lastNotified = wm;
    try {
      await this.o.transport.notify({
        deviceId: this.o.deviceId,
        watermark: wm,
        vector: await this.watermarkVector(),
        count: await this.count(),
      });
      this.log(`notify 水位=${wm}`, 'notify');
    } catch (e) {
      this.lastNotified = ''; // 失败允许重试
      this.log(`notify 失败:${(e as Error).message}`, 'error');
    }
  }

  /**
   * 读取"广播水位"。
   * 异常值(如被污染的 2099)一律当作"没有水位" —— 否则 `updatedAt > 2099` 永远不成立,
   * 这台设备就**再也推不出任何数据**(实测事故:电脑端 lastSyncAt=2099 → 永不广播)。
   */
  private pushedAt(): string {
    const v = this.o.state.getPushedAt?.() ?? '';
    return plausibleTime(v) ? v : '';
  }

  /** 把 pushedAt 之后的新条目分小批广播到中继(不带 to = 同账号所有端可见)。 */
  async broadcastDelta(): Promise<number> {
    const since = this.pushedAt();
    const all = await this.o.store.all();
    const now = Date.now();
    const delta = all
      .map((e) => normalizeEntryTimestamps(e, now))
      .filter((e) => e.updatedAt && (!since || e.updatedAt > since))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
    if (!delta.length) return 0;
    const localImageIds = await this.o.store.localMediaIds();
    const max = this.o.chunkBytes ?? 192 * 1024;
    let batch: DiaryEntry[] = [];
    let size = 0;
    let sent = 0;
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const ids = new Set<string>();
      for (const e of batch) for (const id of mediaIdsOf(e.content)) ids.add(id);
      const images = ids.size ? await this.o.store.exportMedia([...ids]) : [];
      const chat = await this.carryChat();
      const enc = await this.o.cipher.encrypt({ entries: batch, images, localImageIds, chat });
      await this.o.transport.push({ deviceId: this.o.deviceId, to: '', payload: JSON.stringify(enc) });
      this.lastChatPushed = chat[chat.length - 1]?.id ?? this.lastChatPushed;
      sent += batch.length;
      batch = [];
      size = 0;
    };
    for (const e of delta) {
      const ids = mediaIdsOf(e.content);
      const imgs = ids.length ? await this.o.store.exportMedia(ids) : [];
      const esize = JSON.stringify(e).length + imgs.reduce((s2, x) => s2 + x.dataUrl.length, 0);
      if (batch.length && size + esize > max) await flush();
      batch.push(e);
      size += esize;
    }
    await flush();
    const last = delta[delta.length - 1]?.updatedAt ?? since;
    this.o.state.setPushedAt?.(last);
    this.log(`广播增量 ${sent} 条(截至 ${last})`);
    return sent;
  }

  // ---------------- 登录/上线:握手 + 按需补齐 ----------------
  async onLogin(): Promise<{ requested: number; leader: string | null }> {
    await this.repairLocalTimestamps(); // 先自愈历史异常时间,再谈水位
    const wm = await this.watermark();
    const vector = await this.watermarkVector();
    const count = await this.count();
    let devices: PeerDevice[] = [];
    try {
      const r = await this.o.transport.hello({ deviceId: this.o.deviceId, watermark: wm, vector, count });
      this.leader = r.leader;
      devices = r.devices ?? [];
    } catch (e) {
      this.fail('握手 hello', e);
      return { requested: 0, leader: null };
    }
    this.log(
      `hello 水位=${wm || '(空)'} 向量=${JSON.stringify(vector)} 主端=${this.leader?.slice(0, 8) ?? '无'}`,
      'watermark',
    );
    const requested = await this.reconcileWith(devices, vector);
    return { requested, leader: this.leader };
  }

  /**
   * 与各端的水位向量比对:对每一个"来源设备",只要对方有而我没有(或对方更新),
   * 就向该端请求 (我有, 他有] 区间。主端优先处理。
   */
  private async reconcileWith(devices: PeerDevice[], mine: WatermarkVector): Promise<number> {
    /*
     * 只向**在线**对端索取。
     *
     * 旧版(信箱)会把请求排进离线端的信箱,等它醒来再处理,所以要"问所有端(含离线)"。
     * 现在数据走 WS 直投:离线端根本收不到请求,发给它只会 delivered=0,白发。
     *
     * 缺口不会因此漏掉 —— 它上线时会 hello,服务端随即向其它在线端广播「有端加入」,
     * 那些端收到就反向比对自己的向量、主动来索取。也就是"谁在线谁先补,最终仍收敛"。
     */
    const peers = devices
      .filter((d) => d.deviceId !== this.o.deviceId && d.online)
      .sort((a, b) => {
        const al = a.deviceId === this.leader ? 1 : 0;
        const bl = b.deviceId === this.leader ? 1 : 0;
        if (al !== bl) return bl - al;
        return a.deviceId < b.deviceId ? -1 : 1;
      });
    let n = 0;
    // 兜底:条目数对不上 → 说明光靠水位向量仍有缺口(例如历史数据来源标记不准),
    // 向"条目数更多的端"(优先主端)要一次全量(origin='' = 不限来源,from='' = 从头)。
    const myCount = await this.count();
    const fuller = peers.find((d) => (d.count ?? 0) > myCount);
    if (fuller) {
      await this.requestRange(fuller.deviceId, '', '', '');
      n++;
    }
    for (const d of peers) {
      const v = d.vector ?? {};
      for (const [origin, their] of Object.entries(v)) {
        const my = mine[origin] ?? '';
        if (!their || their <= my) continue;
        await this.requestRange(d.deviceId, origin, my, their);
        n++;
      }
      // 对方没有向量(旧版本)时退化:按全局水位比较
      if (!d.vector && d.watermark) {
        let myMax = '';
        for (const x of Object.values(mine)) if (x > myMax) myMax = x;
        if (d.watermark > myMax) {
          await this.requestRange(d.deviceId, '', myMax, d.watermark);
          n++;
        }
      }
    }
    return n;
  }

  private async requestRange(to: string, origin: string, fromWm: string, toWm: string): Promise<void> {
    const key = `${to}|${origin}|${toWm}`;
    const window = this.o.requestRetryMs ?? 60_000;
    const last = this.requested.get(key);
    if (last !== undefined && Date.now() - last < window) return; // 窗口内不重复
    this.requested.set(key, Date.now());
    this.openSyncSession(); // 发现水位落后 → 界面上提示"同步中"
    try {
      await this.o.transport.need({
        deviceId: this.o.deviceId,
        to,
        origin,
        fromWatermark: fromWm,
        toWatermark: toWm,
      });
      this.log(`need ${to.slice(0, 8)} origin=${(origin || '(全部)').slice(0, 8)} 区间(${fromWm || '空'}, ${toWm}]`, 'range');
    } catch (e) {
      this.requested.delete(key);
      this.fail('发起索取 need', e);
    }
  }

  // ---------------- 心跳(维持在线 + 刷新水位) ----------------
  async heartbeat(): Promise<void> {
    const wm = await this.watermark();
    try {
      const r = await this.o.transport.heartbeat({
        deviceId: this.o.deviceId,
        watermark: wm,
        vector: await this.watermarkVector(),
        count: await this.count(),
      });
      this.leader = r.leader;
    } catch {
      /* 静默 */
    }
  }

  // ---------------- 拉取并处理控制/数据消息 ----------------
  /**
   * 收到服务端**直投**过来的一个信封(WebSocket 的 mail 帧)并处理它。
   *
   * 这就是过去 drain 时从信箱里取出来处理的那一条 —— 但现在没有信箱、
   * 没有分页、没有取件轮询:数据只在**两台同时在线**的设备之间直投。
   * 离线端收不到任何东西,靠它下次上线时的「水位向量对账」补齐缺口。
   */
  async receive(env: SyncEnvelope): Promise<number> {
    let merged = 0;
    try {
      merged = await this.handle(env);
    } catch (e) {
      this.fail(`处理直投消息(${env.kind})`, e);
      return 0;
    }
    this.diag.lastMerged = merged;
    this.diag.lastHandled += 1;
    this.diag.lastSyncAt = new Date().toISOString();
    if (merged > 0) {
      this.addMerged(merged);
      /*
       * 合并进了数据 → 报给界面。注意也包括"对端主动推给我"的情况:
       * 那种情况不会开启同步会话,所以这里单独发一次 done 事件。
       */
      if (this.syncSession?.open) this.closeSyncSession();
      else this.o.onSyncEvent?.({ phase: 'done', merged });
      this.o.onChange?.();
      // 合并后立刻上报新水位/向量/条目数,避免服务端设备表里是合并前的过期快照
      void this.heartbeat();
    }
    return merged;
  }

  private async handle(m: SyncEnvelope): Promise<number> {
    if (m.kind === 'notify') {
      // 对端说"我更新到 xxxa"(或"我上线了"):按**来源**逐条比对我的水位向量,
      // 只要它有的我没有(或比我新)就定向索取该来源的区间;条目数更多则额外要一次全量。
      const info = await this.safeDecrypt<{
        watermark?: string;
        vector?: WatermarkVector;
        count?: number;
      }>(m.payload);
      const mine = await this.watermarkVector();
      const theirVector = info?.vector ?? {};
      this.log(
        `收到通知 from=${m.from.slice(0, 8)} 水位=${info?.watermark ?? '(空)'} 向量来源=${Object.keys(theirVector).length} 个 条目数=${info?.count ?? '?'}`,
        'recvNotify',
      );
      let asked = 0;
      for (const [origin, their] of Object.entries(theirVector)) {
        if (!their) continue;
        const my = mine[origin] ?? '';
        if (their > my) {
          await this.requestRange(m.from, origin, my, their);
          asked++;
        }
      }
      // 旧对端不带向量(老版本):退化为按自身水位比较
      if (!asked && !Object.keys(theirVector).length && info?.watermark) {
        const their = String(info.watermark);
        const my = mine[m.from] ?? '';
        if (their > my) await this.requestRange(m.from, m.from, my, their);
      }
      // 数量兜底:对方条目更多 → 说明水位向量看不见缺口,直接要一次全量
      if ((info?.count ?? 0) > (await this.count())) {
        await this.requestRange(m.from, '', '', '');
      }
      return 0;
    }
    if (m.kind === 'need') {
      // 对端要我补 origin 这台设备在 (fromWatermark, toWatermark] 的数据
      const req =
        (await this.safeDecrypt<{ origin?: string; fromWatermark?: string; toWatermark?: string }>(m.payload)) ?? {};
      await this.serveRange(
        m.from,
        String(req.origin ?? ''),
        String(req.fromWatermark ?? ''),
        String(req.toWatermark ?? ''),
      );
      return 0;
    }
    // data
    const peer = await this.decryptData<{
      entries?: DiaryEntry[];
      images?: Array<{ id: string; dataUrl: string }>;
      chat?: ChatMessage[];
    }>(m.payload);
    if (!peer) return 0; // 解不开(旧密钥/别人的)→ 跳过,不阻塞
    const chatMerged = await this.mergeChat(peer.chat);
    this.addMerged(chatMerged);
    if (chatMerged > 0) this.o.onChange?.(); // 对话有新内容 → 通知界面刷新
    for (const img of peer.images ?? []) {
      if (img?.dataUrl) await this.o.store.importMedia([img]);
    }
    const merged = await this.mergeEntries(peer.entries ?? []);
    this.addMerged(merged);
    if (merged) this.log(`收到区间数据 ${merged} 条(来自 ${m.from.slice(0, 8)})`, 'range');
    if (merged && this.lastNotified) {
      const wm = await this.watermark();
      if (wm > this.lastNotified) this.lastNotified = wm; // 合并后水位前进,避免再广播一次
    }
    return merged;
  }

  /** LWW 合并:本地缺失,或对端 updatedAt 更新 → 写入。 */
  async mergeEntries(remote: DiaryEntry[]): Promise<number> {
    if (!remote.length) return 0;
    const local = await this.o.store.all();
    const now = Date.now();
    const map = new Map(local.map((e) => [e.id, e]));
    const toWrite: DiaryEntry[] = [];
    for (const raw of remote) {
      if (!raw?.id || !raw.date) continue;
      const e = normalizeEntryTimestamps(raw, now); // 对端带来的异常时间也要修正
      const cur = map.get(e.id);
      if (!cur || String(e.updatedAt ?? '') > String(cur.updatedAt ?? '')) toWrite.push(e);
    }
    if (toWrite.length) await this.o.store.put(toWrite);
    return toWrite.length;
  }

  // ---------------- 被请求端:补传区间数据 ----------------
  /** 把本地 origin 来源、时间落在 (fromWm, toWm] 的条目分小批加密定向推给 requester。 */
  async serveRange(requester: string, origin: string, fromWm: string, toWm: string): Promise<number> {
    const all = await this.o.store.all();
    const now = Date.now();
    const picked = all
      .map((e) => normalizeEntryTimestamps(e, now))
      .filter((e) => {
        if (origin && (e.deviceId || 'unknown') !== origin) return false;
        const u = String(e.updatedAt ?? '');
        if (!u) return false;
        // 异常未来时间的条目(如 2099 墓碑)不在任何正常区间内 → 只在"全量补传"(无上界)时带出
        if (!plausibleTime(u, now) && toWm) return false;
        if (fromWm && u <= fromWm) return false;
        if (toWm && u > toWm) return false;
        return true;
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
    if (!picked.length) {
      this.log(`serve ${requester.slice(0, 8)} 区间无数据`, 'range');
      return 0;
    }
    const localImageIds = await this.o.store.localMediaIds();
    const max = this.o.chunkBytes ?? 192 * 1024;
    let batch: DiaryEntry[] = [];
    let size = 0;
    let sent = 0;
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const ids = new Set<string>();
      for (const e of batch) for (const id of mediaIdsOf(e.content)) ids.add(id);
      const images = ids.size ? await this.o.store.exportMedia([...ids]) : [];
      const chat = await this.carryChat();
      const enc = await this.o.cipher.encrypt({ entries: batch, images, localImageIds, chat });
      await this.o.transport.push({ deviceId: this.o.deviceId, to: requester, payload: JSON.stringify(enc) });
      sent += batch.length;
      batch = [];
      size = 0;
    };
    for (const e of picked) {
      const ids = mediaIdsOf(e.content);
      const imgs = ids.length ? await this.o.store.exportMedia(ids) : [];
      const esize = JSON.stringify(e).length + imgs.reduce((s, x) => s + x.dataUrl.length, 0);
      if (batch.length && size + esize > max) await flush();
      batch.push(e);
      size += esize;
    }
    await flush();
    this.log(
      `serve ${requester.slice(0, 8)} origin=${(origin || '(全部)').slice(0, 8)} 区间(${fromWm || '空'}, ${toWm}] 推送 ${sent} 条`,
      'range',
    );
    return sent;
  }

  /**
   * 控制消息载荷解析:优先按加密解;解不开再当作明文 JSON(服务端兜底生成的元数据)。
   * 数据消息必须能解密,控制消息两者皆可。
   */
  private async safeDecrypt<T>(payload: string): Promise<T | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    try {
      return (await this.o.cipher.decrypt(parsed)) as T;
    } catch {
      /* 不是密文 → 尝试明文 */
    }
    const p = parsed as { plain?: T } & T;
    if (p && typeof p === 'object') return (p.plain ?? p) as T;
    return null;
  }

  /** 数据消息:只接受能解密的(解不开说明密钥不同/旧消息,跳过)。 */
  private async decryptData<T>(payload: string): Promise<T | null> {
    try {
      const parsed = JSON.parse(payload);
      return (await this.o.cipher.decrypt(parsed)) as T;
    } catch {
      return null;
    }
  }

  // ---------------- 在线常驻循环 ----------------
  /**
   * 一次完整对账:握手 → 按水位向量索取缺口 → 广播本端水位。
   *
   * 注意:return 里的 pulled **恒为 0** —— 数据是被对端**直投**过来的(异步到达,
   * 由 receive() 处理并触发界面刷新),不再有"这一步就能拉回来多少条"的概念。
   */
  async runOnce(): Promise<{ pushed: number; pulled: number }> {
    if (this.busy) return { pushed: 0, pulled: 0 };
    this.busy = true;
    try {
      await this.onLogin();
      const pushed = await this.serveNote(); // 兜底:本地有新数据就通知 + 广播增量
      return { pushed, pulled: 0 };
    } finally {
      this.busy = false;
    }
  }

  /** 兜底:本地若有未广播过的更新,补一次"广播增量 + notify"。 */
  private async serveNote(): Promise<number> {
    const wm = await this.watermark();
    const pushedAt = this.pushedAt();
    if (wm && (wm !== this.lastNotified || wm > pushedAt)) {
      await this.onLocalWrite();
      return 1;
    }
    return 0;
  }
}
