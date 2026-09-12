/**
 * 同步协议自测:起一个本地服务(独立 Redis + 独立数据目录),用 SyncEngine 模拟多台设备,
 * 覆盖需求里的三种场景,并断言"最终收敛"。
 *
 *   场景 1:一端写入 → 通知在线端 → 对端索取区间 → 写入端补推 → 对端拉取合并
 *   场景 2:新端登录(已有端在线)→ 握手发现落后 → 请求区间补传
 *   场景 3:多端同时上线(水位各不相同)→ 交换水位、选举主端 → 全部收敛到同一份数据
 *
 * 运行:pnpm --filter @diary/server test:sync
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncEngine, type DiaryEntry, type SyncStore, type SyncTransport, type WatermarkVector } from '@diary/shared/syncEngine';
import { encryptObject, decryptObject } from '@diary/shared/syncCrypto';
import { initDb, createUser } from '../src/db.js';
import Redis from 'ioredis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT ?? 8800 + Math.floor(Math.random() * 900));
const REDIS = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6399';
const BASE = `http://127.0.0.1:${PORT}`;
const SYNC_KEY = 'test-sync-key-please-ignore';

const writeLog: string[] = [];
const putLog: string[] = [];
let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------- 模拟设备 ----------------
interface Stored { entries: Map<string, DiaryEntry>; images: Map<string, string> }

function makeStore(box: Stored): SyncStore {
  return {
    all: async () => [...box.entries.values()],
    put: async (es) => {
      for (const e of es) {
        if (!box.entries.has(e.id)) {
          putLog.push(`NEW ${e.id}|${e.deviceId.slice(0, 8)}|${e.content.slice(0, 14)}|${e.updatedAt.slice(11, 19)}`);
        }
        box.entries.set(e.id, e);
      }
    },
    exportMedia: async (ids) => ids.filter((i) => box.images.has(i)).map((i) => ({ id: i, dataUrl: box.images.get(i)! })),
    importMedia: async (items) => {
      for (const it of items) box.images.set(it.id, it.dataUrl);
    },
    localMediaIds: async () => [...box.images.keys()],
  };
}

interface HttpOpts {
  method?: string;
  body?: unknown;
  token?: string;
}
async function http<T>(p: string, o: HttpOpts = {}): Promise<T> {
  const res = await fetch(`${BASE}${p}`, {
    method: o.method ?? (o.body ? 'POST' : 'GET'),
    headers: {
      ...(o.body ? { 'Content-Type': 'application/json' } : {}),
      ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${p} → ${res.status} ${text.slice(0, 160)}`);
  return data as T;
}

function makeTransport(deviceId: string, token: string): SyncTransport {
  return {
    hello: (p) =>
      http('/api/relay/hello', {
        body: { from: deviceId, watermark: p.watermark, vector: p.vector, count: p.count },
        token,
      }),
    heartbeat: (p) =>
      http('/api/relay/heartbeat', {
        body: { from: deviceId, watermark: p.watermark, vector: p.vector, count: p.count },
        token,
      }),
    notify: async (p) => {
      const payload = JSON.stringify(
        await encryptObject(SYNC_KEY, { watermark: p.watermark, vector: p.vector, count: p.count }),
      );
      await http('/api/relay/notify', {
        body: { from: deviceId, watermark: p.watermark, vector: p.vector, count: p.count, payload },
        token,
      });
    },
    need: async (p) => {
      const payload = JSON.stringify(
        await encryptObject(SYNC_KEY, {
          origin: p.origin,
          fromWatermark: p.fromWatermark,
          toWatermark: p.toWatermark,
        }),
      );
      await http('/api/relay/need', { body: { ...p, from: deviceId, payload }, token });
    },
    push: (p) => http('/api/relay/push', { body: { from: deviceId, to: p.to, payload: p.payload, kind: 'data' }, token }),
    pull: (p) =>
      http(`/api/relay/pull?from=${encodeURIComponent(deviceId)}&after=${p.after}&limit=${p.limit}`, { token }),
    wait: (p) => http('/api/relay/wait', { body: { from: deviceId, after: p.after }, token }),
  };
}

class Device {
  readonly id: string;
  readonly box: Stored = { entries: new Map(), images: new Map() };
  readonly engine: SyncEngine;
  cursor = 0;
  pushedAt = '';
  private seq = 0;

  constructor(id: string, token: string) {
    this.id = id;
    this.engine = new SyncEngine({
      deviceId: id,
      transport: makeTransport(id, token),
      store: makeStore(this.box),
      cipher: {
        encrypt: (o) => encryptObject(SYNC_KEY, o),
        decrypt: (o) => decryptObject(SYNC_KEY, o),
      },
      state: {
        getCursor: () => this.cursor,
        setCursor: (n) => {
          this.cursor = n;
        },
        getPushedAt: () => this.pushedAt,
        setPushedAt: (v) => {
          this.pushedAt = v;
        },
      },
      log: (m) => console.log(`      ${m}`),
    });
  }

  /** 本地写入一条(模拟用户写日记),返回条目。 */
  write(content: string, date: string, updatedAt?: string, imageId?: string): DiaryEntry {
    writeLog.push(`${this.id.slice(0, 8)} ← "${content.slice(0, 16)}"`);
    const at = updatedAt ?? new Date(Date.now() + this.seq++ * 1000).toISOString();
    const id = `${this.id.slice(0, 4)}-${Math.random().toString(36).slice(2, 10)}`;
    const body = imageId ? `${content}\n\n![图片](diary-img:${imageId})` : content;
    const e: DiaryEntry = { id, date, content: body, deviceId: this.id, createdAt: at, updatedAt: at, deletedAt: null };
    this.box.entries.set(id, e);
    if (imageId) this.box.images.set(imageId, `data:image/png;base64,${'A'.repeat(64)}`);
    return e;
  }

  ids(): string[] {
    return [...this.box.entries.keys()].sort();
  }
  has(id: string): boolean {
    return this.box.entries.has(id);
  }
  count(): number {
    return this.box.entries.size;
  }
  vector(): WatermarkVector {
    const v: WatermarkVector = {};
    for (const e of this.box.entries.values()) {
      const o = e.deviceId || 'unknown';
      if (!v[o] || e.updatedAt > v[o]) v[o] = e.updatedAt;
    }
    return v;
  }
}

