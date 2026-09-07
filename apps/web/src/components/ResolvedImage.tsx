import { useEffect, useState } from 'react';
import { resolveImageRef } from '../lib/image';

/** 把图片引用(diary-img:<hash>/uploads/url/data URL)异步解析为可显示 URL。 */
export default function ResolvedImage({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let objectUrl = '';
    setUrl(null);
    setFailed(false);
    if (!src) {
      setFailed(true);
      return;
    }
    resolveImageRef(src)
      .then((u) => {
        if (!alive) return;
        if (u) {
          objectUrl = u;
          setUrl(u);
        } else {
          setFailed(true);
        }
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed) return <span className="img-broken">图片</span>;
  if (!url) return <span className="img-loading">图片…</span>;
  return <img className="img" src={url} alt={alt || ''} />;
}
