import {
  makeDiaryVideoRef,
  makeDiaryImgRef,
  extractMediaIds,
  detectMediaMime,
  DIARY_VIDEO_PREFIX,
} from '@diary/shared/images';
import { parseBlocks, blocksToMarkdown } from '../../web/src/lib/blocks.js';

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

console.log('\n[1] 媒体引用助手');
const IMG = 'a'.repeat(16);
const VID = 'b'.repeat(16);
ok(makeDiaryVideoRef('abc').startsWith('diary-video:') && DIARY_VIDEO_PREFIX === 'diary-video:', '视频引用前缀 diary-video:');
ok(makeDiaryImgRef('abc').startsWith('diary-img:'), '图片引用前缀 diary-img:');
const md = `今天 ![图](diary-img:${IMG}) 心情 ![视频](diary-video:${VID}) 好`;
const ids = extractMediaIds(md);
ok(ids.includes(IMG) && ids.includes(VID) && ids.length === 2, 'extractMediaIds 抽中图片+视频');

console.log('\n[2] 媒体 MIME 探测');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
ok(detectMediaMime(png) === 'image/png', 'png → image/png');
const mp4 = new Uint8Array(20);
mp4[4] = 0x66; mp4[5] = 0x74; mp4[6] = 0x79; mp4[7] = 0x70; // 'ftyp' @ offset 4
ok(detectMediaMime(mp4) === 'video/mp4', 'mp4(ftyp) → video/mp4');
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
ok(detectMediaMime(webm) === 'video/webm', 'webm(EBML) → video/webm');

console.log('\n[3] 视频块往返(markdown ↔ blocks)');
const V = 'c'.repeat(16);
const doc = `第一段\n\n![视频](diary-video:${V})\n\n最后一段`;
const blocks = parseBlocks(doc);
ok(blocks.some((b) => b.kind === 'video' && b.url === `diary-video:${V}`), '解析出 video 块');
ok(blocks.some((b) => b.kind === 'text' && b.text.includes('第一段')), '解析出前文字');
ok(blocks.some((b) => b.kind === 'text' && b.text.includes('最后一段')), '解析出后文字');
const rt = blocksToMarkdown(blocks);
ok(rt.includes(`![视频](diary-video:${V})`), '序列化保留视频引用');

console.log('\n[4] 图片块仍正常');
const I = 'd'.repeat(16);
const imgDoc = `看图 ![图](diary-img:${I}) 结束`;
const imgBlocks = parseBlocks(imgDoc);
ok(imgBlocks.some((b) => b.kind === 'image'), '解析出 image 块');
ok(blocksToMarkdown(imgBlocks).includes(`![图片](diary-img:${I})`), '序列化保留图片引用(alt 归一为"图片")');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
