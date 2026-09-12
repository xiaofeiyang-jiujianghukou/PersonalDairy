/**
 * Redis 中继 —— **服务端不承担存储**,只做"把东西递给此刻在线的端"。
 *
 * 原则(按需求方定义):
 *   端与端之间是请求/应答式沟通 ——"我少了数据 → 请你推给我 → 好的 → 我拉走了"。
 *   服务端只是中转站,**取走即删**,因此永远轻量且即时。
 *
 * 服务端保留的只有两样东西:
 *   trans:{uid}:reg         多端状态(每台设备的水位 / 水位向量 / 条目数 / 登录时刻 / 最近活跃)
 *   trans:{uid}:mbox:{dev}  该端**尚未取走的信件**(LIST),取走即删;TTL 只作兜底
 *
 * 离线端不投递:它回来时按"水位向量比对"向在线的端索取即可,服务端无需为它攒数据。
 * 隐私:中转的载荷一律是端到端加密的密文,服务端不解密、不读内容。
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

/** 消息类型:data=加密增量;notify=我更新了(带水位);need=请把某区间推给我; */
export type RelayKind = 'data' | 'notify' | 'need';

// ==================== 多端状态(注册表) ====================

/** 终端状态:watermark = 该端已知的最新更新时间点;vector = 按来源设备的水位向量。 */
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

/** 心跳窗口:超过这个时间没心跳即视为离线(离线的端不投递、不参选主端)。 */
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
 * 注册/更新本端。isLogin=true 表示"本次是登录/冷启动"→ 刷新 loginAt(选举的第二判据)。
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
  return deviceList(uid);
}

/** 只更新水位/心跳,不动 loginAt。 */
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
 * 只刷新"最近出现时间"(在线状态),**不动水位/向量/条目数**。
 *
 * 用途:长轮询 /api/relay/wait 被客户端持续挂起 —— 该请求本身就是"我还活着"的信号,
 * 收到即刷新 lastSeen。这样在线状态不需要任何额外的心跳定时器,零额外流量。
 */
export async function deviceSeen(uid: number, deviceId: string): Promise<void> {
  if (!deviceId) return;
  const r = c();
  const raw = await r.hget(regKey(uid), deviceId);
  const now = Date.now();
  if (!raw) {
    // 没注册过(例如刚装的端先挂了长轮询):建一条空记录,只用于在线显示
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
    /* 忽略坏数据 */
  }
}

/**
 * 主端选举 —— 严格按需求方的规则:
 *   「谁更新时间最新谁就是老大;时间相同,谁最先登录谁是老大」
 *
 *   · 候选 = 有水位(真的持有数据)的端;没有水位的空端(新装/探针)不参选;
 *   · 在场优先:候选里先看在线的;在线候选为空时退化为全部候选
 *     (手机被系统冻结时"在线"并不可靠,但它持有的数据依然算数);
 *   · 排序:水位最新 → 登录最早 → deviceId(稳定兜底)。
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

// ==================== 每设备信箱(取走即删) ====================

const MBOX_TTL = 7 * 24 * 3600; // 仅作兜底:正常情况下信件几秒内就被取走
const mboxKey = (uid: number, deviceId: string) => `trans:${uid}:mbox:${deviceId}`;

/**
 * 投递一条给指定设备 —— **只投给此刻在线的端**。
 * 离线的端不投(它回来时按水位向量索取即可),所以服务端几乎不积压任何数据。
 * 返回是否真的投进去了。
 */
export async function mboxPush(uid: number, deviceId: string, payload: string): Promise<boolean> {
  if (!deviceId) return false;
  const info = (await deviceList(uid)).find((d) => d.deviceId === deviceId);
  if (!info || Date.now() - info.lastSeen > DEVICE_ONLINE_MS) return false; // 离线:不存
  const r = c();
  const k = mboxKey(uid, deviceId);
  await r.rpush(k, payload);
  await r.expire(k, MBOX_TTL);
  return true;
}

/** 投递给该账号**除 exclude 之外、且当前在线**的设备。 */
export async function mboxPushToOthers(uid: number, exclude: string, payload: string): Promise<number> {
  const now = Date.now();
  const devices = await deviceList(uid);
  let n = 0;
  for (const d of devices) {
    if (d.deviceId === exclude) continue;
    if (now - d.lastSeen > DEVICE_ONLINE_MS) continue; // 离线的不投
    if (await mboxPush(uid, d.deviceId, payload)) n++;
  }
  return n;
}

/** 取走该设备信箱里的最多 limit 条(取走即消费,原子操作 —— 服务端不留存)。 */
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
