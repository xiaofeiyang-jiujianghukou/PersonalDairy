import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import QRCode from 'qrcode';
import {
  DATE_RE,
  MONTH_RE,
  type Entry,
  type EntryCreateInput,
  type EntryUpdateInput,
} from '@diary/shared';

import { loadConfig } from './config.js';
import {
  initDb,
  listEntriesByDate,
  listEntriesByMonth,
  listAllEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  searchEntries,
  entriesHash,
  getSummary,
  upsertSummary,
  getAllEntriesForSync,
  applySyncedEntries,
  createUser,
  createUserWithHash,
  findUserByUsername,
  findUserByEmail,
  hashPassword,
  verifyPassword,
  changePassword,
  setUserEmail,
  unbindEmail,
  updateProfile,
  changeUsername,
  getUserById,
  createSession,
  getUserByToken,
  deleteSession,
  deleteSessionsForUser,
} from './db.js';
import {
  initRelayRedis,
  relayHasNew,
  relayPull,
  relayPush,
  relayReportCursor,
  deviceRegister,
  deviceTouch,
  deviceList,
  deviceSeen,
  pickLeader,
  mboxPush,
  mboxPushToOthers,
  mboxDrain,
  mboxLen,
  type DeviceInfo,
  type RelayKind,
} from './relayRedis.js';
import { getTextProvider, getVisionProvider } from './ai/index.js';
import { summarizeMonth } from './ai/summary.js';
import { chatWithDiary, type CompanionMessage } from './ai/companion.js';
import { sendCodeEmail } from './mail.js';
import {
  entriesContainImages,
  imageIdFromDataUrl,
  decodeImageDataUrl,
  decodeMediaDataUrl,
  saveImage,
  readImage,
  listImageIds,
  normalizeLegacyImageRefs,
} from './images.js';
import { detectImageMime, detectMediaMime } from '@diary/shared/images';
import { decryptObject, encryptObject, generateSyncKey } from '@diary/shared/syncCrypto';

const config = loadConfig();
initDb(config.dbPath);
initRelayRedis(config.redisUrl);

const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024 }); // 64MB,容纳含图片的同步负载

// 容错:空的 application/json body 视为 {}。
// 否则 Fastify 会对"无 body 但带 JSON Content-Type"的请求返回 400
// (FST_ERR_CTP_EMPTY_JSON_BODY)——生成登录码/退出登录等无 body 的 POST 都会踩。
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const s = String(body ?? '').trim();
  if (!s) return done(null, {});
  try {
    done(null, JSON.parse(s));
  } catch (e) {
    done(e as Error, undefined);
  }
});

// 允许本机 / 局域网前端访问(本地优先应用,不做鉴权,数据只在你自己的机器上)。
await app.register(cors, { origin: true });
// WebSocket 通道(即时唤醒)。业务数据仍走 HTTP 的 need/serve/pull,WS 只推"有新消息"。
await app.register(websocket);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- 健康检查 ----------
app.get('/api/health', async () => ({
  ok: true,
  aiConfigured: config.ai.apiKey !== '' && config.ai.provider !== 'null',
  textModel: config.ai.textModel,
  visionModel: config.ai.visionModel,
  dataDir: config.dataDir,
}));

// ---------- 账号鉴权 ----------
// 本期:用户名 + 密码(手机号短信/微信 OAuth 预留字段与接口,暂不实现)
interface AuthedRequest {
  user?: { id: number; username: string };
}
const requireAuth = async (req: unknown, reply: { code: (n: number) => { send: (o: unknown) => unknown } }) => {
  const r = req as AuthedRequest & { headers: Record<string, string | string[] | undefined> };
  const auth = r.headers.authorization;
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const user = token ? getUserByToken(token) : null;
  if (!user) {
    return reply.code(401).send({ error: '未登录或会话已过期' });
  }
  r.user = { id: user.id, username: user.username };
};

// 注册(第一步):校验 + 发邮箱验证码,验证通过后才建账号
interface PendingReg {
  email: string;
  passwordHash: string;
  codeHash: string;
  expires: number;
  attempts: number;
}
const pendingRegs = new Map<string, PendingReg>();

app.post('/api/auth/register', async (req, reply) => {
  const { username, password, email } = (req.body ?? {}) as { username?: string; password?: string; email?: string };
  if (typeof username !== 'string' || username.trim().length < 2) return reply.code(400).send({ error: '用户名至少 2 个字符' });
  if (typeof password !== 'string' || password.length < 6) return reply.code(400).send({ error: '密码至少 6 位' });
  const mail = typeof email === 'string' ? email.trim() : '';
  if (!mail || !EMAIL_RE.test(mail)) return reply.code(400).send({ error: '请填写有效邮箱' });
  const uname = username.trim();
  if (findUserByUsername(uname)) return reply.code(409).send({ error: '用户名已存在' });
  if (findUserByEmail(mail)) return reply.code(409).send({ error: '该邮箱已被使用' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  pendingRegs.set(uname, {
    email: mail,
    passwordHash: hashPassword(password),
    codeHash: sha(code),
    expires: Date.now() + CODE_TTL,
    attempts: 0,
  });
  const r = await sendCodeEmail(mail, code, uname, 'register');
  if (!r.ok) {
    pendingRegs.delete(uname);
    return reply.code(500).send({ error: `验证码邮件发送失败:${r.note}` });
  }
  return { ok: true };
});

// 注册(第二步):验证邮箱验证码 → 建账号 + 登录
app.post('/api/auth/register-confirm', async (req, reply) => {
  const body = (req.body ?? {}) as { username?: string; code?: string };
  const uname = (body.username ?? '').trim();
  const code = (body.code ?? '').trim();
  const pr = pendingRegs.get(uname);
  if (!pr || pr.expires < Date.now()) return reply.code(400).send({ error: '验证码已过期,请重新获取' });
  if (pr.attempts >= 5) {
    pendingRegs.delete(uname);
    return reply.code(400).send({ error: '尝试次数过多,请重新获取' });
  }
  pr.attempts++;
  if (pr.codeHash !== sha(code)) return reply.code(400).send({ error: '验证码错误' });
  if (findUserByUsername(uname)) {
    pendingRegs.delete(uname);
    return reply.code(409).send({ error: '用户名已存在' });
  }
  const user = createUserWithHash(uname, pr.passwordHash, pr.email);
  pendingRegs.delete(uname);
  if (!user) return reply.code(409).send({ error: '用户名已存在' });
  const token = createSession(user.id);
  return reply.code(201).send({ token, username: user.username });
});

app.post('/api/auth/login', async (req, reply) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (typeof username !== 'string' || typeof password !== 'string') return reply.code(400).send({ error: '缺少用户名或密码' });
  const user = findUserByUsername(username.trim());
  if (!user || !verifyPassword(password, user.passwordHash)) return reply.code(401).send({ error: '用户名或密码错误' });
  const token = createSession(user.id);
  return { token, username: user.username };
});

app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
  const u = (req as AuthedRequest).user!;
  const p = getUserById(u.id);
  if (!p) return { username: u.username };
  return { uid: p.uid, username: p.username, nickname: p.nickname, avatar: p.avatar, email: p.email };
});

