import { useEffect, useState } from 'react';
import { resolveMediaRef } from '../lib/image';

/** 把媒体引用(diary-video:/diary-img:/uploads/url/data URL)异步解析为可显示 URL。
 *  视频引用渲染为 <video>,图片渲染为 <img>。 */
export default function ResolvedImage({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isVideo = !!src && src.startsWith('diary-video:');

  useEffect(() => {
    let alive = true;
    let objectUrl = '';
    setUrl(null);
    setFailed(false);
    if (!src) {
      setFailed(true);
      return;
    }
    resolveMediaRef(src)
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

  if (failed) return <span className="img-broken">{isVideo ? '视频' : '图片'}</span>;
  if (!url) return <span className="img-loading">{isVideo ? '视频…' : '图片…'}</span>;
  return isVideo ? (
    <video className="img video" src={url} controls playsInline />
  ) : (
    <img className="img" src={url} alt={alt || ''} />
  );
}
