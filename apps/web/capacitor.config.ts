import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.personaldiary.app',
  appName: '我的日记',
  webDir: 'dist',
  server: {
    // 留空 = 打包前端为本地资源(默认)。
    // 若要让 APK 直连家里电脑上的日记服务,可临时设为
    // { url: 'http://192.168.x.x:4520', cleartext: true }
    androidScheme: 'https',
  },
};

export default config;
