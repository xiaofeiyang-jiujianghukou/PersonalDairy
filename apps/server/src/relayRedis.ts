/**
 * Redis 中继(消息中间件)—— 满足"每账号有序消息日志 + 每终端游标 + 全消费后删除 + 阻塞读实时唤醒"。
 *
 * 结构(每账号 uid 一套):
 *   trans:{uid}:events   Redis Stream,每条消息 ID 用 <seq>-0(seq 单调递增),载荷为加密增量(不动内容)
 *   trans:{uid}:seq      自增计数器(分配顺序 seq)
 *   trans:{uid}:offset:{deviceId}   该终端已消费到哪(游标),30 天过期(淘汰不再同步的终端)
 *   trans:{uid}:devices  该账号的终端集合(SET)
 *   trans:{uid}:reg      终端注册表(HASH: deviceId -> {watermark,loginAt,lastSeen}) —— 水位线协商/在线判断/主端选举用
 *
 * 关键点:
 *   - 多终端各有各自 offset,互不消费 → 每条消息可被多个终端各自拉到。
 *   - 删除(省资源):只有当"所有终端都消费到"某消息(seq <= min(全部 offset))时才 XDEL;
 *     新终端 offset=0 → min=0 → 不删,能从头拉取恢复。
 *   - 实时:wait 用 XREAD BLOCK 阻塞读,一有 XADD 即唤醒(替代长轮询/内存等待表)。
 *   - 隐私:服务端只透传加密 payload,永不解密、不读内容。
 */
import Redis from 'ioredis';

let client: Redis | null = null;

export function initRelayRedis(url: string): void {
  if (client) return;
  client = new Redis(url, { maxRetriesPerRequest: null, connectTimeout: 3000, lazyConnect: false });
  client.on('error', (e) => {
    console.error('[relay-redis] 连接错误:', (e as Error).message);
  });
}
export function closeRelayRedis(): void {
  client?.disconnect();
  client = null;
}
function c(): Redis {
  if (!client) throw new Error('Redis 中继未初始化');
  return client;
}

const evKey = (uid: number) => `trans:${uid}:events`;
const seqKey = (uid: number) => `trans:${uid}:seq`;
const offKey = (uid: number, dev: string) => `trans:${uid}:offset:${dev}`;
const devKey = (uid: number) => `trans:${uid}:devices`;
const OFFSET_TTL = 30 * 24 * 3600; // 设备游标 30 天过期(淘汰不再同步的终端)

/** 消息类型:data=加密增量;notify=我更新了(带水位);need=请把某区间推给我; */
export type RelayKind = 'data' | 'notify' | 'need';

/**
 * 推一条消息。返回分配的 seq(调用方可用作游标)。
 * @param kind 消息类型(默认 data)
 * @param to   定向接收方 deviceId;空串 = 广播给同账号其它所有终端
 */
export async function relayPush(
  uid: number,
  deviceId: string,
  payload: string,
  kind: RelayKind = 'data',
  to = '',
): Promise<number> {
  const r = c();
  const seq = await r.incr(seqKey(uid));
  await r.xadd(
    evKey(uid),
    `${seq}-0`,
    'deviceId', deviceId,
    'payload', payload,
    'kind', kind,
    'to', to,
    'ts', String(Date.now()),
  );
  await maybeTrim(uid);
  return seq;
}