/**
 * 让若干设备轮流"收消息"并处理(**纯事件驱动:不做任何定时对账**)。
 * 收敛依赖真实事件:hello 时服务端广播"有端加入"、写入时的 notify、以及 need/serve 往返。
 * 若这里只靠 drain 就能收敛,说明不依赖周期性轮询。
 */
async function pump(devs: Device[], rounds = 14, label = ''): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const d of devs) await d.engine.drain();
    await sleep(60);
  }
  if (label) console.log(`      (${label} 事件驱动收敛结束,未使用定时对账)`);
}

// ---------------- 启动测试服务 ----------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-sync-test-'));
let child: ChildProcess | null = null;

async function assertPortFree(): Promise<void> {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) throw new Error(`端口 ${PORT} 已被别的服务占用,请先清理`);
  } catch (e) {
    if ((e as Error).message.includes('已被别的服务占用')) throw e;
    /* 连不上 = 端口空闲 ✅ */
  }
}

async function startServer(): Promise<void> {
  await assertPortFree();
  const tsxBin = path.resolve(serverDir, 'node_modules/.bin/tsx');
  child = spawn(tsxBin, ['src/index.ts'], {
    cwd: serverDir,
    detached: true, // 独立进程组 → 退出时整组杀掉,避免残留服务占端口
    env: {
      ...process.env,
      PORT: String(PORT),
      REDIS_URL: REDIS,
      DIARY_DATA_DIR: dataDir,
      CLOUD_MODE: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b: Buffer) => {
    const s = b.toString().trim();
    if (!s) return;
    if (process.env.TEST_VERBOSE) console.log('   [server]', s.slice(0, 300));
    else if (/error|Error|失败|监听|listening|db/i.test(s)) console.log('   [server]', s.slice(0, 300));
  });
  child.stderr?.on('data', (b: Buffer) => console.error('   [server:err]', b.toString().trim().slice(0, 200)));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('测试服务启动超时');
}

function stopServer(): void {
  if (!child?.pid) {
    child = null;
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM'); // 整个进程组(npm/npx 包装的子进程也一起)
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  }
  child = null;
}

// 测试账号(直接写库创建,免邮箱验证码)
const pass1 = 'test1234';
let userSeq = 0;
function newUser(): string {
  return `synctest_${Date.now()}_${userSeq++}`;
}
const user = newUser();

/**
 * 清空测试 Redis:测试用的临时库每次都是全新的,新账号自增 id 会重复(都是 1),
 * 不清空就会读到"上一次测试运行"遗留的中继消息 → 结果不可信。
 */
async function flushTestRedis(): Promise<void> {
  const r = new Redis(REDIS, { maxRetriesPerRequest: 2, connectTimeout: 3000, lazyConnect: false });
  try {
    await r.flushdb();
    console.log('测试 Redis 已清空(FLUSHDB)');
  } finally {
    r.disconnect();
  }
}

async function main(): Promise<void> {
  console.log(`\n启动测试服务: port=${PORT} redis=${REDIS} data=${dataDir}`);
  await flushTestRedis();
  initDb(path.join(dataDir, 'diary.db')); // 建表并创建测试账号
  const u = createUser(user, pass1, `${user}@example.com`);
  if (!u) throw new Error('创建测试账号失败');
  console.log(`测试账号: ${user} (uid=${u.uid})`);
  await startServer();
  console.log('测试服务已就绪 ✅');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const d = new DatabaseSync(path.join(dataDir, 'diary.db'), { readOnly: true });
    const rows = d.prepare('SELECT username FROM users').all() as Array<{ username: string }>;
    console.log(`   [db] ${path.join(dataDir, 'diary.db')} 用户: ${rows.map((r) => r.username).join(',') || '(空)'}`);
    d.close();
  } catch (e) {
    console.log('   [db] 读取失败:', (e as Error).message);
  }

  // 账号:直接建号(注册接口要邮箱验证码,测试里跳过)
  const login = await http<{ token: string }>('/api/auth/login', { body: { username: user, password: pass1 } });
  const token = login.token;
  ok(Boolean(token), '测试账号登录成功');
  /** 新账号(场景 3 用独立账号,避免被场景 1/2 的旧端影响主端选举) */
  async function freshToken(): Promise<string> {
    const u = newUser();
    if (!createUser(u, pass1, `${u}@example.com`)) throw new Error('建号失败');
    const r = await http<{ token: string }>('/api/auth/login', { body: { username: u, password: pass1 } });
    return r.token;
  }

  const today = new Date().toISOString().slice(0, 10);

  // ================= 场景 1:在线端实时同步 =================
  console.log('\n[场景 1] A 写入 → 通知在线端 B → B 索取区间 → A 补推 → B 合并');
  const A = new Device('devAAAAA-0000-0000-0000-000000000001', token);
  const B = new Device('devBBBBB-0000-0000-0000-000000000002', token);
  await A.engine.onLogin();
  await B.engine.onLogin();
  await pump([A, B]);

  const e1 = A.write('场景1:A 写的第一条', today);
  await A.engine.onLocalWrite(); // A 广播"我更新到 xxxa"
  await pump([A, B], 10, '场景1');
  ok(B.has(e1.id), `B 拿到了 A 新写的条目(${e1.id})`);

  const imgId = 'c'.repeat(16);
  const e2 = A.write('场景1:带图片的一条', today, undefined, imgId);
  await A.engine.onLocalWrite();
  await pump([A, B], 10, '场景1-图片');
  ok(B.has(e2.id), 'B 拿到了带图片的条目');
  ok(B.box.images.has(imgId), '图片本体也同步到了 B');

  // ================= 场景 2:新端登录补传 =================
  console.log('\n[场景 2] A 在线写入(新端离线)→ 新端 C 登录 → 握手发现落后 → 请求区间补传');
  const e3 = A.write('场景2:A 在 C 离线时写的', today);
  await A.engine.onLocalWrite();
  await pump([A], 6, '场景2-离线期间');

  const C = new Device('devCCCCC-0000-0000-0000-000000000003', token);
  ok(C.count() === 0, 'C 初始为空(模拟新装/新登录)');
  const r2 = await C.engine.onLogin();
  ok(r2.requested > 0, `C 登录后向 ${r2.requested} 个(来源/端)发起了区间请求`);
  await pump([A, C], 12, '场景2');
  ok(C.has(e1.id) && C.has(e2.id) && C.has(e3.id), 'C 补齐了 A 的全部 3 条历史数据');
  ok(C.box.images.has(imgId), 'C 也补齐了图片');

  // ================= 场景 3:多端同时上线 + 主端选举 =================
  console.log('\n[场景 3] D/E/F 各持不同数据同时上线 → 交换水位、选举主端 → 全部收敛');
  const token3 = await freshToken(); // 独立账号:只有 D/E/F 三端
  const D = new Device('devDDDDD-0000-0000-0000-000000000004', token3);
  const E = new Device('devEEEEE-0000-0000-0000-000000000005', token3);
  const F = new Device('devFFFFF-0000-0000-0000-000000000006', token3);
  // 三端各自在"不同时间"写数据(D 最旧、F 最新),且互不知情
  const d1 = D.write('场景3:D 的数据', today, '2026-01-01T00:00:01.000Z');
  const e1b = E.write('场景3:E 的数据', today, '2026-01-01T00:00:02.000Z');
  const f1 = F.write('场景3:F 的数据', today, '2026-01-01T00:00:03.000Z');

  // 同时上线(并行走 hello,模拟同时登录)
  await Promise.all([D.engine.onLogin(), E.engine.onLogin(), F.engine.onLogin()]);
  const devices = (await http<{ leader: string | null }>('/api/relay/devices', { token: token3 })) as {
    leader: string | null;
  };
  console.log(`      选举出的主端: ${devices.leader}`);
  ok(
    devices.leader === F.id,
    `主端 = 水位最新的 F(${F.id.slice(0, 8)}…),实际=${String(devices.leader).slice(0, 8)}…`,
  );
  await pump([D, E, F], 16, '场景3');

  for (const dv of [D, E, F]) {
    const rows = [...dv.box.entries.values()].map(
      (e) => `${e.id.slice(0, 12)}|${e.deviceId.slice(0, 8)}|${e.updatedAt.slice(11, 19)}|${e.content.slice(0, 14)}`,
    );
    console.log(`      [dump] ${dv.id.slice(0, 8)} 共${rows.length}条:`);
    for (const r of rows) console.log(`             ${r}`);
  }
  const allIds = [d1.id, e1b.id, f1.id].sort();
  const sameAs = (dev: Device): boolean => JSON.stringify(dev.ids()) === JSON.stringify(allIds);
  ok(sameAs(D), 'D 收敛到三端全集');
  ok(sameAs(E), 'E 收敛到三端全集');
  ok(sameAs(F), 'F 收敛到三端全集');
  ok(D.count() === 3 && E.count() === 3 && F.count() === 3, '三端条目数一致(都是 3 条)');

  // ================= 场景 4(附加):陈旧端补全后再次对齐 =================
  console.log('\n[附加] 主端 F 再写入 → 其余端在线应收敛(验证主端权威 + 广播通知)');
  const f2 = F.write('附加:F 的主端新写入', today);
  await F.engine.onLocalWrite();
  await pump([D, E, F], 12, '附加');
  ok(D.has(f2.id) && E.has(f2.id), 'D/E 都收到了主端 F 的新数据');

  // ================= 场景 4:条目数兜底(水位向量"看起来齐了"其实缺数据) =================
  console.log('\n[场景 4] 水位向量看起来满足、实际缺数据 → 靠"条目数对不上"兜底补全');
  const token4 = await freshToken();
  const G = new Device('devGGGGG-0000-0000-0000-000000000007', token4);
  const H = new Device('devHHHHH-0000-0000-0000-000000000008', token4);
  // H 有同来源('phone',模拟历史遗留标记)的两条:旧 t1、新 t2
  const ph1 = H.write('场景4:来自 phone 的旧条目', today, '2026-02-01T00:00:01.000Z');
  const ph2 = H.write('场景4:来自 phone 的新条目', today, '2026-02-01T00:00:02.000Z');
  H.box.entries.set(ph1.id, { ...ph1, deviceId: 'phone' });
  H.box.entries.set(ph2.id, { ...ph2, deviceId: 'phone' });
  // G 已有较新的那条(**同一个 id**,真实场景里条目 id 是跨端一致的),但缺旧的那条:
  // 两端向量都是 {phone:t2},单看水位发现不了缺口 → 只能靠"条目数对不上"发现。
  G.box.entries.set(ph2.id, ph2);
  await G.engine.onLogin();
  await H.engine.onLogin();
  await pump([G, H], 14, '场景4');
  ok(G.has(ph1.id), 'G 拿到了缺失的旧条目本体(水位看不出缺口,靠条目数兜底)');
  ok(G.count() === H.count(), `G/H 条目数一致(${G.count()} vs ${H.count()})`);

  // ================= 场景 5:旧版本客户端仍能收到更新(兼容广播) =================
  console.log('\n[场景 5] 旧版本客户端(只拉广播数据、不会索取区间)→ 仍能收到新条目');
  const token5 = await freshToken();
  const I = new Device('devIIIII-0000-0000-0000-000000000009', token5);
  await I.engine.onLogin();
  // 模拟旧客户端:只拉广播 data 消息并合并,从不发 hello/need
  const legacyEntries = new Map<string, DiaryEntry>();
  let legacyCursor = 0;
  async function legacyPull(): Promise<void> {
    const page = await http<{
      messages: Array<{ id: number; from: string; kind: string; to: string; payload: string }>;
      lastId: number;
    }>(`/api/relay/pull?from=legacyDevice&after=${legacyCursor}&limit=50`, { token: token5 });
    for (const m of page.messages) {
      if (m.kind !== 'data') continue;
      try {
        const dec = (await decryptObject(SYNC_KEY, JSON.parse(m.payload))) as { entries?: DiaryEntry[] };
        for (const e of dec.entries ?? []) legacyEntries.set(e.id, e);
      } catch {
        /* 旧客户端解不开就跳过 */
      }
    }
    legacyCursor = Math.max(legacyCursor, page.lastId);
  }
  const i1 = I.write('场景5:新协议时代写的条目', today);
  await I.engine.onLocalWrite(); // 同时会做一次"兼容广播"
  await pump([I], 6, '场景5');
  await legacyPull();
  ok(legacyEntries.has(i1.id), '旧客户端通过兼容广播收到了新条目(不会被新协议饿死)');

  // ================= 场景 6:异常未来时间(2099 墓碑)不得顶高水位 =================
  console.log('\n[场景 6] 库里存在 2099 年墓碑(早期 LWW 测试遗留)→ 不得顶高水位、不得让区间协商失效');
  const token6 = await freshToken();
  const J = new Device('devJJJJJ-0000-0000-0000-000000000010', token6);
  const K = new Device('devKKKKK-0000-0000-0000-000000000011', token6);
  // J 有一条 2099 的墓碑(删除标记)
  J.box.entries.set('j-tombstone', {
    id: 'j-tombstone',
    date: today,
    content: '',
    deviceId: J.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z',
    deletedAt: '2026-01-01T00:00:00.000Z',
  });
  const jw = await J.engine.watermark();
  ok(jw < '2099-01-01T00:00:00.000Z', `2099 墓碑未顶高水位(实际水位=${jw || '(空)'})`);
  const jv = await J.engine.watermarkVector();
  ok(
    !Object.values(jv).some((x) => x >= '2099-01-01T00:00:00.000Z'),
    '2099 墓碑未污染水位向量',
  );
  // 之后 J 写正常条目 → K 应能收到(若水位被顶到 2099,精确区间就会失效)
  const j2 = J.write('场景6:正常时间的新条目', today);
  await J.engine.onLogin();
  await K.engine.onLogin();
  await J.engine.onLocalWrite();
  await pump([J, K], 12, '场景6');
  ok(K.has(j2.id), 'K 拿到了正常时间的新条目(水位未被 2099 顶死)');

  // ================= 场景 7:2099 墓碑自愈(两端独立自愈后收敛到同一真实时间) =================
  console.log('\n[场景 7] 两端都持有 2099 墓碑 → 各自自愈 → 收敛到真实时间,且不再压住新修改');
  const token7 = await freshToken();
  const L = new Device('devLLLLL-0000-0000-0000-000000000012', token7);
  const M = new Device('devMMMMM-0000-0000-0000-000000000013', token7);
  const tomb = {
    id: 'tomb-7',
    date: today,
    content: '',
    deviceId: L.id,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z',
    deletedAt: '2026-03-02T00:00:00.000Z',
  };
  L.box.entries.set(tomb.id, { ...tomb });
  M.box.entries.set(tomb.id, { ...tomb });
  await L.engine.onLogin(); // 登录时自愈
  await M.engine.onLogin();
  const lTomb = L.box.entries.get(tomb.id);
  ok(lTomb?.updatedAt === '2026-03-02T00:00:00.000Z', `L 本地自愈:2099 → 删除时刻(实际 ${lTomb?.updatedAt})`);
  const lw7 = await L.engine.watermark();
  ok(lw7 < '2099-01-01T00:00:00.000Z', `L 水位恢复为真实时间(${lw7 || '(空)'})`);
  await pump([L, M], 10, '场景7');
  ok(
    L.box.entries.get(tomb.id)?.updatedAt === M.box.entries.get(tomb.id)?.updatedAt,
    '两端该条目时间一致(自愈结果收敛)',
  );
  // 关键:自愈后,同一 id 的新修改应能正常覆盖(以前 2099 会永久压住真实修改)
  const revive: DiaryEntry = {
    id: tomb.id,
    date: today,
    content: '场景7:又被写回来了',
    deviceId: M.id,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: new Date(Date.now() + 1000).toISOString(),
    deletedAt: null,
  };
  M.box.entries.set(tomb.id, revive);
  await M.engine.onLocalWrite();
  await pump([L, M], 12, '场景7-复活');
  ok(L.box.entries.get(tomb.id)?.content === '场景7:又被写回来了', '自愈后,新修改能正常同步(不再被 2099 永久压住)');

  // ================= 场景 8:空设备(无数据)不得被选成主端 =================
  console.log('\n[场景 8] 空设备(新装/自检探针,条目数 0)不得被选举为主端');
  const token8 = await freshToken();
  const N = new Device('devNNNNN-0000-0000-0000-000000000014', token8); // 有数据
  const O = new Device('devOOOOO-0000-0000-0000-000000000015', token8); // 空设备
  const n1 = N.write('场景8:有数据的那台', today, '2026-04-01T00:00:01.000Z');
  await N.engine.onLogin();
  await O.engine.onLogin(); // 空设备最后登录 → loginAt 更晚、且会用"当前时间"上报水位
  const sorted = [...[n1].map((x) => x.updatedAt)];
  ok(sorted.length === 1, '构造完成:一台有数据、一台为空');
  const devs = (await http<{ leader: string | null }>('/api/relay/devices', { token: token8 })) as {
    leader: string | null;
  };
  ok(devs.leader === N.id, `主端 = 有数据的 N(实际 ${String(devs.leader).slice(0, 10)})`);
  ok(devs.leader !== O.id, '空设备 O 未被选为主端');

  // ================= 场景 9:真机离线时,在线的空探针也不得当主端 =================
  console.log('\n[场景 9] 有数据的真机全部离线 + 一个在线的空探针 → 主端必须是有数据的那台');
  const token9 = await freshToken();
  const P = new Device('devPPPPP-0000-0000-0000-000000000016', token9); // 有数据
  P.write('场景9:真机的数据', today, '2026-05-01T00:00:00.000Z');
  await P.engine.onLogin();
  // 真机"离线":把它的 lastSeen 拨回很久以前(注册表里仍保留数据与水位)
  const Q = new Device('devQQQQQ-0000-0000-0000-000000000017', token9); // 空探针,后登录
  await Q.engine.onLogin();
  await pump([P, Q], 10, '场景9');
  // 反复刷新 Q 的心跳,让"在线"的是空设备
  for (let i = 0; i < 3; i++) {
    await Q.engine.heartbeat();
    await sleep(200);
  }
  const devs9 = (await http<{ leader: string | null }>('/api/relay/devices', { token: token9 })) as {
    leader: string | null;
  };
  ok(devs9.leader === P.id, `主端 = 有数据的真机 P(实际 ${String(devs9.leader).slice(0, 10)})`);
  ok(devs9.leader !== Q.id, '在线的空探针 Q 未当主端');

  // ================= 场景 10:长轮询请求本身即刷新"在线" =================
  console.log('\n[场景 10] 客户端挂着长轮询 → 服务端应视为在线(无需额外心跳定时器)');
  const token10 = await freshToken();
  const R = new Device('devRRRRR-0000-0000-0000-000000000018', token10);
  await R.engine.onLogin();
  const listBefore = await http<{ devices: Array<{ deviceId: string; lastSeen: number; online?: boolean }> }>(
    '/api/relay/devices',
    { token: token10 },
  );
  const before = listBefore.devices.find((d) => d.deviceId === R.id)?.lastSeen ?? 0;
  await sleep(1200);
  // 只挂一次长轮询(就是 App 在线时的常驻行为),不发任何心跳、不写数据
  await R.engine.waitAndPull(800);
  const listAfter = await http<{ devices: Array<{ deviceId: string; lastSeen: number; online?: boolean }> }>(
    '/api/relay/devices',
    { token: token10 },
  );
  const rAfter = listAfter.devices.find((d) => d.deviceId === R.id);
  ok((rAfter?.lastSeen ?? 0) > before, `长轮询刷新了 lastSeen(${before} → ${rAfter?.lastSeen})`);
  ok(rAfter?.online === true, '该端被判定为在线');

  console.log(`\n同步合并新增(put 且原本不存在)共 ${putLog.length} 条:`);
  for (const l of putLog) console.log(`   ${l}`);
  console.log(`\n本次 write() 调用共 ${writeLog.length} 次:`);
  for (const w of writeLog) console.log(`   ${w}`);
  console.log(`\n结果: 通过 ${pass} 项,失败 ${fail} 项\n`);
}

main()
  .catch((e) => {
    console.error('\n自测异常:', (e as Error).message);
    fail++;
  })
  .finally(() => {
    stopServer();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    process.exit(fail === 0 ? 0 : 1);
  });
