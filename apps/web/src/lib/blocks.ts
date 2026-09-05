export type Block =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'image'; url: string };

let seq = 0;
export const newId = (): string => `b${Date.now().toString(36)}-${(seq++).toString(36)}`;

const IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

/** 把 Markdown 解析成「文本块 + 图片块」序列。 */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  IMAGE_RE.lastIndex = 0;
  while ((m = IMAGE_RE.exec(markdown)) !== null) {
    const text = markdown.slice(lastIndex, m.index);
    if (text.trim()) blocks.push({ id: newId(), kind: 'text', text: text.trim() });
    blocks.push({ id: newId(), kind: 'image', url: (m[1] ?? '').trim() });
    lastIndex = m.index + m[0].length;
  }
  const tail = markdown.slice(lastIndex);
  if (tail.trim()) blocks.push({ id: newId(), kind: 'text', text: tail.trim() });
  // 保证至少有一个文本块
  if (blocks.length === 0) blocks.push({ id: newId(), kind: 'text', text: '' });
  // 保证末尾是文本块,方便继续写
  if (blocks[blocks.length - 1]!.kind === 'image') {
    blocks.push({ id: newId(), kind: 'text', text: '' });
  }
  return blocks;
}

/** 把「文本块 + 图片块」序列序列化回 Markdown。 */
export function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => (b.kind === 'image' ? `![图片](${b.url})` : b.text.trim()))
    .filter((s) => s !== '')
    .join('\n\n');
}
