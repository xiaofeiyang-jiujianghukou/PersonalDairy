import { encryptObject, decryptObject } from '../packages/shared/src/syncCrypto';
const B = 'http://localhost:4529';
const key = (await (await fetch(B + '/api/qr')).json()).key; // 用同步密钥(假设两端已配对)
const token = (await (await fetch(B + '/api/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username:'relay'+Date.now(), password:'secret123' }) })).json()).token || (
  (await (await fetch(B + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username:'relay'+Date.now(), password:'secret123' }) })).json()).token
);
const H = { 'Content-Type':'application/json', Authorization: 'Bearer '+token };

// 设备A 加密一份增量 payload
const A = { since:'', entries:[{ id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', date:'2026-09-05', content:'A 经中继的条目', deviceId:'devA', createdAt:'2026-09-05T01:00:00.000Z', updatedAt:'2026-09-05T01:00:00.000Z', deletedAt:null }], images:[], localImageIds:[] };
const encA = await encryptObject(key, A);
await fetch(B + '/api/relay/push', { method:'POST', headers:H, body: JSON.stringify({ from:'device-A', payload: JSON.stringify(encA) }) });

// 设备B 拉取(排除自己)
const pull = await (await fetch(B + '/api/relay/pull?from=device-B', { headers:H })).json();
console.log('B 拉取到消息数:', pull.messages.length);
const decA = await decryptObject(key, JSON.parse(pull.messages[0].payload));
console.log('B 解密后条目:', decA.entries[0].content, '| 来自', pull.messages[0].from);
console.log('OK: 加密 payload 经中继 → 对端解密成功');
