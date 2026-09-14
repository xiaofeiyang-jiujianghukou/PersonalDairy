import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 点图放大:点击日记里的图片 → 铺满屏幕;再点一下(或按 Esc)→ 回到原来的位置。
 *
 * 实现要点:用 portal 挂到 body 上,避免被日记条目的容器裁剪(overflow/transform)。
 * 放大层只是覆盖在原图上,关闭时原图还在原处 —— 所以"回到原位"是天然的。
 */
export default function ImageViewer({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), 10); // 触发淡入
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // 放大时不滚动背景
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div className={`image-viewer${shown ? ' shown' : ''}`} onClick={onClose}>
      <img src={src} alt={alt || ''} className="image-viewer-img" />
    </div>,
    document.body,
  );
}
