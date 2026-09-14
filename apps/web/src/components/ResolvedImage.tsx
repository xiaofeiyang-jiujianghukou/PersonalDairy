import { useEffect, useState } from 'react';
import { resolveMediaRef } from '../lib/image';
import ImageViewer from './ImageViewer';

/**
 * 桌面端(Linux/WebKitGTK)在部分显卡上渲染 H.264 会花屏 —— 文件本身没问题
 * (ffmpeg 校验零报错、抽帧画面正确)。所以桌面端不内嵌播放,改为把视频交给系统播放器。
 */

/** 把媒体引用(diary-video:/diary-img:/uploads/url/data URL)异步解析为可显示 URL。
 *  视频引用渲染为 <video>,图片渲染为 <img>。 */
export default function ResolvedImage({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isVideo = !!src && src.startsWith('diary-video:');
  const [zoomed, setZoomed] = useState(false);


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
    <>
      {/* 点击放大铺满屏幕,再点回到原位 */}
      <img className="img zoomable" src={url} alt={alt || ''} onClick={() => setZoomed(true)} />
      {zoomed && <ImageViewer src={url} alt={alt} onClose={() => setZoomed(false)} />}
    </>
  );
}