app.post('/api/auth/update-profile', { preHandler: requireAuth }, async (req, reply) => {
  const u = (req as AuthedRequest).user!;
  const body = (req.body ?? {}) as { nickname?: string; avatar?: string; username?: string };
  const p = getUserById(u.id);
  // 改账号(半年冷却)
  const uname = typeof body.username === 'string' ? body.username.trim() : undefined;
  if (typeof uname === 'string' && uname !== p?.username) {
    if (uname.length < 2) return reply.code(400).send({ error: '账号至少 2 个字符' });
    if (findUserByUsername(uname)) return reply.code(409).send({ error: '账号已存在' });
    if (!changeUsername(u.id, p?.usernameChangedAt ?? null, uname)) {
      return reply.code(400).send({ error: '账号每半年只能修改一次' });
    }
  }
  const nickname = typeof body.nickname === 'string' ? body.nickname : undefined;
  const avatar = body.avatar === undefined ? undefined : body.avatar || null; // ''/null = 清空头像
  updateProfile(u.id, { nickname, avatar });
  return { ok: true };
});

app.post('/api/auth/unbind-email', { preHandler: requireAuth }, async (req, reply) => {
  const u = (req as AuthedRequest).user!;
  return unbindEmail(u.id) ? { ok: true } : reply.code(400).send({ error: '操作失败' });
});

app.post('/api/auth/logout', { preHandler: requireAuth }, async (req) => {
  const r = req as AuthedRequest & { headers: Record<string, string | string[] | undefined> };
  const token = typeof r.headers.authorization === 'string' ? r.headers.authorization.slice(7).trim() : '';
  if (token) deleteSession(token);
  return { ok: true };
});

app.post('/api/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
  const u = (req as AuthedRequest).user!;
  const body = (req.body ?? {}) as { oldPassword?: string; newPassword?: string };
  const oldPw = typeof body.oldPassword === 'string' ? body.oldPassword : '';
  const newPw = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!newPw || newPw.length < 6) return reply.code(400).send({ error: '新密码至少 6 位' });
  const user = findUserByUsername(u.username);
  if (!user || !verifyPassword(oldPw, user.passwordHash)) {
    return reply.code(400).send({ error: '当前密码错误' });
  }
  return changePassword(u.id, newPw) ? { ok: true } : reply.code(500).send({ error: '修改失败' });
});

// ---------- 忘记密码:绑定邮箱 → 邮件验证码 → 重置 ----------
const CODE_TTL = 15 * 60 * 1000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
interface PendingReset {
  codeHash: string;
  expires: number;
  attempts: number;
}
const pendingResets = new Map<string, PendingReset>();

// 绑定邮箱(找回密码需先绑一个邮箱)
app.post('/api/auth/bind-email', { preHandler: requireAuth }, async (req, reply) => {
  const u = (req as AuthedRequest).user!;
  const email = (req.body as { email?: string } | null)?.email?.trim() ?? '';
  if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: '邮箱格式不正确' });
  return setUserEmail(u.id, email) ? { ok: true } : reply.code(500).send({ error: '绑定失败' });
});

// 申请找回:给已绑定邮箱发 6 位验证码(不暴露账号是否存在)
app.post('/api/auth/forgot', async (req, reply) => {
  const username = ((req.body as { username?: string } | null)?.username ?? '').trim();
  if (!username) return reply.code(400).send({ error: '请输入用户名' });
  const user = findUserByUsername(username);
  if (user && user.email) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    pendingResets.set(username, { codeHash: sha(code), expires: Date.now() + CODE_TTL, attempts: 0 });
    const r = await sendCodeEmail(user.email, code, username, 'reset');
    if (!r.ok) return reply.code(500).send({ error: `验证码邮件发送失败:${r.note}` });
  }
  return { ok: true };
});

// 用验证码重置密码
app.post('/api/auth/reset', async (req, reply) => {
  const body = (req.body ?? {}) as { username?: string; code?: string; newPassword?: string };
  const username = (body.username ?? '').trim();
  const code = (body.code ?? '').trim();
  const newPw = body.newPassword ?? '';
  if (!newPw || newPw.length < 6) return reply.code(400).send({ error: '新密码至少 6 位' });
  const pr = pendingResets.get(username);
  if (!pr || pr.expires < Date.now()) return reply.code(400).send({ error: '验证码已过期,请重新获取' });
  if (pr.attempts >= 5) {
    pendingResets.delete(username);
    return reply.code(400).send({ error: '尝试次数过多,请重新获取' });
  }
  pr.attempts++;
  if (pr.codeHash !== sha(code)) return reply.code(400).send({ error: '验证码错误' });
  const user = findUserByUsername(username);
  if (!user) return reply.code(400).send({ error: '用户不存在' });
  changePassword(user.id, newPw);
  deleteSessionsForUser(user.id); // 强制重新登录
  pendingResets.delete(username);
  return { ok: true };
});

// ---------- 微信式扫码登录(电脑 QR → 手机确认 → 新设备拿 token) ----------
interface PendingLogin {
  confirmed: boolean;
  token: string;
  username: string;
  createdAt: number;
  /** 手机确认时随扫码带过来的"同步密钥密文"(用一次性 qrId 派生密钥加密;服务端只透传,解不开) */
  encSyncKey?: string;
}
const pendingLogins = new Map<string, PendingLogin>();

// 1) 新设备(电脑)申请一个临时登录码(二维码内容 diary-login:<qrId>)
app.post('/api/auth/login-qr', async (_req, reply) => {
  const qrId = randomUUID();
  pendingLogins.set(qrId, { confirmed: false, token: '', username: '', createdAt: Date.now() });
  const dataUrl = await QRCode.toDataURL(`diary-login:${qrId}`, { margin: 1, width: 360 });
  return reply.code(201).send({ qrId, dataUrl });
});

