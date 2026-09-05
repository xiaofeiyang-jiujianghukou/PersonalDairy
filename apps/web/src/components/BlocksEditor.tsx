import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';
import { uploadImage } from '../lib/image';
import { newId, type Block } from '../lib/blocks';

/**
 * 块编辑器:文字是可直接编辑的文本框,图片是内联显示的真实图片。
 * 粘贴/选图后,图片当场出现在文字中间,可在其上下继续写。
 */
export default function BlocksEditor({
  blocks,
  onChange,
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  // 每次 blocks 变化后,重算各文本框高度(自动增高)
  useEffect(() => {
    for (const b of blocks) {
      if (b.kind !== 'text') continue;
      const el = taRefs.current[b.id];
      if (el) {
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
      }
    }
  }, [blocks]);

  // 图片插入后,把焦点放到图片下方的文本框
  useEffect(() => {
    if (pendingFocus) {
      const ta = taRefs.current[pendingFocus];
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
      }
      setPendingFocus(null);
    }
  }, [pendingFocus]);

  function updateText(id: string, text: string) {
    onChange(blocks.map((b) => (b.id === id ? { ...b, text } : b)));
  }

  function removeImage(id: string) {
    onChange(blocks.filter((b) => b.id !== id));
  }

  async function insertImage(index: number, start: number, end: number, file: File) {
    const block = blocks[index];
    if (!block || block.kind !== 'text') return;
    const before = block.text.slice(0, start);
    const after = block.text.slice(end);
    const afterId = newId();
    setUploading(true);
    try {
      const url = await uploadImage(file);
      const next = [...blocks];
      const inserted: Block[] = [
        { id: block.id, kind: 'text', text: before },
        { id: newId(), kind: 'image', url },
        { id: afterId, kind: 'text', text: after },
      ];
      next.splice(index, 1, ...inserted);
      onChange(next);
      setPendingFocus(afterId);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>, index: number) {
    const cd = e.clipboardData;
    if (!cd) return;
    const block = blocks[index];
    if (!block || block.kind !== 'text') return;
    const ta = taRefs.current[block.id];
    const start = ta?.selectionStart ?? block.text.length;
    const end = ta?.selectionEnd ?? start;

    const items = cd.items;
    if (items) {
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void insertImage(index, start, end, file);
            return;
          }
        }
      }
    }
    const file = cd.files?.[0];
    if (file && file.type.startsWith('image/')) {
      e.preventDefault();
      void insertImage(index, start, end, file);
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const last = blocks.length - 1;
    const lastBlock = blocks[last];
    if (lastBlock && lastBlock.kind === 'text') {
      void insertImage(last, lastBlock.text.length, lastBlock.text.length, file);
    }
  }

  return (
    <div className="blocks-editor">
      {blocks.map((b, i) =>
        b.kind === 'image' ? (
          <div key={b.id} className="block-image">
            <img src={b.url} alt="图片" />
            <button
              className="block-image-remove"
              title="删除图片"
              onClick={() => removeImage(b.id)}
            >
              ×
            </button>
          </div>
        ) : (
          <textarea
            key={b.id}
            ref={(el) => {
              taRefs.current[b.id] = el;
            }}
            className="block-textarea"
            placeholder={
              i === 0 ? '此刻,想写点什么……(支持 Markdown;可直接粘贴图片)' : '继续写……'
            }
            value={b.text}
            onChange={(e) => updateText(b.id, e.target.value)}
            onPaste={(e) => handlePaste(e, i)}
            rows={1}
          />
        ),
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onPick}
      />
      <div className="blocks-toolbar">
        <button className="ghost" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? '上传中…' : '图片'}
        </button>
      </div>
    </div>
  );
}
