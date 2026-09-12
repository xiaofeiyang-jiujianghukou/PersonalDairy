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
      const wm = d.watermark ?? '';
      // 中继/服务端一律存 UTC(结尾 Z);这里额外换算成本机时间,方便和手机/电脑上看到的时间对照
      const local = wm ? new Date(wm).toLocaleString('zh-CN', { hour12: false }) : '(空)';
      console.log(
        `     设备 ${d.deviceId.slice(0, 8)}… 水位=${wm.slice(0, 19) || '(空)'} (本地 ${local}) 条目=${d.count ?? 0} ${d.online ? '在线' : '离线'}`,
      );
    }
  }

  // 注意:自检探针**没有数据**,必须上报空水位/0 条 —— 否则会污染设备注册表,
  // 甚至因为"水位最新"被选举成主端,让其它端向一个空设备索取数据。
  const notify = await req<{ ok?: boolean }>('/api/relay/notify', {
    body: { from: dev, watermark: '', vector: {}, count: 0, payload: JSON.stringify({ plain: { watermark: '', count: 0 } }) },
    token,
  });
  ok(notify.status === 200, '通知 /api/relay/notify', `HTTP ${notify.status}`);

  const need = await req<{ ok?: boolean }>('/api/relay/need', {
    body: { from: dev, to: dev, origin: dev, fromWatermark: '', toWatermark: '' },
    token,
  });
  ok(need.status === 200, '定向索取 /api/relay/need', `HTTP ${need.status}`);

  const devices = await req<{ devices?: unknown[] }>('/api/relay/devices', { token });
  ok(devices.status === 200, '设备表 /api/relay/devices', `HTTP ${devices.status}`);

  // ---------- WebSocket 唤醒通道(最容易漏配 nginx Upgrade) ----------
  const t = await req<{ ticket?: string }>('/api/relay/ws-ticket', { body: { deviceId: dev }, token });
  ok(t.status === 200 && Boolean(t.data?.ticket), '换取 WS 一次性票据', `HTTP ${t.status}`);
  if (t.data?.ticket) {
    const wsUrl = `${BASE.replace(/^http/i, 'ws')}/api/relay/ws?ticket=${encodeURIComponent(t.data.ticket)}`;
    const result = await new Promise<{ ok: boolean; note: string }>((resolve) => {
      let done = false;
      const finish = (ok: boolean, note: string): void => {
        if (done) return;
        done = true;
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
        resolve({ ok, note });
      };
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => finish(false, '10 秒内未收到 ready(可能被 nginx/代理拦截)'), 10000);
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String((ev as MessageEvent).data)) as { type?: string };
          if (m.type === 'ready') {
            clearTimeout(timer);
            finish(true, '已连接并收到 ready');
          }
        } catch {
          /* 忽略 */
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        finish(false, '握手失败(检查 nginx 的 Upgrade / proxy_read_timeout 配置)');
      };
      ws.onclose = () => {
        clearTimeout(timer);
        finish(false, '连接被关闭');
      };
    });
    ok(result.ok, 'WebSocket 唤醒通道可用', result.note);
    if (!result.ok) {
      console.log('     → 未配 nginx 也能用(客户端会自动回落到长轮询),但建议按 docs/sync-protocol.md §5.4 配置');
    }
  }

  console.log(`\n结果: 通过 ${pass} 项,失败 ${fail} 项\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n自检异常:', (e as Error).message);
  process.exit(1);
});
