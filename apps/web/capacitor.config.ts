import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.personaldiary.app',
  appName: '我的日记',
  webDir: 'dist',
  server: {
    // androidScheme/iosScheme 都用 http:让 App 内页面跑在 http://localhost 源上。
    // 两个原因:① 可安全访问局域网 http:// 的日记服务(避免 https→http 混合内容被拦);
    // ② http://localhost 在规范里属于**安全上下文**,WebView 才会提供 navigator.mediaDevices
    //    (iOS 上如果不改,页面源是 capacitor://localhost,相机 API 可能直接不可用)。
    androidScheme: 'http',
    iosScheme: 'http',
    // 允许访问明文(http)的局域网服务地址
    cleartext: true,
  },
};

export default config;
