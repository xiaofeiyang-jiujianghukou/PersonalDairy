import { deriveSyncKey, decryptObject } from '@diary/shared/syncCrypto';
const BASE='https://bluesheep.vip';
const login=await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'xiaofeiyang',password:'123456'})})).json();
const token=login.token;
const me=await (await fetch(BASE+'/api/auth/me',{headers:{Authorization:`Bearer ${token}`}})).json();
const key=await deriveSyncKey('123456', String(me.uid));
const d=await (await fetch(`${BASE}/api/relay/pull?from=&after=100&limit=25`,{headers:{Authorization:`Bearer ${token}`}})).json();
for (const m of d.messages||[]) {
  let dec:any;
  try { dec=await decryptObject<any>(key, JSON.parse(m.payload)); } catch { continue; }
  for (const e of dec.entries||[]) {
    if (String(e.content||'').includes('小杯子')) {
      console.log(`消息 id=${m.id} 来自 dev=${String(m.from).slice(0,8)}`);
      console.log('该条目完整字段:');
      console.log(JSON.stringify(e, null, 2).slice(0,900));
      console.log('字段类型检查:', Object.entries(e).map(([k,v])=>`${k}:${typeof v}${v===null?'(null)':''}`).join('  '));
      process.exit(0);
    }
  }
}
console.log('未在 100 之后的手机消息里找到该条目');
process.exit(0);
