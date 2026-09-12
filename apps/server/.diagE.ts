import { deriveSyncKey, decryptObject, encryptObject } from '@diary/shared/syncCrypto';
const BASE='https://bluesheep.vip';
const login=await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'xiaofeiyang',password:'123456'})})).json();
const H={Authorization:`Bearer ${login.token}`,'Content-Type':'application/json'};
const me=await (await fetch(BASE+'/api/auth/me',{headers:H})).json();
const key=await deriveSyncKey('123456', String(me.uid));
const dev='probe-diag2-'+Math.random().toString(36).slice(2,6);
const hello=await (await fetch(BASE+'/api/relay/hello',{method:'POST',headers:H,body:JSON.stringify({from:dev,watermark:'',vector:{},count:0})})).json();
const phone=(hello.devices||[]).find((d:any)=>d.deviceId.startsWith('14c2b856'));
console.log('手机完整 deviceId =', phone?.deviceId);
console.log('手机上报的 vector =', JSON.stringify(phone?.vector));
console.log('手机条目数 =', phone?.count, ' 水位 =', phone?.watermark);
// 手机自己的来源(它新建条目会打上这个 deviceId)
const origin = phone.deviceId;
const payload=JSON.stringify(await encryptObject(key,{origin,fromWatermark:'',toWatermark:phone.watermark}));
const need=await (await fetch(BASE+'/api/relay/need',{method:'POST',headers:H,body:JSON.stringify({from:dev,to:phone.deviceId,origin,fromWatermark:'',toWatermark:phone.watermark,payload})})).json();
console.log(`\n已请求: origin=${origin.slice(0,8)} 区间(从头, ${phone.watermark}] →`, JSON.stringify(need));
let cursor=0, got:any[]=[];
for (let i=0;i<16;i++){
  await new Promise(r=>setTimeout(r,1500));
  const pull=await (await fetch(`${BASE}/api/relay/pull?from=${dev}&after=${cursor}&limit=30`,{headers:H})).json();
  let newOnes=0;
  for (const m of pull.messages||[]) {
    if (m.id>cursor) cursor=m.id;
    if (m.kind!=='data') continue;
    try { const dec:any=await decryptObject<any>(key,JSON.parse(m.payload)); for (const e of dec.entries||[]) { got.push(e); newOnes++; } } catch {}
  }
  if (newOnes) console.log(`  第 ${i+1} 轮:收到 ${newOnes} 条`);
}
console.log(`\n共收到 ${got.length} 条(来自手机来源 ${origin.slice(0,8)} 的):`);
for (const e of got.slice(0,10)) console.log(`  ${String(e.updatedAt).slice(0,19)} origin=${String(e.deviceId).slice(0,8)} :: ${String(e.content||'').replace(/\n/g,' ').slice(0,40)}`);
process.exit(0);
