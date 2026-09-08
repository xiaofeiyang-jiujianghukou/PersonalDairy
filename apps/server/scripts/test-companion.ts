import { buildCompanionContext, buildCompanionMessages } from '../src/ai/companion.js';
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

const mk = (id: string, date: string, content: string): Entry => ({
  id,
  date,
  content,
  createdAt: `${date}T10:00:00Z`,
  updatedAt: `${date}T10:00:00Z`,
  deletedAt: null,
});

console.log('\n[1] 对话上下文构建');
const ctx = buildCompanionContext([
  mk('a', '2026-09-02', '今天去了公园 ![图](diary-img:abc) 心情不错'),
  mk('b', '2026-09-01', '第一天运动'),
]);
ok(ctx.includes('【2026-09-01】'), '按日期排序先旧后新');
ok(ctx.indexOf('2026-09-01') < ctx.indexOf('2026-09-02'), '排序正确');
ok(!ctx.includes('diary-img:'), '内嵌图片引用被替换为占位');
ok(ctx.includes('[图片]'), '图片占位出现');
ok(ctx.includes('第一天运动') && ctx.includes('心情不错'), '正文保留');

console.log('\n[2] 对话消息构建');
const msgs = buildCompanionMessages(
  [mk('a', '2026-09-02', '今天很充实')],
  [
    { role: 'user', content: '我最近怎么样?' },
    { role: 'assistant', content: '你最近写了不少。' },
    { role: 'user', content: '今天有点累' },
  ],
);
ok(msgs.length === 4, 'system + 3 条对话');
ok(msgs[0].role === 'system' && (msgs[0].content as string).includes('日记'), '首条为 system 且含背景');
ok((msgs[0].content as string).includes('今天很充实'), '背景嵌入了日记正文');
ok(msgs[msgs.length - 1].role === 'user', '以用户消息结尾');
ok((msgs[msgs.length - 1].content as string) === '今天有点累', '最后一条为用户原话');

console.log('\n[3] 空/非法消息过滤');
const filtered = buildCompanionMessages([], [
  { role: 'assistant', content: '' },
  { role: 'user', content: '  ' },
  { role: 'user', content: 'hi' },
]);
ok(filtered.length === 2 && (filtered[1].content as string) === 'hi', '过滤空白/非法后剩 system + 1 条用户消息');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
