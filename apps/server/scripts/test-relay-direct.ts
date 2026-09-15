/**
 * 中继**直投**自测(新架构:服务端零存储,数据只在两台同时在线的设备之间用 WebSocket 直投)。
 *
 *   场景 1:在线即实时 —— A 写入 → notify 直投 B → B 索取 → A 补推 → B 秒级合并(**不轮询**)
 *   场景 2:离线即不同步 —— A 写入时 C 不在线 → C 收不到;C 上线后靠水位向量对账补齐
 *   场景 3:大信封 —— 带大内容的区间数据分帧传输、客户端重组后合并
 *   场景 4:多端收敛 + 主端选举
 *   场景 5:2099 墓碑不顶高水位(引擎级,防止区间协商失效)
 *   场景 6:AI 对话随行同步,且重复收到不产生重复
 *
 * 运行:pnpm --filter @diary/server test:relay
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import {
  SyncEngine,
  type DiaryEntry,
  type SyncEnvelope,
  type SyncStore,
  type SyncTransport,
  type WatermarkVector,
} from '@diary/shared/syncEngine';
import { encryptObject, decryptObject } from '@diary/shared/syncCrypto';
import { initDb, createUser } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT ?? 8800 + Math.floor(Math.random() * 900));
const REDIS = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6399';
const BASE = `http://127.0.0.1:${PORT}`;
const SYNC_KEY = 'test-sync-key-please-ignore';

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
/** 等到条件成立(用于"实时"断言:不轮询,只等服务端把数据推过来)。 */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(40);
  }
  return cond();
}

interface Stored {
  entries: Map<string, DiaryEntry>;
  images: Map<string, string>;
  chat: Map<string, { id: string; thread: string; role: 'user' | 'assistant'; content: string; createdAt: string }>;
}

function makeStore(box: Stored): SyncStore {
  return {
    all: async () => [...box.entries.values()],
    put: async (es) => {
      for (const e of es) box.entries.set(e.id, e);
    },
    exportMedia: async (ids) => ids.filter((i) => box.images.has(i)).map((i) => ({ id: i, dataUrl: box.images.get(i)! })),
    importMedia: async (items) => {
      for (const it of items) box.images.set(it.id, it.dataUrl);
    },
    localMediaIds: async () => [...box.images.keys()],
    chatAll: async () => [...box.chat.values()],
    chatPut: async (msgs) => {
      for (const m of msgs) if (!box.chat.has(m.id)) box.chat.set(m.id, m);
    },
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
    hello: (p) => http('/api/relay/hello', { body: { from: deviceId, watermark: p.watermark, vector: p.vector, count: p.count }, token }),
    heartbeat: (p) => http('/api/relay/heartbeat', { body: { from: deviceId, watermark: p.watermark, vector: p.vector, count: p.count }, token }),
    notify: async (p) => {
      const payload = JSON.stringify(await encryptObject(SYNC_KEY, { watermark: p.watermark, vector: p.vector, count: p.count }));
      await http('/api/relay/notify', { body: { from: deviceId, watermark: p.watermark, vector: p.vector, count: p.count, payload }, token });
    },
    need: async (p) => {
      const payload = JSON.stringify(
        await encryptObject(SYNC_KEY, { origin: p.origin, fromWatermark: p.fromWatermark, toWatermark: p.toWatermark }),
      );
      await http('/api/relay/need', { body: { ...p, from: deviceId, payload }, token });
    },
    push: (p) => http('/api/relay/push', { body: { from: deviceId, to: p.to, payload: p.payload, kind: 'data' }, token }),
  };
}

class Device {
  readonly id: string;
  readonly box: Stored = { entries: new Map(), images: new Map(), chat: new Map() };
  readonly engine: SyncEngine;
  readonly syncEvents: Array<{ phase: 'start' | 'done'; merged?: number }> = [];
  /** 收到过多少个直投信封(用于断言"确实是推过来的")。 */
  received = 0;
  pushedAt = '';
  private seq = 0;
  private ws: WebSocket | null = null;
  private readonly chunkBuf = new Map<string, { total: number; parts: string[] }>();

