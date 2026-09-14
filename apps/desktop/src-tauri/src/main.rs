fn main() {
    /*
     * Linux(WebKitGTK)视频播放的两个开关 —— 必须在创建 WebView **之前** 设置。
     *
     * 症状:H.264 视频在 App 内播放时"控件正常、画面绿条纹花屏",而同一个文件
     * ffmpeg 解码零报错、抽帧画面正确,安卓端播放也完全正常 —— 问题在 WebKit 的渲染/解码管线。
     *
     * 这台机器装着 AMD 的硬件解码器(vaapih264dec / vah264dec),WebKitGTK 默认优先用它,
     * 而 AMD 的 VA-API 软硬件组合出绿条纹是已知问题。这里强制走软件解码(avdec_h264),
     * 并关掉 DMABUF 渲染路径,尽量回到兼容路线。
     */
    std::env::set_var("GST_PLUGIN_FEATURE_RANK", "avdec_h264:MAX");
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    personal_diary_desktop_lib::run()
}