export interface PullMsg {
  id: number;
  from: string;
  payload: string;
  kind: RelayKind;
  to: string;
}
/** 按游标拉取"别人"的消息(排除自己);每拉一次即视为本终端已消费到 lastId,上报游标。 */
export async function relayPull(
  uid: number,
  exclDevice: string,
  after: number,
  limit: number,
): Promise<{ messages: PullMsg[]; lastId: number }> {
  const r = c();
  const rows = await r.xrange(evKey(uid), `(${after}-0`, '+', 'COUNT', limit);
  const messages: PullMsg[] = [];
  let lastId = after;
  for (const [id, fields] of rows) {
    const seq = Number((id.split('-')[0] ?? '0')) || 0;
    if (seq > lastId) lastId = seq;
    let from = '';
    let payload = '';
    let kind: RelayKind = 'data';
    let to = '';
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === 'deviceId') from = String(fields[i + 1] ?? '');
      else if (fields[i] === 'payload') payload = String(fields[i + 1] ?? '');
      else if (fields[i] === 'kind') kind = (String(fields[i + 1] ?? 'data') as RelayKind) || 'data';
      else if (fields[i] === 'to') to = String(fields[i + 1] ?? '');
    }
    if (from === exclDevice) continue; // 不拉回自己推的(本地已有)
    if (to && to !== exclDevice) continue; // 定向消息:不是给我的,跳过(游标仍前进,避免卡住)
    messages.push({ id: seq, from, payload, kind, to });
  }
  // 上报本终端已消费位置(用于"全消费后删除")
  if (exclDevice) await reportOffset(uid, exclDevice, lastId);
  return { messages, lastId };
}

/** 上报终端游标 (专供客户端在完整拉取后调用,便于按"全消费"删除)。 */
export async function relayReportCursor(uid: number, deviceId: string, seq: number): Promise<void> {
  await reportOffset(uid, deviceId, seq);
  await maybeTrim(uid);
}

/**
 * 快速判断"after 之后是否有别人推送的新消息"(排除自己)。用于 /wait 的"已有新消息→立即返回"。
 * 注意:不用 XREAD BLOCK——它会占用共享连接,阻塞其它中继命令(推/拉)长达超时时间。
 * 实时唤醒由 index.ts 的内存等待表触发(push 后直接唤醒本进程内的等待者,单实例部署)。
 */
export async function relayHasNew(uid: number, after: number, excludeDev: string): Promise<boolean> {
  const r = c();
  const rows = await r.xrange(evKey(uid), `(${after}-0`, '+', 'COUNT', 50);
  for (const [, fields] of rows) {
    let from = '';
    let to = '';
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === 'deviceId') from = String(fields[i + 1] ?? '');
      else if (fields[i] === 'to') to = String(fields[i + 1] ?? '');
    }
    if (from === excludeDev) continue;
    if (to && to !== excludeDev) continue;
    return true;
  }
  return false;
}

async function reportOffset(uid: number, deviceId: string, seq: number): Promise<void> {
  const r = c();
  await r.sadd(devKey(uid), deviceId);
  await r.set(offKey(uid, deviceId), String(seq), 'EX', OFFSET_TTL);
}

/**
 * 删除消息:只删"所有终端都消费到(seq <= min offset) **且** 已超过保留期(>30 天)"的,
 * 以兼顾"省资源"与"新终端能恢复近期全量"(新终端 offset=0 → min=0 → 不删,可从头拉取)。
 */
async function maybeTrim(uid: number): Promise<void> {
  const r = c();
  const devices = await r.smembers(devKey(uid));
  if (!devices.length) return;
  const vals = await Promise.all(
    devices.map(async (d) => {
      const v = await r.get(offKey(uid, d));
      const n = Number(v ?? '0');
      return Number.isFinite(n) ? n : 0;
    }),
  );
  const minSeq = Math.min(...vals);
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  // 新协议(每设备信箱)已不再读这条共享日志,只有未升级的旧客户端会拉 —— 因此:
  //   · 旧客户端仍在拉:按"所有端都消费到"删(下面的 minSeq 逻辑);
  //   · 已经没人拉了(游标不再前进):仅按保留期删,避免日志无限增长。
  const bound = minSeq > 0 ? `${minSeq}-0` : '+';
  const rows = await r.xrange(evKey(uid), '-', bound);
  if (!rows.length) return;
  const del: string[] = [];
  for (const [id, fields] of rows) {
    let ts = 0;
    for (let i = 0; i < fields.length; i += 2) if (fields[i] === 'ts') ts = Number(fields[i + 1] ?? '0') || 0;
    if (!ts || ts >= cutoff) continue;
    // 有活跃旧客户端时:只删它已经消费过的;没有活跃游标时:按保留期删
    const seq = Number(String(id).split('-')[0]) || 0;
    if (minSeq > 0 && seq > minSeq) continue;
    del.push(String(id));
  }
  if (del.length) await r.xdel(evKey(uid), ...del);
}

