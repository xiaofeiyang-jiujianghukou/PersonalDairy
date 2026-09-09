import net from 'node:net';
import tls from 'node:tls';

// 零依赖 SMTP 客户端(AUTH LOGIN,支持 465 隐式 TLS 与 587 STARTTLS)。
// 用于"忘记密码"发验证码邮件。未配置 SMTP_* 时降级为打印验证码(本地/测试)。

export interface MailResult {
  ok: boolean;
  note: string;
}

export type MailPurpose = 'register' | 'reset';

interface MailCfg {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  from: string;
}

function cfg(): MailCfg | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || '465');
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  return {
    host,
    port,
    user: process.env.SMTP_USER?.trim() ?? '',
    pass: process.env.SMTP_PASS ?? '',
    secure,
    from: process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || '',
  };
}

const b64 = (s: string): string => Buffer.from(s).toString('base64');

export async function sendCodeEmail(to: string, code: string, username: string, purpose: MailPurpose): Promise<MailResult> {
  const c = cfg();
  if (!c) {
    console.log(`[mail][dev] ${username} ${purpose === 'register' ? '注册' : '密码重置'}验证码: ${code} (未配置 SMTP_*,仅打印,生产请配置)`);
    return { ok: true, note: 'console' };
  }
  try {
    await smtpSend(c, to, buildMessage(c.from, to, username, code, purpose));
    return { ok: true, note: 'smtp' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[mail] SMTP 发送失败:', msg);
    return { ok: false, note: msg };
  }
}

function buildMessage(from: string, to: string, username: string, code: string, purpose: MailPurpose): string {
  const subject = purpose === 'register' ? 'PersonalDiary 注册验证码' : 'PersonalDiary 密码重置验证码';
  const first = purpose === 'register' ? '你的注册验证码是' : '你的密码重置验证码是';
  const footnote = purpose === 'register' ? '如果这不是你本人的操作,请忽略此邮件。' : '15 分钟内有效。如果这不是你本人的操作,请忽略此邮件。';
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    `${username},你好:`,
    '',
    `${first}: ${code}`,
    '',
    footnote,
    '',
    '—— PersonalDiary',
  ].join('\r\n');
}

async function smtpSend(c: MailCfg, to: string, message: string): Promise<void> {
  let sock: net.Socket = c.secure
    ? tls.connect({ host: c.host, port: c.port, servername: c.host })
    : net.connect({ host: c.host, port: c.port });
  sock.setTimeout(20_000);

  let buf = '';
  const pending: number[] = [];
  const waiters: Array<{ resolve: (n: number) => void; reject: (e: Error) => void }> = [];
  function onData(d: Buffer) {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      // 多行回复只取最后一行(第 4 字符是空格而非 '-')
      if (line.length < 4 || line[3] !== '-') {
        const code = Number(line.slice(0, 3));
        const w = waiters.shift();
        if (w) w.resolve(code);
        else pending.push(code);
      }
    }
  }
  function next(): Promise<number> {
    if (pending.length) return Promise.resolve(pending.shift()!);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }
  const rejectAll = (e: Error) => {
    const w = waiters.shift();
    if (w) w.reject(e);
  };
  sock.on('data', onData);
  sock.on('error', rejectAll);
  sock.on('timeout', () => rejectAll(new Error('SMTP 超时')));

  const expect = async (code: number) => {
    const got = await next();
    if (got !== code) throw new Error(`SMTP 期望 ${code},收到 ${got}`);
  };

  try {
    await expect(220); // 欢迎
    sock.write(`EHLO ${c.host}\r\n`);
    await expect(250);

    if (!c.secure) {
      sock.write('STARTTLS\r\n');
      await expect(220);
      sock.removeListener('data', onData);
      const tlsSock = tls.connect({ socket: sock, servername: c.host });
      sock = tlsSock;
      buf = '';
      pending.length = 0;
      tlsSock.on('data', onData);
      tlsSock.on('error', rejectAll);
      await new Promise<void>((res, rej) => {
        tlsSock.once('secureConnect', res);
        tlsSock.once('error', rej);
      });
      tlsSock.write(`EHLO ${c.host}\r\n`);
      await expect(250);
    }

    sock.write('AUTH LOGIN\r\n');
    await expect(334);
    sock.write(b64(c.user) + '\r\n');
    await expect(334);
    sock.write(b64(c.pass) + '\r\n');
    await expect(235);
    sock.write(`MAIL FROM:<${c.from}>\r\n`);
    await expect(250);
    sock.write(`RCPT TO:<${to}>\r\n`);
    await expect(250);
    sock.write('DATA\r\n');
    await expect(354);
    sock.write(message + '\r\n.\r\n');
    await expect(250);
    sock.write('QUIT\r\n');
    await expect(221);
  } finally {
    sock.destroy();
  }
}