// 2) 新设备轮询:确认后拿 token
app.get('/api/auth/login-qr/:qrId', async (req, reply) => {
  const qrId = (req.params as { qrId: string }).qrId;
  const p = pendingLogins.get(qrId);
  if (!p) return reply.code(404).send({ error: '登录码不存在或已过期' });
  if (!p.confirmed) return { status: 'pending' };
  // 一次性:taken 后删除
  pendingLogins.delete(qrId);
  return { status: 'confirmed', token: p.token, username: p.username, encSyncKey: p.encSyncKey ?? '' };
});

// 3) 手机(已登录)确认这台设备
app.post('/api/auth/scan-confirm', { preHandler: requireAuth }, async (req, reply) => {
  const qrId = (req.body as { qrId?: string } | null)?.qrId;
  const encSyncKey = (req.body as { encSyncKey?: string } | null)?.encSyncKey;
  const user = (req as AuthedRequest).user!;
  if (typeof qrId !== 'string') return reply.code(400).send({ error: '缺少登录码' });
  const p = pendingLogins.get(qrId);
  if (!p) return reply.code(404).send({ error: '登录码不存在或已过期' });
  const token = createSession(user.id, 30 * 24 * 3600 * 1000);
  p.confirmed = true;
  p.token = token;
  p.username = user.username;
  // 手机把"同步密钥"用一次性 qrId 加密后带过来 → 电脑端解密即可立即同步(服务端只见密文)
  if (typeof encSyncKey === 'string' && encSyncKey) p.encSyncKey = encSyncKey;
  return { ok: true };
});

// ---------- P2:跨网络密文中继(Redis Stream 消息中间件,按游标分发;只存加密载荷) ----------
const RELAY_WAIT_MS = 20 * 1000;

// 实时唤醒:内存等待表。数据的"有序日志/游标/全消费删除"都在 Redis Stream;
// 这里只负责"本进程内"快速唤醒等待中的在线设备(单实例部署,不占阻塞连接)。
interface RelayWaiter {
  userId: number;
  from: string;
  after: number;
  finish: (hasNew: boolean) => void;
}
const relayWaiters = new Map<number, Set<RelayWaiter>>();

function wakeRelayWaiters(userId: number, fromDevice: string, toDevice = ''): void {
  wakeSockets(userId, fromDevice, toDevice); // WebSocket 主通道(即时)
  const set = relayWaiters.get(userId);
  if (!set) return;
  for (const w of Array.from(set)) {
    // 新消息来自别人 → 能立刻拉到,唤醒;来自自己则不动(避免自我唤醒的空拉)
    if (fromDevice === w.from) continue;
    if (toDevice && toDevice !== w.from) continue; // 定向消息只唤醒目标端
    w.finish(true);
  }
}

// ---------- WebSocket 即时唤醒通道 ----------
// 设计要点:
//   · 浏览器/WebView 的 WebSocket 不能带 Authorization 头 → 先用 Bearer 换"一次性短时票据",
//     再以 ?ticket= 建立连接(票据 60 秒过期、用后即焚、绑定账号与设备),避免 token 出现在 URL/日志里。
//   · 在线状态:连接建立即视为在线,之后每个 pong 都会刷新(30 秒一次),比靠上报更准。
//   · 存活检测:服务端每 30 秒 ping,一个周期内没收到 pong 就判定半开连接并断开
//     (手机切网/NAT 超时后 TCP 可能"看起来还在")。
interface WsTicket {
  uid: number;
  deviceId: string;
  expires: number;
}
const WS_TICKET_TTL_MS = 60 * 1000;
const wsTickets = new Map<string, WsTicket>();
/** 只用到的最小连接接口(避免为类型再引入 @types/ws) */
interface WsLike {
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}
/** 账号 → 设备 → 连接 */
const wsClients = new Map<number, Map<string, WsLike>>();
const WS_PING_MS = 30 * 1000;
/**
 * 应用层心跳超时:客户端每 30 秒发一条 {"type":"ping"}。
 * 为什么要应用层心跳:Android/iOS 冻结后台 App 的 JS 后,WebSocket 的 pong 仍由
 * **网络协议栈**自动回复 —— 于是"TCP 还连着"会被误判成"在线",而它其实什么都不处理。
 * 因此在线/存活必须以"JS 真的在发消息"为准:超过该时长没有应用层心跳就断开连接
 * (客户端恢复后会 onclose → 重连 → 立即对账,数据不会丢)。
 */
const WS_APP_PING_TIMEOUT_MS = Number(process.env.WS_APP_PING_TIMEOUT_MS ?? 40 * 1000);

function wakeSockets(uid: number, fromDevice: string, toDevice: string): void {
  const m = wsClients.get(uid);
  if (!m || !m.size) return;
  for (const [deviceId, sock] of m) {
    if (deviceId === fromDevice) continue; // 自己推的不叫醒自己
    if (toDevice && toDevice !== deviceId) continue; // 定向消息只叫醒目标端
    try {
      sock.send(JSON.stringify({ type: 'wake', from: fromDevice }));
    } catch {
      /* 单个连接异常不影响其它连接 */
    }
  }
}

app.post('/api/relay/ws-ticket', { preHandler: requireAuth }, async (req) => {
  const user = (req as AuthedRequest).user!;
  const { deviceId } = (req.body ?? {}) as { deviceId?: string };
  const now = Date.now();
  for (const [k, v] of wsTickets) if (v.expires < now) wsTickets.delete(k); // 顺手清过期
  const ticket = randomUUID();
  wsTickets.set(ticket, { uid: user.id, deviceId: String(deviceId ?? ''), expires: now + WS_TICKET_TTL_MS });
  return { ticket, expiresIn: Math.floor(WS_TICKET_TTL_MS / 1000) };
});

