// 验证本地优先存储 + 同步合并逻辑(内存后端,Node 下运行)。
import { MemoryBackend, createLocalApi } from '../apps/web/src/lib/localStore';
import { reconcileFull } from '../packages/shared/src/sync';

const backend = new MemoryBackend();
const api = createLocalApi(backend);
let pass = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✓', msg); } else { console.error('  ✗', msg); process.exitCode = 1; } };

console.log('本地优先(手机):');
const a = await api.create({ date: '2026-09-08', content: '手机写的第一条' });
const b = await api.create({ date: '2026-09-08', content: '手机写的第二条' });
ok(a.id && b.id, 'create 返回 UUID');

const monthList = await api.listByMonth('2026-09');
ok(monthList.length === 2, 'listByMonth 返回 2 条');

await api.remove(a.id);
const afterDel = await api.listByMonth('2026-09');
ok(afterDel.length === 1 && afterDel[0].id === b.id, '软删除后列表只剩 1 条(墓碑生效)');

const rawAll = await backend.getAll();
ok(rawAll.length === 2 && rawAll.some((e) => e.id === a.id && e.deletedAt), '墓碑仍在原始存储(供同步传播)');

console.log('同步合并(与电脑):');
const theirs = [
  { ...b, content: '电脑上更新过 b', updatedAt: '2026-09-09T01:00:00.000Z', deviceId: 'pc' },
  { id: '99999999-9999-4999-8999-999999999999', date: '2026-09-09', content: '电脑端新增', deviceId: 'pc', createdAt: '2026-09-09T01:00:00.000Z', updatedAt: '2026-09-09T01:00:00.000Z', deletedAt: null },
];
const merged = reconcileFull(rawAll, theirs);
ok(merged.length === 3, 'reconcile 合并出 3 条');
ok(merged.find((e) => e.id === b.id).content === '电脑上更新过 b', 'LWW:电脑端更新的 b 生效');
ok(merged.some((e) => e.id === a.id && e.deletedAt), 'reconcile 保留墓碑');
ok(merged.some((e) => e.id === '99999999-9999-4999-8999-999999999999'), 'reconcile 吸入电脑端新增');

const localMap = new Map(rawAll.map((e) => [e.id, e]));
const toWrite = [];
for (const e of merged) { const cur = localMap.get(e.id); if (!cur || e.updatedAt > cur.updatedAt) toWrite.push(e); }
await backend.put(toWrite);
ok((await api.listByMonth('2026-09')).some((e) => e.content === '电脑上更新过 b'), '合并结果写回本地');
ok(!(await api.listByMonth('2026-09')).some((e) => e.id === a.id), '墓碑条目不显示');

console.log(`\n通过 ${pass} 项检查${process.exitCode ? '(有失败)' : ' ✓ 全部通过'}`);
