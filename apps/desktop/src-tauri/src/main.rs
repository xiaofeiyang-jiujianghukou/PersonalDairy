fn main() {
    /*
     * Linux(WebKitGTK)下的两个渲染开关 —— 必须在创建 WebView **之前** 设置。
     *
     * 背景:这台机器是 AMD 平台,WebKitGTK 默认走 DMABUF 渲染路径,播放 H.264 视频时
     * 会出现"控件正常、画面绿条纹花屏"的现象(文件本身用 ffmpeg 解码零报错,
     * 而且 Android 端播放同一文件完全正常 —— 所以问题在 WebKit 的渲染管线,不在文件)。
     * 关掉 DMABUF 与合成模式走兼容路径即可正常显示。
     */
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    personal_diary_desktop_lib::run()
}