app.get('/api/relay/ws', { websocket: true }, (socket, req) => {
  const ticket = String((req.query as { ticket?: string }).ticket ?? '');
  const t = wsTickets.get(ticket);
  wsTickets.delete(ticket); // 一次性:无论成功与否都作废
  if (!t || t.expires < Date.now()) {
    try {
      socket.close(4401, 'ticket invalid');
    } catch {
      /* 忽略 */
    }
    return;
  }
  const uid = t.uid;
  const deviceId = t.deviceId || `ws-${randomUUID().slice(0, 8)}`;

  let m = wsClients.get(uid);
  if (!m) {
    m = new Map();
    wsClients.set(uid, m);
  }
  const old = m.get(deviceId);
  if (old && old !== socket) {
    try {
      old.close(4409, 'replaced by a newer connection');
    } catch {
      /* 忽略 */
    }
  }
  m.set(deviceId, socket as unknown as WsLike);
  void deviceSeen(uid, deviceId); // 连接即在线
  try {
    socket.send(JSON.stringify({ type: 'ready', deviceId }));
  } catch {
    /* 忽略 */
  }

  let lastAppPing = Date.now();
  // 协议层 ping:只是为了让中间设备(NAT/代理)不回收空闲连接,不作为存活依据
  const ping = setInterval(() => {
    try {
      socket.ping();
    } catch {
      /* 忽略 */
    }
  }, WS_PING_MS);
  // 存活依据 = 应用层心跳(JS 真的在跑)
  const aliveCheck = setInterval(() => {
    if (Date.now() - lastAppPing <= WS_APP_PING_TIMEOUT_MS) return;
    clearInterval(aliveCheck);
    try {
      socket.close(4408, 'app heartbeat timeout (js suspended?)');
      socket.terminate();
    } catch {
      /* 忽略 */
    }
  }, Math.max(1000, Math.min(WS_PING_MS, WS_APP_PING_TIMEOUT_MS)));

  socket.on('message', () => {
    lastAppPing = Date.now();
    void deviceSeen(uid, deviceId); // 只有 JS 真的在发消息,才算在线
  });
  socket.on('pong', () => {
    /* 网络栈自动回,不足以证明 JS 活着 —— 仅用于维持 TCP */
  });
  const cleanup = (): void => {
    clearInterval(ping);
    clearInterval(aliveCheck);
    const mm = wsClients.get(uid);
    if (mm && mm.get(deviceId) === (socket as unknown as WsLike)) {
      mm.delete(deviceId);
      if (!mm.size) wsClients.delete(uid);
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

function relayWaitOnce(userId: number, from: string, after: number): Promise<{ hasNew: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (hasNew: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const set = relayWaiters.get(userId);
      if (set) {
        set.delete(w);
        if (!set.size) relayWaiters.delete(userId);
      }
      resolve({ hasNew });
    };
    timer = setTimeout(() => finish(false), RELAY_WAIT_MS);
    const w: RelayWaiter = { userId, from, after, finish };
    let set = relayWaiters.get(userId);
    if (!set) {
      set = new Set();
      relayWaiters.set(userId, set);
    }
    set.add(w);
    // 不监听 req.raw 'close'(收完请求体后即触发,并非真实断连);断开的客户端最多等 RELAY_WAIT_MS 后被清理。
  });
}

app.post('/api/relay/push', async (req, reply) => {
  const user = (req as AuthedRequest).user!;
  const { from, payload, kind, to } = (req.body ?? {}) as {
    from?: string;
    payload?: string;
    kind?: RelayKind;
    to?: string;
  };
  if (typeof from !== 'string' || typeof payload !== 'string' || payload.length > 64 * 1024 * 1024) {
    return reply.code(400).send({ error: '无效的载荷' });
  }
  const k: RelayKind = kind === 'notify' || kind === 'need' ? kind : 'data';
  const target = typeof to === 'string' ? to : '';
  // 新协议:不看日志位置,直接把消息投进收件设备的信箱(取走即消费)
  const envelope = JSON.stringify({ kind: k, from, payload, to: target });
  if (target) await mboxPush(user.id, target, envelope);
  else await mboxPushToOthers(user.id, from, envelope);
  // 旧的共享日志照常写:只服务于尚未升级的旧客户端(它们还在用游标拉取)
  await relayPush(user.id, from, payload, k, target);
  wakeRelayWaiters(user.id, from, target); // 实时唤醒(本进程内存 + WebSocket)
  return { ok: true };
});

app.get('/api/relay/pull', async (req) => {
  const user = (req as AuthedRequest).user!;
  const from = String((req.query as { from?: string }).from ?? '');
  if (from) void deviceSeen(user.id, from); // 拉取即"我还在"(不阻塞主流程)
  const after = Number((req.query as { after?: string }).after ?? 0) || 0;
  const limit = Math.max(1, Math.min(Number((req.query as { limit?: string }).limit) || 100, 200));
  const r = await relayPull(user.id, from, after, limit);
  return { messages: r.messages, lastId: r.lastId };
});

// 长轮询即时通知:等"有没有新消息"。先查"已有新消息"→立即返回;否则挂到内存等待表,被 push 唤醒或超时。
app.post('/api/relay/wait', async (req) => {
  const user = (req as AuthedRequest).user!;
  const { from, after } = (req.body ?? {}) as { from?: string; after?: number };
  const f = typeof from === 'string' ? from : '';
  // 长轮询请求本身就是在线上报:客户端每 ≤20 秒就会重新挂一次 → 在线状态始终准确,
  // 且**不需要额外的定时心跳**。必须在挂起之前刷新(挂起期间不算"刚出现")。
  if (f) await deviceSeen(user.id, f);
  // 新协议(无游标):客户端不带 after → 只问"我的信箱里有没有东西"
  if (typeof after !== 'number') {
    if ((await mboxLen(user.id, f)) > 0) return { hasNew: true };
    return relayWaitOnce(user.id, f, 0);
  }
  const a = Number(after) || 0;
  if (await relayHasNew(user.id, a, f)) return { hasNew: true };
  return relayWaitOnce(user.id, f, a);
});

// 上报终端游标(完整拉取后调用),用于"所有终端都消费到 → 删除"省资源。
app.post('/api/relay/cursor', async (req) => {
  const user = (req as AuthedRequest).user!;
  const { deviceId, after } = (req.body ?? {}) as { deviceId?: string; after?: number };
  const dev = typeof deviceId === 'string' ? deviceId : '';
  const a = Number(after) || 0;
  if (dev) await relayReportCursor(user.id, dev, a);
  return { ok: true };
});


// ---------- 信箱:新协议的收件方式(无游标,取走即消费) ----------
app.get('/api/relay/mbox', async (req) => {
  const user = (req as AuthedRequest).user!;
  const from = String((req.query as { from?: string }).from ?? '');
  const limit = Math.max(1, Math.min(Number((req.query as { limit?: string }).limit) || 50, 200));
  if (!from) return { messages: [] };
  await deviceSeen(user.id, from); // 取件即"我还在"
  const raw = await mboxDrain(user.id, from, limit);
  const messages = raw
    .map((x, i) => {
      try {
        const o = JSON.parse(x) as { kind?: string; from?: string; payload?: string; to?: string };
        return { seq: i + 1, kind: o.kind ?? 'data', from: String(o.from ?? ''), to: String(o.to ?? ''), payload: String(o.payload ?? '') };
      } catch {
        return null;
      }
    })
    .filter((x): x is { seq: number; kind: string; from: string; to: string; payload: string } => Boolean(x));
  return { messages, remaining: await mboxLen(user.id, from) };
});

// ---------- 同步控制面:设备注册 / 水位线协商 / 主端选举 ----------
// 设计(按用户方案):
//   1) 任一端写入 → notify(带上自己最新水位 xxxa)广播给在线端;
//      对端比较自身水位 xxxb:若落后 → 向该端发 need(from=xxxb,to=xxxa) 定向请求;
//      被请求端把 (xxxb, xxxa] 区间的数据分小批定向推到云端;请求端再从云端拉取合并。
//   2) 新端登录 → /hello 拿到全部端的水位与主端:落后则向水位更高的端(优先主端)发 need。
//   3) 多端同时上线 → 每端 /hello 交换水位 → 选举主端(水位最新优先,其次登录最早),
//      各端统一向主端(或其水位更高者)补齐。
const ONLINE_MS = 90 * 1000;

function withLeader(devices: DeviceInfo[]): { leader: string | null; devices: DeviceInfo[] } {
  return {
    leader: pickLeader(devices),
    devices: devices.map((d) => ({ ...d, online: Date.now() - d.lastSeen <= ONLINE_MS })),
  };
}

/** 登录/冷启动握手:登记本端水位与登录时刻,返回其它端水位 + 主端。 */
app.post('/api/relay/hello', async (req, reply) => {
  const user = (req as AuthedRequest).user!;
  const { from, watermark, vector, count } = (req.body ?? {}) as {
    from?: string;
    watermark?: string;
    vector?: Record<string, string>;
    count?: number;
  };
  if (typeof from !== 'string' || !from) return reply.code(400).send({ error: '缺少 from' });
  const devices = await deviceRegister(user.id, from, String(watermark ?? ''), true, vector ?? {}, Number(count) || 0);
  // 事件驱动:有新端(或久未出现的端)上线 → 向其它端广播一条"有端加入",带上它的水位/向量/条目数。
  // 其它端收到就立刻比对、索取缺口 → 多端同时上线的"注册竞态"不靠定时器也能收敛。
  const self = devices.find((d) => d.deviceId === from);
  const others = devices.filter(
    (d) => d.deviceId !== from && Date.now() - d.lastSeen <= ONLINE_MS,
  );
  if (self && others.length) {
    const info = JSON.stringify({
      plain: { watermark: self.watermark, vector: self.vector, count: self.count },
    });
    await mboxPushToOthers(user.id, from, JSON.stringify({ kind: 'notify', from, payload: info, to: '' }));
    await relayPush(user.id, from, info, 'notify', '');
    wakeRelayWaiters(user.id, from, '');
  }
  return withLeader(devices);
});

/** 心跳:定期上报水位(幂等,不改 loginAt),顺带拿回最新设备表与主端。 */
app.post('/api/relay/heartbeat', async (req, reply) => {
  const user = (req as AuthedRequest).user!;
  const { from, watermark, vector, count } = (req.body ?? {}) as {
    from?: string;
    watermark?: string;
    vector?: Record<string, string>;
    count?: number;
  };
  if (typeof from !== 'string' || !from) return reply.code(400).send({ error: '缺少 from' });
  const devices = await deviceTouch(user.id, from, String(watermark ?? ''), vector ?? {}, Number(count) || 0);
  return withLeader(devices);
});

/** 设备表 + 当前主端(不改变任何状态)。 */
app.get('/api/relay/devices', async (req) => {
  const user = (req as AuthedRequest).user!;
  return withLeader(await deviceList(user.id));
});

/** 我更新了(广播,携带新水位 xxxa)。仅元数据,不含日记内容。 */
app.post('/api/relay/notify', async (req, reply) => {
  const user = (req as AuthedRequest).user!;
  const { from, watermark, payload, vector, count } = (req.body ?? {}) as {
    from?: string;
    watermark?: string;
    payload?: string;
    vector?: Record<string, string>;
    count?: number;
  };
  if (typeof from !== 'string' || !from) return reply.code(400).send({ error: '缺少 from' });
  await deviceTouch(user.id, from, String(watermark ?? ''), vector ?? {}, Number(count) || 0);
  const body = typeof payload === 'string' && payload ? payload : JSON.stringify({ plain: { watermark } });
  await mboxPushToOthers(user.id, from, JSON.stringify({ kind: 'notify', from, payload: body, to: '' }));
  await relayPush(user.id, from, body, 'notify', '');
  wakeRelayWaiters(user.id, from, '');
  return { ok: true };
});

/** 请把 (fromWatermark, toWatermark] 的数据推给我(定向)。仅元数据,不含日记内容。 */
app.post('/api/relay/need', async (req, reply) => {
  const user = (req as AuthedRequest).user!;
  const { from, to, origin, fromWatermark, toWatermark, payload } = (req.body ?? {}) as {
    from?: string;
    to?: string;
    origin?: string;
    fromWatermark?: string;
    toWatermark?: string;
    payload?: string;
  };
  if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
    return reply.code(400).send({ error: '缺少 from/to' });
  }
  const senders = await deviceList(user.id);
  const target = senders.find((d) => d.deviceId === to);
  // 只有"水位确实到达 toWatermark"的端才需要响应(防止对端自己也没数据却空推)
  const reachable = Boolean(target && String(target.watermark ?? '') >= String(toWatermark ?? ''));
  const needBody =
    typeof payload === 'string' && payload
      ? payload
      : JSON.stringify({
          plain: {
            origin: String(origin ?? ''),
            fromWatermark: String(fromWatermark ?? ''),
            toWatermark: String(toWatermark ?? ''),
          },
        });
  await mboxPush(user.id, to, JSON.stringify({ kind: 'need', from, payload: needBody, to }));
  await relayPush(user.id, from, needBody, 'need', to);
  wakeRelayWaiters(user.id, from, to);
  return { ok: true, reachable };
});

// 会话保护:除 健康/鉴权/扫码 外,所有 /api 需 Bearer 登录
// /api/relay/ws 走"一次性票据"自鉴权(浏览器 WebSocket API 不能带自定义请求头),
// 因此经 onRequest 放行,由 websocket 处理器内部校验票据。
const OPEN_PREFIXES = ['/api/health', '/api/auth', '/api/qr', '/api/relay/ws'];
// 云端模式:禁止这些"内容存储/读取"端点(遵循"服务端不存日记内容")
const CLOUD_BLOCKED_PREFIXES = [
  '/api/entries',
  '/api/search',
  '/api/images',
  '/api/uploads',
  '/api/export',
  '/api/import',
  '/api/summary',
  '/api/sync',
  '/api/qr',
];
app.addHook('onRequest', async (req, reply) => {
  const url = (req.url ?? '').split('?')[0] ?? '';
  // 云端模式:根路径是公开的落地说明页
  if (config.cloudMode && (url === '/' || url === '')) return;
  // 云端模式优先拦截内容端点(公网上这些会暴露/写入日记内容)
  if (config.cloudMode && CLOUD_BLOCKED_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`))) {
    return reply.code(403).send({ error: '云端模式不存储日记内容,该接口已禁用' });
  }
  if (OPEN_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`))) return;
  const auth = req.headers.authorization;
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const user = token ? getUserByToken(token) : null;
  if (!user) return reply.code(401).send({ error: '未登录或会话已过期' });
  (req as AuthedRequest).user = { id: user.id, username: user.username };
});

