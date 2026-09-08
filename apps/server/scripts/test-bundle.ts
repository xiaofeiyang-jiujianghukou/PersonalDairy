import { encryptObjectWithPassphrase, decryptObjectWithPassphrase } from '@diary/shared/syncCrypto';
import { assertBundle, isEncryptedBundle, BUNDLE_APP } from '@diary/shared/bundle';
import { reconcileFull, newerEntry } from '@diary/shared/sync';
import type { Entry } from '@diary/shared';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) {
    pass++;
    console.log(`  ok - ${name}`);
  } else {
    fail++;
    console.error(`  FAIL - ${name}`);
  }
}

const mk = (id: string, updatedAt: string, deletedAt: string | null = null): Entry => ({
  id,
  date: '2026-09-01',
  content: '正文 ' + id,
  deviceId: 't',
  createdAt: updatedAt,
  updatedAt,
  deletedAt,
});

console.log('\n[1] 口令 AES-GCM 往返');
(async () => {
  const obj = { hello: '世界', n: 42, list: [1, 2, 3] };
  const enc = await encryptObjectWithPassphrase('secret123', obj);
  ok(isEncryptedBundle({ app: BUNDLE_APP, version: 1, createdAt: '', deviceId: 'x', ...enc } as never), '加密输出含 kdf/iv/data');
  const dec = await decryptObjectWithPassphrase<typeof obj>('secret123', enc);
  ok(dec.hello === '世界' && dec.n === 42 && dec.list[2] === 3, '正确口令还原对象');

  let threw = false;
  try {
    await decryptObjectWithPassphrase('wrong', enc);
  } catch {
    threw = true;
  }
  ok(threw, '错误口令解密抛错(认证失败)');

  console.log('\n[2] bundle 校验');
  ok(assertBundle({ app: 'diary', version: 1 }).app === 'diary', '通过合法信封');
  let threw2 = false;
  try {
    assertBundle({ app: 'other', version: 1 });
  } catch {
    threw2 = true;
  }
  ok(threw2, '拒绝错误 app');
  let threw3 = false;
  try {
    assertBundle({ app: 'diary', version: 99 });
  } catch {
    threw3 = true;
  }
  ok(threw3, '拒绝未知版本');

  console.log('\n[3] LWW 合并语义(迁移合并与同步同源)');
  const a = { ...mk('id1', '2026-09-01T10:00:00Z'), content: '旧' };
  const b = { ...mk('id1', '2026-09-01T11:00:00Z'), content: '新' };
  ok(newerEntry(a, b) === b, 'newerEntry(a,b) 取较新的 b');
  ok(newerEntry(b, a) === b, 'newerEntry(b,a) 仍取较新的 b(顺序无关)');
  const merged = reconcileFull([a], [b]);
  ok(merged.length === 1 && merged[0].content === '新', 'reconcileFull 取新内容');

  // 墓碑传播:本地有新活条目,迁移包内是更新时间的墓碑 → 应采纳删除
  const live = { ...mk('id2', '2026-09-01T10:00:00Z') };
  const tomb = { ...mk('id2', '2026-09-01T12:00:00Z'), deletedAt: '2026-09-01T12:00:00Z' };
  const rec = reconcileFull([live], [tomb]);
  ok(rec.length === 1 && rec[0].deletedAt != null, '新墓碑(删除)在合并时保留');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
