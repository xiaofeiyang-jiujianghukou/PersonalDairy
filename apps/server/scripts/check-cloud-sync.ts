/**
 * 云端协议自检:确认部署好的服务端已经支持新的同步协议(握手 / 通知 / 定向索取)。
 *
 * 用法:
 *   DIARY_USER=账号 DIARY_PASS=密码 pnpm --filter @diary/server check:cloud
 *   可选 CHECK_BASE=https://bluesheep.vip
 */
const BASE = (process.env.CHECK_BASE ?? 'https://bluesheep.vip').replace(/\/+$/, '');
const USER = process.env.DIARY_USER ?? '';
const PASS = process.env.DIARY_PASS ?? '';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function req<T>(p: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<{
  status: number;
  data: T;
}> {
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
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

async function main(): Promise<void> {
  console.log(`\n云端协议自检: ${BASE}`);
  const health = await req<{ ok?: boolean }>('/api/health');
  ok(health.status === 200, '服务健康检查', `HTTP ${health.status}`);
  if (!USER || !PASS) {
    console.log('\n(未提供 DIARY_USER / DIARY_PASS,跳过需要登录的检查)');
    console.log(`\n结果: 通过 ${pass} 项,失败 ${fail} 项\n`);
    process.exit(fail === 0 ? 0 : 1);
  }

  const login = await req<{ token?: string }>('/api/auth/login', { body: { username: USER, password: PASS } });
  ok(login.status === 200 && Boolean(login.data?.token), '账号登录', `HTTP ${login.status}`);
  const token = login.data?.token ?? '';
  if (!token) {
    console.log(`\n结果: 通过 ${pass} 项,失败 ${fail} 项\n`);
    process.exit(1);
  }

  // 固定探针名:避免每次自检都往设备注册表里塞一台新设备(注册表 90 天过期)
  const dev = 'probe-check-tool';
  const hello = await req<{ leader?: string | null; devices?: Array<{ deviceId: string; watermark?: string; online?: boolean }> }>(
    '/api/relay/hello',
    { body: { from: dev, watermark: '', vector: {} }, token },
  );
  ok(hello.status === 200, '握手 /api/relay/hello', `HTTP ${hello.status}`);
  if (hello.status !== 200) {
    console.log('     → 服务端还是旧版本:请在云服务器执行 git pull 后 pm2 restart 再试');
  } else {
    const devices = hello.data?.devices ?? [];
    ok(devices.length > 0, `握手返回设备表(${devices.length} 台)`);
    ok(
      typeof hello.data?.leader === 'string' && hello.data.leader.length > 0,
      '主端选举返回结果',
      `leader=${String(hello.data?.leader).slice(0, 8)}…`,
    );
    for (const d of devices.filter((x) => x.deviceId !== dev)) {
      console.log(`     设备 ${d.deviceId.slice(0, 8)}… 水位=${(d.watermark ?? '').slice(0, 19) || '(空)'} ${d.online ? '在线' : '离线'}`);
    }
  }

  const notify = await req<{ ok?: boolean }>('/api/relay/notify', {
    body: { from: dev, watermark: new Date().toISOString(), vector: {}, payload: JSON.stringify({ plain: { watermark: new Date().toISOString() } }) },
    token,
  });
  ok(notify.status === 200, '通知 /api/relay/notify', `HTTP ${notify.status}`);

  const need = await req<{ ok?: boolean }>('/api/relay/need', {
    body: { from: dev, to: dev, origin: dev, fromWatermark: '', toWatermark: new Date().toISOString() },
    token,
  });
  ok(need.status === 200, '定向索取 /api/relay/need', `HTTP ${need.status}`);

  const devices = await req<{ devices?: unknown[] }>('/api/relay/devices', { token });
  ok(devices.status === 200, '设备表 /api/relay/devices', `HTTP ${devices.status}`);

  console.log(`\n结果: 通过 ${pass} 项,失败 ${fail} 项\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n自检异常:', (e as Error).message);
  process.exit(1);
});