// ---------- 日记 ----------
app.get('/api/entries', async (req, reply) => {
  const { date, month } = req.query as { date?: string; month?: string };
  if (date) {
    if (!DATE_RE.test(date)) return reply.code(400).send({ error: '日期格式应为 YYYY-MM-DD' });
    return listEntriesByDate(date);
  }
  if (month) {
    if (!MONTH_RE.test(month)) return reply.code(400).send({ error: '月份格式应为 YYYY-MM' });
    return listEntriesByMonth(month);
  }
  return listAllEntries();
});

app.get('/api/entries/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: '非法 ID' });
  const entry = getEntry(id);
  if (!entry) return reply.code(404).send({ error: '没有这条日记' });
  return entry;
});

app.post('/api/entries', async (req, reply) => {
  const body = req.body as Partial<EntryCreateInput>;
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    return reply.code(400).send({ error: '内容不能为空' });
  }
  if (!body.date || !DATE_RE.test(body.date)) {
    return reply.code(400).send({ error: '日期格式应为 YYYY-MM-DD' });
  }
  return reply.code(201).send(createEntry({ date: body.date, content: body.content }));
});

app.patch('/api/entries/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: '非法 ID' });
  const body = req.body as Partial<EntryUpdateInput>;
  if (body.date !== undefined && !DATE_RE.test(body.date)) {
    return reply.code(400).send({ error: '日期格式应为 YYYY-MM-DD' });
  }
  if (body.content !== undefined && !body.content.trim()) {
    return reply.code(400).send({ error: '内容不能为空' });
  }
  const entry = updateEntry(id, body ?? {});
  if (!entry) return reply.code(404).send({ error: '没有这条日记' });
  return entry;
});