  constructor(id: string, private readonly token: string) {
    this.id = id;
    this.engine = new SyncEngine({
      deviceId: id,
      transport: makeTransport(id, token),
      store: makeStore(this.box),
      cipher: { encrypt: (o) => encryptObject(SYNC_KEY, o), decrypt: (o) => decryptObject(SYNC_KEY, o) },
      state: { getPushedAt: () => this.pushedAt, setPushedAt: (v) => (this.pushedAt = v) },
      onSyncEvent: (e) => this.syncEvents.push(e),
    });
  }

  /** 连上中继 WebSocket —— 新架构里**这就是数据通道**(和真实客户端一样含分帧重组)。 */
  async connect(): Promise<void> {
    if (this.ws) return;
    const { ticket } = await http<{ ticket: string }>('/api/relay/ws-ticket', { body: { deviceId: this.id }, token: this.token });
    // Node 22+ 自带全局 WebSocket(和浏览器/真实客户端同一套 API)
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/relay/ws?ticket=${encodeURIComponent(ticket)}`);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      let m: { type?: string; envelope?: unknown; chunk?: { id?: string; seq?: number; total?: number; data?: string } };
      try {
        m = JSON.parse(String(ev.data)) as typeof m;
      } catch {
        return;
      }
      if (m?.type !== 'mail') return;
      if (m.envelope !== undefined) {
        this.received++;
        void this.engine.receive(m.envelope as SyncEnvelope);
        return;
      }
      const ch = m.chunk;
      if (!ch?.id || typeof ch.seq !== 'number' || typeof ch.total !== 'number' || typeof ch.data !== 'string') return;
      const buf = this.chunkBuf.get(ch.id) ?? { total: ch.total, parts: [] };
      buf.total = ch.total;
      buf.parts[ch.seq] = ch.data;
      this.chunkBuf.set(ch.id, buf);
      let got = 0;
      for (const p of buf.parts) if (typeof p === 'string') got++;
      if (got < buf.total) return;
      this.chunkBuf.delete(ch.id);
      try {
        this.received++;
        void this.engine.receive(JSON.parse(buf.parts.join('')) as SyncEnvelope);
      } catch {
        /* 丢弃 */
      }
    };
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('WS 连接失败'));
    });
  }

  /** 上线:先连数据通道,再握手对账。 */
  async login(): Promise<{ requested: number; leader: string | null }> {
    await this.connect();
    return this.engine.onLogin();
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    this.ws = null;
  }

  write(content: string, date: string, updatedAt?: string, imageId?: string): DiaryEntry {
    const at = updatedAt ?? new Date(Date.now() + this.seq++ * 1000).toISOString();
    const id = `${this.id.slice(0, 4)}-${Math.random().toString(36).slice(2, 10)}`;
    const body = imageId ? `${content}\n\n![图片](diary-img:${imageId})` : content;
    const e: DiaryEntry = { id, date, content: body, deviceId: this.id, createdAt: at, updatedAt: at, deletedAt: null };
    this.box.entries.set(id, e);
    if (imageId) this.box.images.set(imageId, `data:image/png;base64,${'A'.repeat(64)}`);
    return e;
  }

  say(id: string, thread: string, content: string, role: 'user' | 'assistant' = 'user'): void {
    this.box.chat.set(id, { id, thread, role, content, createdAt: new Date().toISOString() });
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
}

// ---------------- 启动测试服务 ----------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-relay-test-'));
let child: ChildProcess | null = null;

async function startServer(): Promise<void> {
  const tsxBin = path.resolve(serverDir, 'node_modules/.bin/tsx');
  child = spawn(tsxBin, ['src/index.ts'], {
    cwd: serverDir,
    detached: true,
    env: { ...process.env, PORT: String(PORT), REDIS_URL: REDIS, DIARY_DATA_DIR: dataDir, CLOUD_MODE: '1', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b: Buffer) => {
    const s = b.toString().trim();
    if (s && /error|Error|失败|listening|relay/i.test(s)) console.log('   [server]', s.slice(0, 240));
  });
  child.stderr?.on('data', (b: Buffer) => console.error('   [server:err]', b.toString().trim().slice(0, 200)));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('测试服务启动超时');
}

function stopServer(): void {
  if (!child?.pid) return;
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  }
  child = null;
}

async function flushTestRedis(): Promise<void> {
  const r = new Redis(REDIS, { maxRetriesPerRequest: 2, connectTimeout: 3000, lazyConnect: false });
  try {
    await r.flushdb();
  } finally {
    r.disconnect();
  }
}

async function main(): Promise<void> {
  console.log(`\n启动测试服务: port=${PORT} redis=${REDIS} data=${dataDir}`);
  await flushTestRedis();
  initDb(path.join(dataDir, 'diary.db'));

  let userSeq = 0;
  const pass1 = 'test1234';
  const user = `relaytest_${Date.now()}_${userSeq++}`;
  if (!createUser(user, pass1, `${user}@example.com`)) throw new Error('创建测试账号失败');
  await startServer();
  console.log('测试服务已就绪 ✅');

  /** 建一个独立账号(避免不同场景的端互相干扰)。 */
  async function freshToken(): Promise<string> {
    const u = `relaytest_${Date.now()}_${userSeq++}`;
    if (!createUser(u, pass1, `${u}@example.com`)) throw new Error('建号失败');
    const r = await http<{ token: string }>('/api/auth/login', { body: { username: u, password: pass1 } });
    return r.token;
  }

  const today = new Date().toISOString().slice(0, 10);
  const devices: Device[] = [];

  // ============ 场景 1:在线即实时(不轮询) ============
  console.log('\n[场景 1] A 写入 → 直投 B → B 索取 → A 补推 → B 秒级合并(全程无轮询)');
  {
    const token = await freshToken();
    const A = new Device('devA-direct-0001', token);
    const B = new Device('devB-direct-0002', token);
    devices.push(A, B);
    await A.login();
    await B.login();
    const e1 = A.write('场景1:A 写的第一条', today);
    await A.engine.onLocalWrite();
    ok(await waitFor(() => B.has(e1.id)), 'B 在几秒内收到并合并了 A 新写的条目(直投)');
    ok(B.received > 0, `B 确实是通过 WS 收到信封的(收到 ${B.received} 封)`);
  }

  // ============ 场景 2:离线即不同步,上线后对账补齐 ============
  console.log('\n[场景 2] A 写入时 C 不在线 → 收不到(服务端零存储);C 上线后靠对账补齐');
  {
    const token = await freshToken();
    const A = new Device('devA-offline-0001', token);
    const C = new Device('devC-offline-0002', token);
    devices.push(A, C);
    await A.login();
    // C 此时**没有**连上:它收不到任何东西,服务端也不替它存
    const e2 = A.write('场景2:A 在 C 离线时写的', today);
    await A.engine.onLocalWrite();
    await sleep(600);
    ok(!C.has(e2.id), 'C 离线期间确实没收到(服务端零存储,不替离线端攒数据)');
    // C 上线 → hello 拿到 A 的水位 → 反向索取 → A 直投补齐
    const r = await C.login();
    ok(r.requested > 0, `C 上线后发起了 ${r.requested} 次区间索取`);
    ok(await waitFor(() => C.has(e2.id)), 'C 上线后靠水位向量对账补齐了离线期间的数据');
  }

  // ============ 场景 3:大信封分帧 + 重组 ============
  console.log('\n[场景 3] 大内容(远超单帧上限)→ 服务端分帧、客户端重组后合并');
  {
    const token = await freshToken();
    const A = new Device('devA-big-0001', token);
    const B = new Device('devB-big-0002', token);
    devices.push(A, B);
    await A.login();
    await B.login();
    const big = '大正文'.repeat(90_000) + '—结尾标记'; // ~27 万中文字符,加密后必然超过单帧上限
    const e3 = A.write(big, today);
    await A.engine.onLocalWrite();
    ok(await waitFor(() => B.has(e3.id), 8000), 'B 收到了超大条目(分帧→重组成功)');
    const got = B.box.entries.get(e3.id)?.content ?? '';
    ok(got.length === big.length && got.endsWith('—结尾标记'), `大内容完整无损(${got.length} 字符,与原内容一致)`);
  }

  // ============ 场景 4:多端收敛 + 主端选举 ============
  console.log('\n[场景 4] D/E/F 各持不同数据同时上线 → 交换水位、选举主端 → 全部收敛');
  {
    const token = await freshToken();
    const D = new Device('devD-multi-0001', token);
    const E = new Device('devE-multi-0002', token);
    const F = new Device('devF-multi-0003', token);
    devices.push(D, E, F);
    const d1 = D.write('场景4:D 的数据', today, '2026-01-01T00:00:01.000Z');
    const e1 = E.write('场景4:E 的数据', today, '2026-01-01T00:00:02.000Z');
    const f1 = F.write('场景4:F 的数据', today, '2026-01-01T00:00:03.000Z');
    await Promise.all([D.login(), E.login(), F.login()]);
    const devs = await http<{ leader: string | null }>('/api/relay/devices', { token });
    ok(devs.leader === F.id, `主端 = 水位最新的 F(实际 ${String(devs.leader).slice(0, 10)})`);
    const all = [d1.id, e1.id, f1.id].sort();
    const same = (x: Device): boolean => JSON.stringify(x.ids()) === JSON.stringify(all);
    ok(await waitFor(() => same(D) && same(E) && same(F), 8000), '三端收敛到同一份数据(3 条)');
  }

  // ============ 场景 5:2099 墓碑不顶高水位 ============
  console.log('\n[场景 5] 库里存在 2099 墓碑 → 不得顶高水位、不得让区间协商失效');
  {
    const token = await freshToken();
    const J = new Device('devJ-2099-0001', token);
    const K = new Device('devK-2099-0002', token);
    devices.push(J, K);
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
    ok(jw < '2099-01-01T00:00:00.000Z', `2099 墓碑未顶高水位(实际 ${jw || '(空)'})`);
    const j2 = J.write('场景5:正常时间的新条目', today);
    await J.login();
    await K.login();
    await J.engine.onLocalWrite();
    ok(await waitFor(() => K.has(j2.id)), 'K 拿到了正常时间的新条目(水位未被 2099 顶死)');
  }

  // ============ 场景 6:AI 对话随行同步 + 幂等 ============
  console.log('\n[场景 6] AI 对话走同一条加密直投链路,重复收到不产生重复');
  {
    const token = await freshToken();
    const C1 = new Device('devC1-chat-0001', token);
    const C2 = new Device('devC2-chat-0002', token);
    devices.push(C1, C2);
    await C1.login();
    await C2.login();
    C1.say('chat-q1', 'mentor', '我最近睡不好');
    C1.say('chat-a1', 'mentor', '我们一件件来看。', 'assistant');
    await C1.engine.onLocalWrite();
    ok(await waitFor(() => C2.box.chat.has('chat-q1') && C2.box.chat.has('chat-a1')), 'C2 收到了两端对话(用户+AI)');
    const before = C2.box.chat.size;
    await C1.engine.onLocalWrite(); // 再带一次
    await sleep(800);
    ok(C2.box.chat.size === before, `重复携带不产生重复(${before} → ${C2.box.chat.size})`);
  }

  devices.forEach((d) => d.close());
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
