import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';
import { uploadMedia } from '../lib/image';
import { nativeCameraAvailable, takeWithNativeCamera } from '../lib/nativeCamera';
import ResolvedImage from './ResolvedImage';
import CameraCapture from './CameraCapture';
import { newId, type Block } from '../lib/blocks';

/**
 * 隐藏的测量用镜像 textarea:脱离文档流,专供测量内容所需的高度和光标位置,
 * 彻底避免直接对真实 textarea 设 `style.height = 'auto'` 导致的页面瞬间塌陷与跳到顶部 Bug。
 */
let mirrorTa: HTMLTextAreaElement | null = null;

function getMirrorTextarea(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null;
  if (!mirrorTa || !document.body.contains(mirrorTa)) {
    mirrorTa = document.createElement('textarea');
    mirrorTa.setAttribute('tabindex', '-1');
    mirrorTa.setAttribute('aria-hidden', 'true');
    mirrorTa.style.position = 'fixed';
    mirrorTa.style.top = '0';
    mirrorTa.style.left = '-9999px';
    mirrorTa.style.opacity = '0';
    mirrorTa.style.pointerEvents = 'none';
    mirrorTa.style.zIndex = '-9999';
    mirrorTa.style.height = '0';
    mirrorTa.style.minHeight = '0';
    mirrorTa.style.maxHeight = 'none';
    mirrorTa.style.overflow = 'hidden';
    mirrorTa.style.border = 'none';
    mirrorTa.style.padding = '0';
    mirrorTa.style.resize = 'none';
    mirrorTa.style.boxSizing = 'border-box';
    document.body.appendChild(mirrorTa);
  }
  return mirrorTa;
}

/** 文本块高度上限:约占可见区域的六成。超过就让文本框内部滚动,而不是把整页撑长。 */
function maxTextareaHeight(): number {
  if (typeof window === 'undefined') return 320;
  const visible = window.visualViewport?.height || window.innerHeight || 640;
  return Math.max(200, Math.round(visible * 0.6));
}

/** 需要复制到镜像上的排版样式(宽度单独设)。 */
const MIRROR_STYLE_KEYS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'wordBreak',
  'whiteSpace',
  'padding',
  'boxSizing',
] as const;

function applyMirrorStyle(mirror: HTMLTextAreaElement, el: HTMLTextAreaElement, width: number): void {
  const cs = window.getComputedStyle(el) as unknown as Record<string, string>;
  mirror.style.width = `${width}px`;
  for (const k of MIRROR_STYLE_KEYS) {
    mirror.style[k] = cs[k] ?? '';
  }
}

function syncTextareaHeight(el: HTMLTextAreaElement | null) {
  if (!el || typeof window === 'undefined') return;
  const mirror = getMirrorTextarea();
  if (!mirror) return;

  const width = el.clientWidth || el.getBoundingClientRect().width;
  if (width <= 0) return;

  applyMirrorStyle(mirror, el, width);
  mirror.value = el.value;
  if (el.value.endsWith('\n')) {
    mirror.value += ' ';
  }

  const contentHeight = Math.max(44, mirror.scrollHeight);
  const targetHeight = Math.min(contentHeight, maxTextareaHeight());
  if (Math.abs(el.offsetHeight - targetHeight) <= 1) return;

  /*
   * 高度变化会改变页面几何,浏览器可能自己挪动滚动位置。
   *
   * 关键:必须在**强制回流之后**再读 window.scrollY —— 直接读 scrollY 不会触发回流,
   * 拿到的还是重排前的旧值,于是"位置没变"的判断永远成立,那句"双重保险"形同虚设。
   * 以前写长文时页面被甩到顶部,就是这一处失效导致的。
   */
  const prevScrollY = window.scrollY;
  el.style.height = `${targetHeight}px`;
  void el.offsetHeight; // 强制同步回流,让下面的 scrollY 反映真实结果
  if (window.scrollY !== prevScrollY) {
    window.scrollTo({ top: prevScrollY, behavior: 'auto' });
  }
}

/**
 * 手机端输入时:保证光标始终在可视区域内(不被顶栏或软键盘遮挡)。
 *
 * 两条硬规则(都是为了根治"写长文时跳到页面顶部"):
 *   ① 文本框自己可滚(内容超过高度上限)时,光标在**文本框内部**的偏移要减掉 scrollTop ——
 *      否则算出来的是"内容坐标"而不是"屏幕坐标",纠正方向会完全错。
 *   ② 纠正幅度必须**夹紧**:任何测量异常都不允许一次把页面甩到顶/底。
 */