app.delete('/api/entries/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: '非法 ID' });
  if (!deleteEntry(id)) return reply.code(404).send({ error: '没有这条日记' });
  return { ok: true };
});

// ---------- 搜索 ----------
app.get('/api/search', async (req) => {
  const q = (req.query as { q?: string }).q;
  if (typeof q !== 'string' || !q.trim()) return [];
  return searchEntries(q.trim());
});

// ---------- 多端同步(增量,端到端加密) ----------
// 请求/响应的增量数据用"同步密钥"AES-GCM 加密(仅两台设备能解);支持旧版明文(兼容)。
interface SyncBody {
  since?: string;
  entries?: Entry[];
  images?: Array<{ id?: string; dataUrl?: string }>;
  localImageIds?: string[];
}

function getSyncKey(): string {
  const fp = path.join(config.dataDir, 'synckey');
  if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf8').trim();
  const k = generateSyncKey();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(fp, k);
  return k;
}

app.post('/api/sync', async (req, reply) => {
  const raw = req.body as { enc?: { iv: string; data: string } } | SyncBody | null;
  const key = getSyncKey();
  const encrypted = Boolean(raw && (raw as { enc?: unknown }).enc);
  let body: SyncBody | null;
  if (encrypted) {
    try {
      body = await decryptObject<SyncBody>(key, (raw as { enc: { iv: string; data: string } }).enc);
    } catch {
      return reply.code(401).send({ error: '同步密钥不匹配' });
    }
  } else {
    body = raw as SyncBody;
  }

  const entries = body?.entries;
  if (!Array.isArray(entries) || entries.length > 100000) {
    return reply.code(400).send({ error: '无效的同步负载' });
  }
  const since = typeof body?.since === 'string' && body.since ? body.since : '';
  const applied = applySyncedEntries(entries);

  // 存入对方送来的媒体(图片/视频,按内容哈希,幂等去重)
  for (const img of body?.images ?? []) {
    if (!img || typeof img.dataUrl !== 'string') continue;
    const decoded = decodeMediaDataUrl(img.dataUrl);
    if (!decoded) continue;
    const id = img.id && /^[0-9a-f]{16,64}$/.test(img.id) ? img.id : imageIdFromDataUrl(img.dataUrl);
    saveImage(config.imagesDir, id, decoded.bytes);
  }

  // 返回本机有、但对方没有的媒体(逐次补齐,已拥有的不再重复传)
  const have = new Set<string>(body?.localImageIds ?? []);
  const missing = listImageIds(config.imagesDir)
    .filter((id) => !have.has(id))
    .map((id) => {
      const bytes = readImage(config.imagesDir, id);
      return bytes ? { id, dataUrl: `data:${detectMediaMime(bytes)};base64,${bytes.toString('base64')}` } : null;
    })
    .filter(Boolean);

  // 只返回对方上次同步(since)之后有改动的增量条目(含墓碑);归一化旧引用
  const syncedEntries = getAllEntriesForSync()
    .filter((e) => !since || e.updatedAt > since)
    .map((e) => ({
      ...e,
      content: normalizeLegacyImageRefs(e.content, config.imagesDir, config.uploadsDir),
    }));

  const result = { applied, entries: syncedEntries, images: missing };
  return encrypted ? { enc: await encryptObject(key, result) } : result;
});

