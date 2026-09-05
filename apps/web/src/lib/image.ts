/** 把本地图片文件上传到服务器,返回可插入 Markdown 的 URL(/api/uploads/xxx)。 */
export async function uploadImage(file: File): Promise<string> {
  const dataUrl = await fileToDataUrl(file);
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `上传失败 (${res.status})`);
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

