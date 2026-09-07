// 验证 syncCrypto 在 Node(全局 WebCrypto)下的加解密往返与格式。
import { encryptObject, decryptObject, generateSyncKey } from '../packages/shared/src/syncCrypto';

const key = generateSyncKey();
console.log('key 长度:', key.length);

const obj = { entries: [{ id: 'x', content: '你好 你好' }], applied: 3 };
const enc = await encryptObject(key, obj);
console.log('密文 iv 长度:', enc.iv.length, 'data 长度:', enc.data.length);

const back = await decryptObject(key, enc);
console.log('解密还原:', JSON.stringify(back), '| 一致?', JSON.stringify(back) === JSON.stringify(obj));

// 错误密钥应失败(认证)
try {
  await decryptObject('wrong-key', enc);
  console.log('错误密钥: 未拦截(异常)');
} catch {
  console.log('错误密钥: 正确拦截(认证失败)');
}