// ---------- 扫码配对:给出本机局域网地址的二维码与文本 ----------
function lanBaseUrl(): string {
  const port = config.port;
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) return `http://${n.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

app.get('/api/qr', async (_req, reply) => {
  const url = lanBaseUrl();
  const key = getSyncKey();
  const qrStr = `${url}\n${key}`;
  const dataUrl = await QRCode.toDataURL(qrStr, { margin: 1, width: 360 });
  return { url, dataUrl, key };
});

// ---------- 月度小结 ----------
app.get('/api/summary', async (req, reply) => {
  const month = (req.query as { month?: string }).month;
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    return reply.code(400).send({ error: '月份格式应为 YYYY-MM' });
  }
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const entries = listEntriesByMonth(month);
  if (entries.length === 0) {
    return reply.code(404).send({ error: '这个月还没有日记,先去写一点吧' });
  }
  const cached = getSummary(year, mon);
  if (!cached) return { exists: false };
  const stale = cached.entriesHash !== entriesHash(entries);
  return { exists: true, stale, summary: cached };
});

app.post('/api/summary', async (req, reply) => {
  const month = (req.body as { month?: string })?.month;
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    return reply.code(400).send({ error: '月份格式应为 YYYY-MM' });
  }
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const entries = listEntriesByMonth(month);
  if (entries.length === 0) {
    return reply.code(404).send({ error: '这个月还没有日记,先去写一点吧' });
  }
  const hasImages = entriesContainImages(entries);
  const provider = hasImages ? getVisionProvider() : getTextProvider();
  const content = await summarizeMonth(entries, provider, config.imagesDir, config.uploadsDir);
  const summary = upsertSummary(year, mon, content, entriesHash(entries));
  return { summary, model: hasImages ? config.ai.visionModel : config.ai.textModel };
});

// ---------- 公共能力:AI 小结(自包含、可独立部署/上云) ----------
// 客户端把"当月日记"发来,服务端用自身 AI 密钥生成小结并返回。不依赖本库,可部署到任意服务器。
app.post('/api/summarize', async (req, reply) => {
  const raw = req.body as { enc?: { iv: string; data: string } } | { entries?: Entry[] } | null;
  const key = getSyncKey();
  const encrypted = Boolean(raw && (raw as { enc?: unknown }).enc);
  let body: { entries?: Entry[] };
  if (encrypted) {
    try {
      body = await decryptObject<{ entries?: Entry[] }>(key, (raw as { enc: { iv: string; data: string } }).enc);
    } catch {
      return reply.code(401).send({ error: '同步密钥不匹配' });
    }
  } else {
    body = raw as { entries?: Entry[] };
  }
  const entries = body?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return reply.code(400).send({ error: '没有可小结的日记' });
  }
  const hasImages = entriesContainImages(entries);
  const provider = hasImages ? getVisionProvider() : getTextProvider();
  const content = await summarizeMonth(entries, provider, config.imagesDir, config.uploadsDir);
  const result = { content, model: hasImages ? config.ai.visionModel : config.ai.textModel };
  return encrypted ? { enc: await encryptObject(key, result) } : result;
});

// ---------- 公共能力:AI 陪伴对话(自包含、可部署/上云) ----------
// 客户端把"对话 + 相关日记背景"发来,服务端用自身 AI 密钥给出回应并返回;不落盘、不存内容。
app.post('/api/companion', async (req, reply) => {
  const raw = req.body as
    | { enc?: { iv: string; data: string } }
    | { messages?: CompanionMessage[]; context?: Entry[] }
    | null;
  const key = getSyncKey();
  const encrypted = Boolean(raw && (raw as { enc?: unknown }).enc);
  let body: { messages?: CompanionMessage[]; context?: Entry[] };
  if (encrypted) {
    try {
      body = await decryptObject<{ messages?: CompanionMessage[]; context?: Entry[] }>(
        key,
        (raw as { enc: { iv: string; data: string } }).enc,
      );
    } catch {
      return reply.code(401).send({ error: '同步密钥不匹配' });
    }
  } else {
    body = raw as { messages?: CompanionMessage[]; context?: Entry[] };
  }
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return reply.code(400).send({ error: '没有可对话的内容' });
  }
  const lastIdx = messages.map((m) => m?.content?.trim()).findLastIndex((c) => Boolean(c));
  if (lastIdx < 0 || messages[lastIdx]?.role !== 'user') {
    return reply.code(400).send({ error: '对话需以一条用户消息结尾' });
  }
  const context = Array.isArray(body?.context) ? (body.context as Entry[]) : [];
  const provider = getTextProvider();
  const text = await chatWithDiary(context, messages as CompanionMessage[], provider);
  const result = { reply: text, model: config.ai.textModel };
  return encrypted ? { enc: await encryptObject(key, result) } : result;
});

// ---------- 导出 ----------
function buildMarkdownExport(entries: Awaited<ReturnType<typeof listAllEntries>>): string {
  const byDate = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }
  const lines: string[] = ['# 我的日记', ''];
  for (const date of [...byDate.keys()].sort()) {
    lines.push(`## ${date}`, '');
    for (const e of byDate.get(date)!) {
      lines.push(e.content.trim(), '');
    }
    lines.push('---', '');
  }
  return lines.join('\n');
}

app.get('/api/export', async (req, reply) => {
  const format = (req.query as { format?: string }).format ?? 'md';
  const entries = listAllEntries();
  const date = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="diary-export-${date}.json"`);
    return JSON.stringify(entries, null, 2);
  }
  reply.header('Content-Type', 'text/markdown; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="diary-export-${date}.md"`);
  return buildMarkdownExport(entries);
});

