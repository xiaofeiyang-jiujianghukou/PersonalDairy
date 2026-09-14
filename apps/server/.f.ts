import { deriveSyncKey, encryptObject, decryptObject } from '@diary/shared/syncCrypto';
const BASE='https://bluesheep.vip';
const login=await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'xiaofeiyang',password:'123456'})})).json();
const H={Authorization:`Bearer ${login.token}`,'Content-Type':'application/json'};
const me=await (await fetch(BASE+'/api/auth/me',{headers:H})).json();
const key=await deriveSyncKey('123456', String(me.uid));
const dev='probe-q-'+Math.random().toString(36).slice(2,5);
const phone='14c2b856-10ba-437d-bab5-16d01211a4af';
const hello=await (await fetch(BASE+'/api/relay/hello',{method:'POST',headers:H,body:JSON.stringify({from:dev,watermark:'',vector:{},count:0})})).json();
const ph=(hello.devices||[]).find((d:any)=>String(d.deviceId).startsWith('14c2b856'));
console.log(`【1】手机状态: ${ph?.online?'在线':'离线'} | 活跃 ${Math.round((Date.now()-ph.lastSeen)/1000)}s 前 | 条目=${ph.count}`);
const origin=phone, from='2026-09-14T13:44:27.616Z', to='2026-09-14T15:43:43.807Z';
const payload=JSON.stringify(await encryptObject(key,{origin,fromWatermark:from,toWatermark:to}));
const r:any=await (await fetch(BASE+'/api/relay/need',{method:'POST',headers:H,body:JSON.stringify({from:dev,to:origin,origin,fromWatermark:from,toWatermark:to,payload})})).json();
console.log(`【2】服务端投递结果: reachable=${r.reachable}  delivered=${r.delivered}   ← delivered=false 表示服务端就没投进手机信箱`);
console.log(`【3】请求体大小: ${payload.length} 字节(不到 1KB —— 与"数据过大"无关)`);
let got=0;
for (let i=0;i<8;i++){
  await new Promise(r2=>setTimeout(r2,4000));
  const p=await (await fetch(`${BASE}/api/relay/mbox?from=${dev}&limit=20`,{headers:H})).json();
  for (const m of p.messages||[]) if (m.kind==='data') { try { const d:any=await decryptObject<any>(key,JSON.parse(m.payload)); got+=(d.entries||[]).length; } catch {} }
  if (got) break;
}
console.log(got? `【4】手机在 ${''+8*4} 秒内应答了 ${got} 条 ✅` : '【4】手机 32 秒内没有任何应答 ❌ → 它没有在处理信箱');
process.exit(0);
