import { deriveSyncKey, decryptObject } from '@diary/shared/syncCrypto';
const BASE='https://bluesheep.vip';
const login=await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'xiaofeiyang',password:'123456'})})).json();
const token=login.token;
const me=await (await fetch(BASE+'/api/auth/me',{headers:{Authorization:`Bearer ${token}`}})).json();
const key=await deriveSyncKey('123456', String(me.uid));
const d=await (await fetch(BASE+'/api/relay/pull?from=&after=80&limit=30',{headers:{Authorization:`Bearer ${token}`}})).json();
const msgs=d.messages||[];
console.log('尾部消息(id → 设备 → 条目):');
for (const m of msgs) {
  let dec:any; try { dec=await decryptObject<any>(key, JSON.parse(m.payload)); } catch { console.log(`  id=${m.id} ${m.from.slice(0,8)} 解不开`); continue; }
  const es=(dec.entries||[]).filter((e:any)=>!e.deletedAt);
  const s=es.map((e:any)=>`${e.date}|${(e.content||'').slice(0,16).replace(/\n/g,' ')}`).join(' ; ');
  console.log(`  id=${m.id} dev=${m.from.slice(0,8)} 条目数=${es.length} :: ${s.slice(0,90)}`);
}
process.exit(0);
