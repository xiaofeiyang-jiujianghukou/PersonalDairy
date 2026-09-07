import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.personaldiary.app',
  appName: '我的日记',
  webDir: 'dist',
  server: {
    // androidScheme=http:让 App 内页面用 http 源(这样可安全访问局域网 http://的日记服务,避免 https→http 混合内容被拦截)
    androidScheme: 'http',
    // 允许访问明文(http)的局域网服务地址
    cleartext: true,
  },
};

export default config;
