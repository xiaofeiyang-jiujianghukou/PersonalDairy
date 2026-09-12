import { deriveSyncKey, decryptObject, encryptObject } from '@diary/shared/syncCrypto';
const BASE='https://bluesheep.vip';
const login=await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'xiaofeiyang',password:'123456'})})).json();
const H={Authorization:`Bearer ${login.token}`,'Content-Type':'application/json'};
const me=await (await fetch(BASE+'/api/auth/me',{headers:H})).json();
const key=await deriveSyncKey('123456', String(me.uid));
const dev='probe-alive-'+Math.random().toString(36).slice(2,6);
const hello=await (await fetch(BASE+'/api/relay/hello',{method:'POST',headers:H,body:JSON.stringify({from:dev,watermark:'',vector:{},count:0})})).json();
const phone=(hello.devices||[]).find((d:any)=>d.deviceId.startsWith('14c2b856'));
let tail=(await (await fetch(`${BASE}/api/relay/pull?from=${dev}&after=205&limit=60`,{headers:H})).json()).lastId;
console.log('手机:', phone?.deviceId?.slice(0,8), '| 在线状态:', phone?.online, '| 当前流尾:', tail);
const payload=JSON.stringify(await encryptObject(key,{origin:'phone',fromWatermark:'2026-09-11T10:17:25.906Z',toWatermark:'2026-09-11T15:07:16.292Z'}));
await fetch(BASE+'/api/relay/need',{method:'POST',headers:H,body:JSON.stringify({from:dev,to:phone.deviceId,origin:'phone',fromWatermark:'2026-09-11T10:17:25.906Z',toWatermark:'2026-09-11T15:07:16.292Z',payload})});
console.log('已发 need,等 20 秒看手机是否补传(只看定向给我的消息)...');
const start=Date.now();
while (Date.now()-start < 20000) {
  await new Promise(r=>setTimeout(r,1500));
  const pull=await (await fetch(`${BASE}/api/relay/pull?from=${dev}&after=${tail}&limit=30`,{headers:H})).json();
  for (const m of pull.messages||[]) {
    if (m.id>tail) tail=m.id;
    if (m.kind!=='data' || m.to!==dev) continue;
    try { const dec:any=await decryptObject<any>(key,JSON.parse(m.payload));
      console.log(`✅ 手机补传了 ${(dec.entries||[]).length} 条:`, (dec.entries||[]).map((e:any)=>`${String(e.updatedAt).slice(0,19)}`).join(','));
      process.exit(0);
    } catch {}
  }
}
console.log('❌ 20 秒内手机没有补传 → 手机端的 JS 现在没有在处理消息(App 很可能仍处于后台/锁屏冻结状态)');
process.exit(0);