// ---------- 迁移包(与手机端同构:含全部日记+图片,便于手机↔电脑/备份) ----------
app.get('/api/export/bundle', async (_req, reply) => {
  const entries = getAllEntriesForSync(); // 含墓碑,便于 LWW 忠实合并
  const images = listImageIds(config.imagesDir)
    .map((id) => {
      const bytes = readImage(config.imagesDir, id);
      return bytes ? { id, dataUrl: `data:${detectMediaMime(bytes)};base64,${bytes.toString('base64')}` } : null;
    })
    .filter((x): x is { id: string; dataUrl: string } => Boolean(x));
  const bundle = {
    app: 'diary',
    version: 1,
    createdAt: new Date().toISOString(),
    deviceId: 'desktop',
    entries,
    images,
  };
  reply.header('Content-Type', 'application/json; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="diary-bundle-${new Date().toISOString().slice(0, 10)}.json"`);
  return bundle;
});

app.post('/api/import/bundle', async (req, reply) => {
  const b = (req.body as Record<string, unknown> | null) ?? {};
  if ((b as { app?: unknown }).app !== 'diary') return reply.code(400).send({ error: '不是本应用的迁移包' });
  if (b.version !== 1) return reply.code(400).send({ error: '不支持的迁移包版本' });
  const entries = (b as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return reply.code(400).send({ error: '迁移包缺少 entries' });
  const validEntries = (entries as Entry[]).filter(
    (e) => e && typeof e.id === 'string' && typeof e.date === 'string' && typeof e.content === 'string',
  );
  const entriesImported = applySyncedEntries(validEntries); // LWW

  let imagesImported = 0;
  for (const img of (b as { images?: Array<{ id?: string; dataUrl?: string }> }).images ?? []) {
    if (!img || typeof img.dataUrl !== 'string') continue;
    const decoded = decodeMediaDataUrl(img.dataUrl);
    if (!decoded) continue;
    const id = img.id && /^[0-9a-f]{16,64}$/.test(img.id) ? img.id : imageIdFromDataUrl(img.dataUrl);
    if (!readImage(config.imagesDir, id)) {
      saveImage(config.imagesDir, id, decoded.bytes);
      imagesImported++;
    }
  }
  return { ok: true, entriesImported, imagesImported };
});

// ---------- 图片 ----------
const IMAGE_DATA_RE = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

app.post('/api/uploads', async (req, reply) => {
  const dataUrl = (req.body as { dataUrl?: string } | null)?.dataUrl;
  if (typeof dataUrl !== 'string') {
    return reply.code(400).send({ error: '缺少图片数据' });
  }
  const m = IMAGE_DATA_RE.exec(dataUrl);
  if (!m) return reply.code(400).send({ error: '仅支持 PNG / JPEG / GIF / WebP 图片' });
  const mime = m[1]!;
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]!;
  const buf = Buffer.from(m[2]!, 'base64');
  if (buf.length === 0) return reply.code(400).send({ error: '图片数据为空' });
  if (buf.length > 32 * 1024 * 1024) return reply.code(413).send({ error: '图片过大(最大 32MB)' });

  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const name = `img-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  fs.writeFileSync(path.join(config.uploadsDir, name), buf);
  return reply.code(201).send({ url: `/api/uploads/${name}` });
});

app.get('/api/uploads/:name', async (req, reply) => {
  const name = path.basename((req.params as { name: string }).name);
  if (!/^img-[A-Za-z0-9-]+\.(png|jpe?g|gif|webp)$/.test(name)) {
    return reply.code(404).send({ error: '图片不存在' });
  }
  const fp = path.join(config.uploadsDir, name);
  if (!fs.existsSync(fp)) return reply.code(404).send({ error: '图片不存在' });
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return reply.type(mime).send(fs.readFileSync(fp));
});

// ---------- 内容寻址图片(统一模型) ----------
// 上传:按内容哈希(id)去重存储;条目内引用 diary-img:<id>
app.post('/api/images', async (req, reply) => {
  const dataUrl = (req.body as { dataUrl?: string } | null)?.dataUrl;
  if (typeof dataUrl !== 'string') return reply.code(400).send({ error: '缺少图片数据' });
  const decoded = decodeMediaDataUrl(dataUrl);
  if (!decoded || !decoded.ext.match(/^(png|jpe?g|gif|webp)$/))
    return reply.code(400).send({ error: '仅支持 PNG / JPEG / GIF / WebP 图片' });
  if (decoded.bytes.length > 64 * 1024 * 1024) return reply.code(413).send({ error: '媒体过大(最大 64MB)' });

  const id = imageIdFromDataUrl(dataUrl);
  saveImage(config.imagesDir, id, decoded.bytes);
  return reply.code(201).send({ id });
});

app.get('/api/images/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!/^[0-9a-f]{16,64}$/.test(id)) return reply.code(404).send({ error: '媒体不存在' });
  const bytes = readImage(config.imagesDir, id);
  if (!bytes) return reply.code(404).send({ error: '媒体不存在' });
  return reply.type(detectMediaMime(bytes)).send(bytes);
});

// ---------- 媒体(图片 + 视频)统一上传/取用 ----------
app.post('/api/media', async (req, reply) => {
  const dataUrl = (req.body as { dataUrl?: string } | null)?.dataUrl;
  if (typeof dataUrl !== 'string') return reply.code(400).send({ error: '缺少媒体数据' });
  const decoded = decodeMediaDataUrl(dataUrl);
  if (!decoded) return reply.code(400).send({ error: '仅支持图片(PNG/JPEG/GIF/WebP)或视频(MP4/WebM/MOV)' });
  if (decoded.bytes.length > 64 * 1024 * 1024) return reply.code(413).send({ error: '媒体过大(最大 64MB)' });
  const id = imageIdFromDataUrl(dataUrl);
  saveImage(config.imagesDir, id, decoded.bytes);
  return reply.code(201).send({ id });
});

app.get('/api/media/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!/^[0-9a-f]{16,64}$/.test(id)) return reply.code(404).send({ error: '媒体不存在' });
  const bytes = readImage(config.imagesDir, id);
  if (!bytes) return reply.code(404).send({ error: '媒体不存在' });
  return reply.type(detectMediaMime(bytes)).send(bytes);
});

// ---------- 静态托管(生产模式:把构建好的前端一并伺服) ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');

if (config.cloudMode) {
  // 云端模式:纯 身份 + 加密中继 + AI 服务,不伺服日记前端、不落盘内容
  app.get('/', async () => ({
    service: 'personal-diary-cloud',
    ok: true,
    note: '这是日记的云端"身份 + 加密中继 + AI"服务;日记内容只在你的 PC/手机本地。',
  }));
} else if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((_req, reply) => {
    // SPA 回退到 index.html
    return reply.sendFile('index.html');
  });
}

// ---------- 启动 ----------
const start = async () => {
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`日记服务已启动: http://localhost:${config.port}`);
    app.log.info(`数据目录: ${config.dataDir}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
