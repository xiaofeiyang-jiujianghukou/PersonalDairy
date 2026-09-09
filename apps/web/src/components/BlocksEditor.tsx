import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';
import { uploadMedia } from '../lib/image';
import ResolvedImage from './ResolvedImage';
import { newId, type Block } from '../lib/blocks';

/**
 * 块编辑器:文字是可直接编辑的文本框,图片/视频是内联显示的真实媒体。
 * 粘贴/按钮(拍照/相册/录像/视频)后,媒体当场出现在文字中间,可在其上下继续写。
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
  const imgUploadRef = useRef<HTMLInputElement>(null); // 相册选图
  const imgCaptureRef = useRef<HTMLInputElement>(null); // 拍照
  const vidUploadRef = useRef<HTMLInputElement>(null); // 视频文件
  const vidCaptureRef = useRef<HTMLInputElement>(null); // 录像
  const taRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

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

  function removeMedia(id: string) {
    onChange(blocks.filter((b) => b.id !== id));
  }

  async function insertMedia(index: number, start: number, end: number, file: File) {
    const block = blocks[index];
    if (!block || block.kind !== 'text') return;
    const before = block.text.slice(0, start);
    const after = block.text.slice(end);
    const afterId = newId();
    setUploading(true);
    try {
      const url = await uploadMedia(file);
      const kind: Block['kind'] = url.startsWith('diary-video:') ? 'video' : 'image';
      const next = [...blocks];
      const inserted: Block[] = [
        { id: block.id, kind: 'text', text: before },
        { id: newId(), kind, url },
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
        if (item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/'))) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void insertMedia(index, start, end, file);
            return;
          }
        }
      }
    }
    const file = cd.files?.[0];
    if (file && (file.type.startsWith('image/') || file.type.startsWith('video/'))) {
      e.preventDefault();
      void insertMedia(index, start, end, file);
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const last = blocks.length - 1;
    const lastBlock = blocks[last];
    if (lastBlock && lastBlock.kind === 'text') {
      void insertMedia(last, lastBlock.text.length, lastBlock.text.length, file);
    }
  }

  return (
    <div className="blocks-editor">
      {blocks.map((b, i) =>
        b.kind === 'image' || b.kind === 'video' ? (
          <div key={b.id} className="block-image">
            <ResolvedImage src={b.url} alt={b.kind === 'video' ? '视频' : '图片'} />
            <button
              className="block-image-remove"
              title="删除"
              onClick={() => removeMedia(b.id)}
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
              i === 0 ? '此刻,想写点什么……(支持 Markdown;可粘贴/插入图片或视频)' : '继续写……'
            }
            value={b.text}
            onChange={(e) => updateText(b.id, e.target.value)}
            onPaste={(e) => handlePaste(e, i)}
            rows={1}
          />
        ),
      )}

      <input ref={imgUploadRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPick} />
      <input ref={imgCaptureRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onPick} />
      <input ref={vidUploadRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={onPick} />
      <input ref={vidCaptureRef} type="file" accept="video/*" capture="environment" style={{ display: 'none' }} onChange={onPick} />

      <div className="blocks-toolbar">
        <button className="ghost" onClick={() => imgCaptureRef.current?.click()} disabled={uploading}>
          {uploading ? '处理中…' : '拍照'}
        </button>
        <button className="ghost" onClick={() => imgUploadRef.current?.click()} disabled={uploading}>
          相册
        </button>
        <button className="ghost" onClick={() => vidCaptureRef.current?.click()} disabled={uploading}>
          录像
        </button>
        <button className="ghost" onClick={() => vidUploadRef.current?.click()} disabled={uploading}>
          视频
        </button>
      </div>
    </div>
  );
}