function ensureCaretInView(el: HTMLTextAreaElement | null) {
  if (!el || typeof window === 'undefined') return;
  if (document.activeElement !== el) return;

  const mirror = getMirrorTextarea();
  if (!mirror) return;

  const width = el.clientWidth || el.getBoundingClientRect().width;
  if (width <= 0) return;

  applyMirrorStyle(mirror, el, width);
  const caretPos = el.selectionEnd ?? el.value.length;
  mirror.value = el.value.slice(0, caretPos);
  if (mirror.value.endsWith('\n')) {
    mirror.value += ' ';
  }

  // 光标在内容里的偏移 → 减掉文本框自身的滚动 → 才是它在屏幕上的位置
  const contentOffset = mirror.scrollHeight;
  const innerScroll = el.scrollHeight > el.clientHeight + 1 ? el.scrollTop : 0;
  const caretClientY = el.getBoundingClientRect().top + (contentOffset - innerScroll);

  const vv = window.visualViewport;
  const viewportHeight = vv?.height || window.innerHeight;
  const viewportTop = vv?.offsetTop ?? 0;

  const topbarSafe = viewportTop + 60;
  const keyboardSafe = viewportTop + viewportHeight - 48;

  let delta = 0;
  if (caretClientY > keyboardSafe) delta = caretClientY - keyboardSafe;
  else if (caretClientY < topbarSafe) delta = caretClientY - topbarSafe;
  if (delta === 0) return;

  // 夹紧幅度:一次最多挪半屏,任何异常都不会把页面甩到最顶/最底
  const limit = Math.round(viewportHeight * 0.5);
  const clamped = Math.max(-limit, Math.min(limit, delta));
  window.scrollBy({ top: clamped, behavior: 'smooth' });
}

/**
 * 块编辑器:文字是可直接编辑的文本框,图片/视频是内联显示的真实媒体。
 * 粘贴/「＋ 图片/视频」(应用内相机 或 相册)后,媒体当场出现在文字中间,可在其上下继续写。
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
  const [showCamera, setShowCamera] = useState(false); // 应用内相机
  const pickRef = useRef<HTMLInputElement>(null); // 从相册选择(照片或视频)
  const taRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  /** 用 ref 保存 blocks,好让 syncAllHeights 保持稳定 —— 否则每敲一个字都会重新订阅 resize。 */
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const syncAllHeights = useCallback(() => {
    for (const b of blocksRef.current) {
      if (b.kind !== 'text') continue;
      const el = taRefs.current[b.id];
      if (el) syncTextareaHeight(el);
    }
  }, []);

  // blocks 变化时同步高度(绝不使用会造成塌陷跳顶的 height = 'auto')
  useEffect(() => {
    syncAllHeights();
  }, [blocks, syncAllHeights]);

  // 监听视口或窗口尺寸变动(如手机软键盘弹起、横竖屏切换)
  useEffect(() => {
    const onResize = () => syncAllHeights();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [syncAllHeights]);

  useEffect(() => {
    if (pendingFocus) {
      const ta = taRefs.current[pendingFocus];
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
        syncTextareaHeight(ta);
        ensureCaretInView(ta);
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
    insertAtEnd(file);
  }

  /** 把媒体插到最后一个文字块的末尾(相机拍完 / 相册选完都走这里)。 */
  function insertAtEnd(file: File) {
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
            onInput={(e) => {
              syncTextareaHeight(e.currentTarget);
              ensureCaretInView(e.currentTarget);
            }}
            onFocus={(e) => {
              const target = e.currentTarget;
              setTimeout(() => {
                syncTextareaHeight(target);
                ensureCaretInView(target);
              }, 150);
            }}
            onChange={(e) => updateText(b.id, e.target.value)}
            onPaste={(e) => handlePaste(e, i)}
            rows={1}
          />
        ),
      )}

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

      {/* 微信式:一个「拍摄」进应用内相机(轻触拍照、长按摄像),外加从相册选择 */}
      {mediaMenu && (
        <div className="media-sheet-mask" onClick={() => setMediaMenu(false)}>
          <div className="media-sheet" onClick={(e) => e.stopPropagation()}>
            <button
              className="media-sheet-item"
              onClick={() => {
                setMediaMenu(false);
                if (nativeCameraAvailable()) {
                  // Android:走原生相机(CameraX)——和微信一致,方向/比例原生控制
                  setUploading(true);
                  void takeWithNativeCamera()
                    .then((file) => {
                      if (file) insertAtEnd(file);
                    })
                    .catch((e) => {
                      const msg = String((e as Error)?.message ?? '');
                      if (/取消|cancel/i.test(msg)) return; // 用户取消:不打扰
                      alert(msg);
                    })
                    .finally(() => setUploading(false));
                } else {
                  setShowCamera(true); // 桌面端等:用 Web 相机兜底
                }
              }}
            >
              <span className="media-sheet-main">拍摄</span>
              <span className="media-sheet-sub">轻触拍照 · 长按摄像</span>
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

      {showCamera && (
        <CameraCapture
          onCapture={(file) => {
            setShowCamera(false);
            insertAtEnd(file);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}
    </div>
  );
}
