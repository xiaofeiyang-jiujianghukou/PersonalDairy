/**
 * Redis 中继(消息中间件)—— 满足"每账号有序消息日志 + 每终端游标 + 全消费后删除 + 阻塞读实时唤醒"。
 *
 * 结构(每账号 uid 一套):
 *   trans:{uid}:events   Redis Stream,每条消息 ID 用 <seq>-0(seq 单调递增),载荷为加密增量(不动内容)
 *   trans:{uid}:seq      自增计数器(分配顺序 seq)
 *   trans:{uid}:offset:{deviceId}   该终端已消费到哪(游标),30 天过期(淘汰不再同步的终端)
 *   trans:{uid}:devices  该账号的终端集合(SET)
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

/** 推一条加密增量。返回分配的 seq(调用方可用作游标)。 */
export async function relayPush(uid: number, deviceId: string, payload: string): Promise<number> {
  const r = c();
  const seq = await r.incr(seqKey(uid));
  await r.xadd(evKey(uid), `${seq}-0`, 'deviceId', deviceId, 'payload', payload, 'ts', String(Date.now()));
  await maybeTrim(uid);
  return seq;
}

interface PullMsg {
  id: number;
  from: string;
  payload: string;
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
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === 'deviceId') from = String(fields[i + 1] ?? '');
      else if (fields[i] === 'payload') payload = String(fields[i + 1] ?? '');
    }
    if (from === exclDevice) continue; // 不拉回自己推的(本地已有)
    messages.push({ id: seq, from, payload });
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
    for (let i = 0; i < fields.length; i += 2) if (fields[i] === 'deviceId') from = String(fields[i + 1] ?? '');
    if (from !== excludeDev) return true;
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
  if (minSeq <= 0) return;
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const rows = await r.xrange(evKey(uid), '-', `${minSeq}-0`);
  if (!rows.length) return;
  const del: string[] = [];
  for (const [id, fields] of rows) {
    let ts = 0;
    for (let i = 0; i < fields.length; i += 2) if (fields[i] === 'ts') ts = Number(fields[i + 1] ?? '0') || 0;
    if (ts && ts < cutoff) del.push(String(id));
  }
  if (del.length) await r.xdel(evKey(uid), ...del);
}
