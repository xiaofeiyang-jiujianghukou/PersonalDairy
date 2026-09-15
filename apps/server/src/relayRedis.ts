/**
 * 中继的**唯一**持久状态:多端水位注册表。数据面完全不经过这里。
 *
 * 原则(按需求方定义):**在线即同步,离线不同步**。
 *   数据由服务端在两个 WebSocket 之间**直投**(见 index.ts 的 deliverToDevice /
 *   deliverToOthers),不落任何存储 —— 没有信箱、没有消息队列、没有"取走即删"这一层。
 *   离线端错过的东西,靠它下次上线时的「水位向量对账」补齐(协议本身是自愈的)。
 *
 * 服务端保留的只有这一样东西(纯元数据,不含任何内容):
 *   trans:{uid}:reg   多端状态(每台设备的水位 / 水位向量 / 条目数 / 登录时刻 / 最近活跃)
 *
 * 隐私:中转的载荷一律是端到端加密的密文,服务端不解密、不读内容。
 */
import Redis from 'ioredis';

let client: Redis | null = null;

export function initRelayRedis(url: string): void {
  if (client) return;
  client = new Redis(url, {
    // 连不上就**快速失败**,不要无限重试 —— 实测事故:Redis 被 OOM 杀掉后,
    // maxRetriesPerRequest: null 让每条命令无限挂起,把整个中继拖成"客户端超时",
    // 排查方向被带偏了很久。这里宁可报错,也不要静默挂死。
    maxRetriesPerRequest: 2,
    commandTimeout: 5000, // 单条命令 5 秒无响应即报错(兜底)
    connectTimeout: 3000,
    lazyConnect: false,
  });
  client.on('error', (e) => {
    console.error('[relay-redis] 连接错误(检查 Redis 是否在运行):', (e as Error).message);
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

// ==================== 旧版遗留 key 的清理 ====================

/**
 * 清理历史版本留下的死 key(**只删确定无用的,绝不碰当前在用的 `trans:{uid}:reg`**)。
 *
 *   trans:{uid}:events         旧版:Redis Stream 共享消息日志(线上实测堆到 99MB)
 *   trans:{uid}:seq            旧版:Stream 自增序号
 *   trans:{uid}:offset:{dev}   旧版:每设备游标
 *   trans:{uid}:devices        旧版:终端集合 SET
 *   trans:{uid}:mbox:{dev}     上一版:每设备信箱(现在改为 WS 直投,已无意义)
 *
 * 背景:当年重构只删了**代码**,没删线上**数据**,于是这些 key 一直占着内存
 * (Stream 的 radix tree 即使条目被裁掉也不把内存还给系统)。启动时扫一遍清掉,
 * 任何环境升级都自动生效,不需要人工记得去 redis-cli。
 *
 * 清理失败不影响服务启动。
 */
export async function cleanupLegacyKeys(): Promise<number> {
  const r = c();
  const patterns = ['trans:*:events', 'trans:*:seq', 'trans:*:offset:*', 'trans:*:devices', 'trans:*:mbox:*'];
  let removed = 0;
  for (const pattern of patterns) {
    try {
      const stream = r.scanStream({ match: pattern, count: 200 });
      for await (const keys of stream as AsyncIterable<string[]>) {
        if (Array.isArray(keys) && keys.length) removed += Number(await r.del(...keys)) || 0;
      }
    } catch (e) {
      console.error(`[relay-redis] 清理遗留 key 失败(${pattern}):`, (e as Error).message);
    }
  }
  return removed;
}

/** 从注册表移除一台终端(用于清理无数据且长期离线的僵尸记录)。 */
export async function deviceForget(uid: number, deviceId: string): Promise<void> {
  if (!deviceId) return;
  const r = c();
  await r.hdel(regKey(uid), deviceId);
}

/**
 * 让某台终端下线(设备丢失/更换时使用)。
 *
 * 做两件事:
 *   ① 从注册表移除,它不再出现在终端列表里、也不参与主端选举;
 *   ② 记入拒绝名单 rev:{uid},该设备号的 sync 请求一律被拒 —— 即使它手里还留着
 *      登录令牌,也无法再通过中继收发数据。
 *
 * 诚实说明:这台设备本地仍存着已同步到的日记内容,服务端删不掉(我们本来就不保存内容)。
 * 所以"丢手机"的正确组合是:先在这里下线该终端,再去改密码(同步密钥由密码派生,改密码后
 * 它对后续新增数据也无能为力)。
 */
export async function relayRevoke(uid: number, deviceId: string): Promise<void> {
  if (!deviceId) return;
  const r = c();
  await r.hdel(regKey(uid), deviceId);
  await r.sadd(`trans:${uid}:revoked`, deviceId);
  await r.expire(`trans:${uid}:revoked`, 365 * 24 * 3600);
}

/** 该设备是否已被下线。 */
export async function relayIsRevoked(uid: number, deviceId: string): Promise<boolean> {
  if (!deviceId) return false;
  const r = c();
  return (await r.sismember(`trans:${uid}:revoked`, deviceId)) === 1;
}
