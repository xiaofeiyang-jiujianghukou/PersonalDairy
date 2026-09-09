import { parseFrom } from '../src/mail.js';

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

console.log('\n[1] SMTP_FROM 带显示名');
const a = parseFrom('PersonalDiary <15701209440@163.com>');
ok(a.addr === '15701209440@163.com', '信封地址(MAIL FROM)只取纯邮箱');
ok(a.header === 'PersonalDiary <15701209440@163.com>', 'From: 头保留显示名');

console.log('\n[2] 纯地址');
const b = parseFrom('15701209440@163.com');
ok(b.addr === '15701209440@163.com' && b.header === '15701209440@163.com', '纯地址两处一致');

console.log('\n[3] 前后空格 / 空值');
ok(parseFrom('  a@b.com  ').addr === 'a@b.com', '去除首尾空格');
ok(parseFrom('').addr === '' && parseFrom(undefined as never).addr === '', '空值安全');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
