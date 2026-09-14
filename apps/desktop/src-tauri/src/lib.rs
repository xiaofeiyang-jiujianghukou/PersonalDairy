use tauri::Manager;

/// 把一段媒体字节写成临时文件,并交给系统默认播放器打开。
///
/// 为什么需要:Linux 桌面端(WebKitGTK)在部分显卡(如这台 AMD)上渲染 H.264 视频会花屏,
/// 而文件本身解码完全正常(ffmpeg 校验零报错、抽帧画面正确)。与其继续调 WebKit 的渲染管线,
/// 不如把视频交给系统播放器 —— 那里必定正常,还能全屏/逐帧。
#[tauri::command]
fn open_media_file(name: String, data: Vec<u8>) -> Result<String, String> {
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let mut path = std::env::temp_dir();
    path.push(if safe.is_empty() { "diary-media.mp4".to_string() } else { safe });
    std::fs::write(&path, &data).map_err(|e| format!("写入临时文件失败:{e}"))?;

    #[cfg(target_os = "linux")]
    let opener = "xdg-open";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";

    std::process::Command::new(opener)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("调用系统播放器失败:{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![open_media_file])
        .setup(|app| {
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
