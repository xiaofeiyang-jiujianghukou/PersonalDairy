/** 统一 fetch:桌面(Tauri)走原生 HTTP 插件(绕过 webview CORS/大小限制);其它走浏览器 fetch。 */
let tauriFetch: typeof fetch | null = null;

function isTauri(): boolean {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__);
}

/** 获取当前环境可用的 fetch。 */
export async function getFetch(): Promise<typeof fetch> {
  if (isTauri()) {
    if (!tauriFetch) {
      const m = await import('@tauri-apps/plugin-http');
      tauriFetch = m.fetch;
    }
    return tauriFetch;
  }
  return globalThis.fetch;
}
