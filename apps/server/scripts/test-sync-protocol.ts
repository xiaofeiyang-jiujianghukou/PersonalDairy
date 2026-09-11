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
      http('/api/relay/hello', { body: { from: deviceId, watermark: p.watermark, vector: p.vector }, token }),
    heartbeat: (p) =>
      http('/api/relay/heartbeat', { body: { from: deviceId, watermark: p.watermark, vector: p.vector }, token }),
    notify: async (p) => {
      const payload = JSON.stringify(await encryptObject(SYNC_KEY, { watermark: p.watermark, vector: p.vector }));
      await http('/api/relay/notify', { body: { from: deviceId, watermark: p.watermark, vector: p.vector, payload }, token });
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
 * 让若干设备轮流"收消息",其间穿插两次完整同步(runOnce:握手→按需索取区间→拉净→广播水位),
 * 模拟真实 App 的"实时收 + 定时对账"。多端同时上线存在注册竞态,定时对账是收敛的保证。
 */
async function pump(devs: Device[], rounds = 8, label = ''): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const d of devs) await d.engine.drain();
    await sleep(60);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const d of devs) await d.engine.runOnce(); // 完整同步(含 hello 对账)
    for (let i = 0; i < 4; i++) {
      for (const d of devs) await d.engine.drain();
      await sleep(70);
    }
  }
  if (label) console.log(`      (${label} 收敛轮询结束)`);
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
