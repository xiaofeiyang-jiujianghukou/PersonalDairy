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
  const [mediaMenu, setMediaMenu] = useState(false); // 微信式:一个入口 → 拍摄 / 从相册选择
  // Android 相机 Intent 必须指明"拍照"还是"录像"(accept 只能一种);混在一起会被系统退回文件选择器
  const photoRef = useRef<HTMLInputElement>(null); // 拍摄照片 -> ACTION_IMAGE_CAPTURE
  const videoRef = useRef<HTMLInputElement>(null); // 拍摄视频 -> ACTION_VIDEO_CAPTURE
  const pickRef = useRef<HTMLInputElement>(null); // 从相册选择(照片或视频)
  const pressStart = useRef(0); // 「拍摄」按下的时刻(用于区分轻点/长按)
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

      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={onPick}
      />
      <input
        ref={videoRef}
        type="file"
        accept="video/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={onPick}
      />
      <input
        ref={pickRef}
        type="file"
        accept="image/*,video/*"
        style={{ display: 'none' }}
        onChange={onPick}
      />

      <div className="blocks-toolbar">
        <button className="ghost" onClick={() => setMediaMenu(true)} disabled={uploading}>
          {uploading ? '处理中…' : '＋ 图片 / 视频'}
        </button>
      </div>

      {/* 微信式:一个「拍摄」——轻点拍照、长按录像;外加从相册选择。
          判定放在 pointerup(仍属用户激活),否则调起文件选择器会被浏览器拦截。 */}
      {mediaMenu && (
        <div className="media-sheet-mask" onClick={() => setMediaMenu(false)}>
          <div className="media-sheet" onClick={(e) => e.stopPropagation()}>
            <button
              className="media-sheet-item"
              onPointerDown={() => {
                pressStart.current = Date.now();
              }}
              onPointerUp={() => {
                const held = Date.now() - pressStart.current;
                pressStart.current = 0;
                setMediaMenu(false);
                if (held >= 400) videoRef.current?.click(); // 长按 → 录像
                else photoRef.current?.click(); // 轻点 → 拍照
              }}
              onPointerCancel={() => {
                pressStart.current = 0;
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <span className="media-sheet-main">拍摄</span>
              <span className="media-sheet-sub">轻点拍照 · 长按录像</span>
            </button>
            <button
              className="media-sheet-item"
              onClick={() => {
                setMediaMenu(false);
                pickRef.current?.click();
              }}
            >
              <span className="media-sheet-main">从手机相册选择</span>
              <span className="media-sheet-sub">照片或视频</span>
            </button>
            <button className="media-sheet-item cancel" onClick={() => setMediaMenu(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