// ==================== 设备注册表 / 水位线 / 主端选举 ====================

/** 终端信息:watermark = 该端已知的最新更新时间点(ISO);loginAt = 本次登录时刻;lastSeen = 最近心跳。 */
export interface DeviceInfo {
  deviceId: string;
  watermark: string;
  /** 按来源设备的水位向量(协商区间用)。 */
  vector: Record<string, string>;
  /** 该端本地条目数(含墓碑),用于"数量对不上就补全"的兜底。 */
  count: number;
  loginAt: number;
  lastSeen: number;
}

/** 心跳窗口:超过这个时间没心跳即视为离线。 */
export const DEVICE_ONLINE_MS = 90 * 1000;
const REG_TTL = 90 * 24 * 3600;

const regKey = (uid: number) => `trans:${uid}:reg`;

export async function deviceList(uid: number): Promise<DeviceInfo[]> {
  const r = c();
  const h = await r.hgetall(regKey(uid));
  const out: DeviceInfo[] = [];
  for (const [deviceId, json] of Object.entries(h ?? {})) {
    try {
      const o = JSON.parse(json) as Partial<DeviceInfo>;
      out.push({
        deviceId,
        watermark: String(o.watermark ?? ''),
        vector: (o.vector ?? {}) as Record<string, string>,
        count: Number(o.count ?? 0) || 0,
        loginAt: Number(o.loginAt ?? 0) || 0,
        lastSeen: Number(o.lastSeen ?? 0) || 0,
      });
    } catch {
      /* 忽略坏数据 */
    }
  }
  return out;
}

/**
 * 注册/更新本端。isLogin=true 表示"本次是登录/冷启动"→ 刷新 loginAt(用于选举的第二判据)。
 * 返回最新设备列表。
 */
export async function deviceRegister(
  uid: number,
  deviceId: string,
  watermark: string,
  isLogin = false,
  vector: Record<string, string> = {},
  count = 0,
): Promise<DeviceInfo[]> {
  const r = c();
  const now = Date.now();
  const prevRaw = await r.hget(regKey(uid), deviceId);
  let loginAt = now;
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw) as Partial<DeviceInfo>;
      if (!isLogin && Number(prev.loginAt)) loginAt = Number(prev.loginAt);
    } catch {
      /* 忽略 */
    }
  }
  const info: DeviceInfo = { deviceId, watermark, vector, count, loginAt, lastSeen: now };
  await r.hset(regKey(uid), deviceId, JSON.stringify(info));
  await r.expire(regKey(uid), REG_TTL);
  await r.sadd(devKey(uid), deviceId);
  return deviceList(uid);
}

/**
 * 只刷新"最近出现时间"(在线状态),**不动水位/向量/条目数**。
 *
 * 用途:长轮询 /api/relay/wait 被客户端持续挂起 —— 该请求本身就是"我还活着"的信号,
 * 收到即刷新 lastSeen。这样在线状态**不需要任何额外的心跳定时器**,零额外流量。
 * (此前的坑:在线只在"登录/写入通知"时刷新 → 开着 App 但 90 秒没写东西就被判离线。)
 */
export async function deviceSeen(uid: number, deviceId: string): Promise<void> {
  if (!deviceId) return;
  const r = c();
  const raw = await r.hget(regKey(uid), deviceId);
  const now = Date.now();
  if (!raw) {
    // 没注册过(旧版本客户端也会挂长轮询):建一条空记录,只用于在线显示
    await r.hset(
      regKey(uid),
      deviceId,
      JSON.stringify({ deviceId, watermark: '', vector: {}, count: 0, loginAt: now, lastSeen: now }),
    );
    await r.expire(regKey(uid), REG_TTL);
    return;
  }
  try {
    const prev = JSON.parse(raw) as DeviceInfo;
    prev.lastSeen = now;
    await r.hset(regKey(uid), deviceId, JSON.stringify(prev));
    await r.expire(regKey(uid), REG_TTL);
  } catch {
    /* 坏数据忽略 */
  }
}

