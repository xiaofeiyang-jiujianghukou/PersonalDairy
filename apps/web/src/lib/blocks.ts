export type Block =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'image'; url: string };

let seq = 0;
export const newId = (): string => `b${Date.now().toString(36)}-${(seq++).toString(36)}`;

const IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

/** 把 Markdown 解析成「文本块 + 图片块」序列。保留段内换行与缩进,仅在整段为空时跳过。 */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  IMAGE_RE.lastIndex = 0;
  while ((m = IMAGE_RE.exec(markdown)) !== null) {
    const text = markdown.slice(lastIndex, m.index);
    if (text.trim()) blocks.push({ id: newId(), kind: 'text', text });
    blocks.push({ id: newId(), kind: 'image', url: (m[1] ?? '').trim() });
    lastIndex = m.index + m[0].length;
  }
  const tail = markdown.slice(lastIndex);
  if (tail.trim()) blocks.push({ id: newId(), kind: 'text', text: tail });
  // 保证至少有一个文本块
  if (blocks.length === 0) blocks.push({ id: newId(), kind: 'text', text: '' });
  // 保证末尾是文本块,方便继续写
  if (blocks[blocks.length - 1]!.kind === 'image') {
    blocks.push({ id: newId(), kind: 'text', text: '' });
  }
  return blocks;
}

/** 把「文本块 + 图片块」序列序列化回 Markdown。保留段内换行与缩进(不 trim),仅跳过空段。 */
export function blocksToMarkdown(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'image') {
      parts.push(`![图片](${b.url})`);
      continue;
    }
    if (!b.text.trim()) continue;
    parts.push(b.text);
  }
  return parts.join('\n\n');
}
