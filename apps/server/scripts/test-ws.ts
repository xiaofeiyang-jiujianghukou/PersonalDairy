/**
 * WebSocket 唤醒通道自测:起一个本地服务(独立 Redis + 临时数据目录),
 * 覆盖票据鉴权、唤醒投递、定向投递、以及"不叫醒自己"。
 *
 * 运行:pnpm --filter @diary/server test:ws
 * (Node 22+ 自带全局 WebSocket,无需额外依赖)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { initDb, createUser } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_WS_PORT ?? 9800 + Math.floor(Math.random() * 150));
const REDIS = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6399';
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function req<T>(p: string, o: { method?: string; body?: unknown; token?: string } = {}): Promise<{
  status: number;
  data: T;
}> {
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
  return { status: res.status, data: data as T };
}

/** 用票据建立连接,返回收到的事件与关闭码。 */
function openSocket(ticket: string): {
  msgs: Array<{ type?: string; from?: string }>;
  closed: Promise<number>;
  ws: WebSocket;
} {
  const ws = new WebSocket(`${WS_BASE}/api/relay/ws?ticket=${encodeURIComponent(ticket)}`);
  const msgs: Array<{ type?: string; from?: string }> = [];
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (e) => resolve((e as CloseEvent).code ?? 0);
  });
  ws.onmessage = (e) => {
    try {
      msgs.push(JSON.parse(String((e as MessageEvent).data)));
    } catch {
      /* 忽略 */
    }
  };
  ws.onerror = () => {
    /* 关闭码由 onclose 给出 */
  };
  return { msgs, closed, ws };
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-ws-test-'));
let child: ChildProcess | null = null;

async function startServer(): Promise<void> {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) throw new Error(`端口 ${PORT} 已被占用`);
  } catch (e) {
    if ((e as Error).message.includes('已被占用')) throw e;
  }
  const tsxBin = path.resolve(serverDir, 'node_modules/.bin/tsx');
  child = spawn(tsxBin, ['src/index.ts'], {
    cwd: serverDir,
    detached: true,
    env: { ...process.env, PORT: String(PORT), REDIS_URL: REDIS, DIARY_DATA_DIR: dataDir, CLOUD_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b: Buffer) => {
    const s = b.toString();
    if (/error|Error|失败/.test(s)) console.error('   [server]', s.trim().slice(0, 200));
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
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  }
  child = null;
}

async function main(): Promise<void> {
  console.log(`\nWS 自测: port=${PORT} redis=${REDIS}`);
  const r = new Redis(REDIS, { maxRetriesPerRequest: 2, connectTimeout: 3000 });
  await r.flushdb();
  r.disconnect();
  console.log('测试 Redis 已清空');

  initDb(path.join(dataDir, 'diary.db'));
  const user = `wstest_${Date.now()}`;
  if (!createUser(user, 'test1234', `${user}@example.com`)) throw new Error('建号失败');
  await startServer();
  console.log('测试服务已就绪 ✅\n');

  const login = await req<{ token?: string }>('/api/auth/login', { body: { username: user, password: 'test1234' } });
  const token = login.data.token ?? '';
  ok(Boolean(token), '账号登录');

  // ---------- 票据 ----------
  const noAuth = await req('/api/relay/ws-ticket', { body: { deviceId: 'd1' } });
  ok(noAuth.status === 401, '未带 token 取票据被拒(401)', `HTTP ${noAuth.status}`);
  const t1 = await req<{ ticket?: string; expiresIn?: number }>('/api/relay/ws-ticket', {
    body: { deviceId: 'dev-WS-A' },
    token,
  });
  ok(t1.status === 200 && Boolean(t1.data.ticket), 'Bearer 换取一次性票据', `过期 ${t1.data.expiresIn}s`);

  // ---------- 建连 ----------
  const A = openSocket(String(t1.data.ticket));
  await sleep(700);
  ok(A.msgs.some((m) => m.type === 'ready'), '凭有效票据建立连接并收到 ready');
  ok(A.ws.readyState === WebSocket.OPEN, '连接处于 OPEN 状态');

  // 票据一次性
  const reuse = openSocket(String(t1.data.ticket));
  const reuseCode = await reuse.closed;
  ok(reuseCode === 4401, '同一票据二次使用被拒(4401)', `close=${reuseCode}`);

  // 伪造票据
  const fake = openSocket('not-a-real-ticket');
  const fakeCode = await fake.closed;
  ok(fakeCode === 4401, '伪造票据被拒(4401)', `close=${fakeCode}`);

  // ---------- 唤醒投递 ----------
  const tb = await req<{ ticket?: string }>('/api/relay/ws-ticket', { body: { deviceId: 'dev-WS-B' }, token });
  const tc = await req<{ ticket?: string }>('/api/relay/ws-ticket', { body: { deviceId: 'dev-WS-C' }, token });
  const B = openSocket(String(tb.data.ticket));
  const C = openSocket(String(tc.data.ticket));
  await sleep(700);
  ok(B.msgs.some((m) => m.type === 'ready') && C.msgs.some((m) => m.type === 'ready'), 'B / C 均已连接');

  // 连接即在线的验证(设备表)
  const devs = await req<{ devices: Array<{ deviceId: string; online?: boolean }> }>('/api/relay/devices', { token });
  const onlineIds = devs.data.devices.filter((d) => d.online).map((d) => d.deviceId);
  ok(onlineIds.includes('dev-WS-A') && onlineIds.includes('dev-WS-B'), '连接建立即被视为在线', onlineIds.join(','));

  // A 推一条广播 → B、C 都应被唤醒
  const bBefore = B.msgs.length;
  const cBefore = C.msgs.length;
  await req('/api/relay/push', { body: { from: 'dev-WS-A', payload: 'x', kind: 'data' }, token });
  await sleep(600);
  ok(B.msgs.length > bBefore && B.msgs.at(-1)?.type === 'wake', 'B 收到唤醒');
  ok(C.msgs.length > cBefore && C.msgs.at(-1)?.type === 'wake', 'C 收到唤醒');

  // 定向:A 定向发给 B → B 收到,C 不应收到
  const cBefore2 = C.msgs.length;
  const bBefore2 = B.msgs.length;
  await req('/api/relay/push', { body: { from: 'dev-WS-A', to: 'dev-WS-B', payload: 'y', kind: 'data' }, token });
  await sleep(600);
  ok(B.msgs.length > bBefore2, '定向唤醒送达目标端 B');
  ok(C.msgs.length === cBefore2, '定向唤醒未误投给 C');

  // 不叫醒自己:A 自己推 → A 不应收到 wake
  const aBefore = A.msgs.length;
  await req('/api/relay/push', { body: { from: 'dev-WS-A', payload: 'z', kind: 'data' }, token });
  await sleep(600);
  ok(A.msgs.length === aBefore, '发送方自己不会被唤醒');

  // ---------- 断线后长轮询兜底 ----------
  B.ws.close();
  await sleep(300);
  const before = await req<{ messages: unknown[] }>(
    `/api/relay/pull?from=dev-WS-B&after=0&limit=50`,
    { token },
  );
  ok((before.data.messages ?? []).length > 0, 'WS 断开后,长轮询仍能拉到消息(兜底通道有效)');

  A.ws.close();
  C.ws.close();
  await sleep(200);
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