/** 只更新水位线/心跳,不动 loginAt。 */
export async function deviceTouch(
  uid: number,
  deviceId: string,
  watermark: string,
  vector: Record<string, string> = {},
  count = 0,
): Promise<DeviceInfo[]> {
  return deviceRegister(uid, deviceId, watermark, false, vector, count);
}

/**
 * 主端选举 —— 严格按需求方的规则:
 *   「谁更新时间最新谁就是老大;时间相同,谁最先登录谁是老大」
 *
 * 实现细节:
 *   · 候选 = 有水位(即真的持有数据)的端。没有水位的空端(新装/自检探针)不参选 ——
 *     它们没有任何数据可提供,当主端毫无意义。
 *   · 在场优先:候选里先看在线的;在线候选为空时,退化为全部候选
 *     (手机被系统冻结时"在线"并不可靠,但它持有的数据依然算数)。
 *   · 排序:水位最新 → 登录最早 → deviceId(保证结果稳定)。
 */
export function pickLeader(devices: DeviceInfo[]): string | null {
  const candidates = devices.filter((d) => Boolean(d.watermark));
  if (!candidates.length) return null;
  const now = Date.now();
  const online = candidates.filter((d) => now - d.lastSeen <= DEVICE_ONLINE_MS);
  const pool = online.length ? online : candidates;
  const sorted = [...pool].sort((a, b) => {
    if (a.watermark !== b.watermark) return a.watermark < b.watermark ? 1 : -1; // ① 更新时间的
    if (a.loginAt !== b.loginAt) return a.loginAt - b.loginAt; // ② 相同时间 → 先登录的
    return a.deviceId < b.deviceId ? -1 : 1; // ③ 稳定兜底
  });
  return sorted[0]?.deviceId ?? null;
}


// ==================== 每设备信箱(替代"共享日志 + 游标") ====================
/**
 * 设计:协议里不再有"我读到第几条"这种位置概念。
 *
 *   · 给某台设备的东西(补传的数据、给它的请求) → 投进**它自己的信箱**(Redis LIST);
 *   · 客户端取走即消费(LPOP 语义),位置由队列本身表达,不会再出现
 *     "游标跑到前面/卡在后面导致永远漏收"这类问题;
 *   · 信箱带过期时间,长期不来的设备不会无限堆积。
 *
 * 说明:旧的共享 Stream(/api/relay/pull|wait,带游标)继续保留,只服务于尚未升级的
 * 旧客户端;新客户端完全不使用它。
 */
const MBOX_TTL = 7 * 24 * 3600;
const mboxKey = (uid: number, deviceId: string) => `trans:${uid}:mbox:${deviceId}`;

/** 投递一条给指定设备。 */
export async function mboxPush(uid: number, deviceId: string, payload: string): Promise<void> {
  if (!deviceId) return;
  const r = c();
  const k = mboxKey(uid, deviceId);
  await r.rpush(k, payload);
  await r.expire(k, MBOX_TTL);
}

/** 投递给该账号**除 exclude 之外**的所有已注册设备(用于广播类信号)。 */
export async function mboxPushToOthers(uid: number, exclude: string, payload: string): Promise<number> {
  const devices = await deviceList(uid);
  let n = 0;
  for (const d of devices) {
    if (d.deviceId === exclude) continue;
    await mboxPush(uid, d.deviceId, payload);
    n++;
  }
  return n;
}

/** 取走该设备信箱里的最多 limit 条(取走即消费,原子操作)。 */
export async function mboxDrain(uid: number, deviceId: string, limit = 50): Promise<string[]> {
  if (!deviceId) return [];
  const r = c();
  const k = mboxKey(uid, deviceId);
  const items = (await r.eval(
    `local items = redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
     if #items > 0 then redis.call('LTRIM', KEYS[1], #items, -1) end
     return items`,
    1,
    k,
    String(Math.max(1, limit)),
  )) as unknown as string[];
  return Array.isArray(items) ? items : [];
}

/** 信箱里还有多少条(诊断用)。 */
export async function mboxLen(uid: number, deviceId: string): Promise<number> {
  const r = c();
  return Number(await r.llen(mboxKey(uid, deviceId))) || 0;
}
