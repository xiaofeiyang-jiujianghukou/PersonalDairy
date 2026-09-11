package com.personaldiary.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;

/**
 * 原生相机插件:调起 NativeCameraActivity(CameraX)拍照/录像,
 * 返回文件绝对路径 + mime。JS 侧用 Capacitor.convertFileSrc() 读成 Blob 再上传入库。
 */
@CapacitorPlugin(
        name = "NativeCamera",
        permissions = {
                @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
                @Permission(alias = "audio", strings = { Manifest.permission.RECORD_AUDIO })
        })
public class NativeCameraPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "permCallback");
            return;
        }
        ensureAudioThenLaunch(call);
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("相机权限被拒绝");
            return;
        }
        ensureAudioThenLaunch(call);
    }

    /** 录像需要录音权限;被拒也能拍照(只是录像没声音),所以不拦截。 */
    private void ensureAudioThenLaunch(PluginCall call) {
        if (getPermissionState("audio") != PermissionState.GRANTED) {
            requestPermissionForAlias("audio", call, "audioPermCallback");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void audioPermCallback(PluginCall call) {
        launch(call);
    }

    private void launch(PluginCall call) {
        Intent intent = new Intent(getContext(), NativeCameraActivity.class);
        startActivityForResult(call, intent, "cameraResult");
    }

    /** 扫码:用同一个原生相机(扫码模式,ML Kit 识别二维码),返回识别到的文本。 */
    @PluginMethod
    public void scan(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "scanPermCallback");
            return;
        }
        launchScan(call);
    }

    @PermissionCallback
    private void scanPermCallback(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("相机权限被拒绝");
            return;
        }
        launchScan(call);
    }

    private void launchScan(PluginCall call) {
        Intent intent = new Intent(getContext(), NativeCameraActivity.class);
        intent.putExtra(NativeCameraActivity.EXTRA_MODE, "scan");
        startActivityForResult(call, intent, "scanResult");
    }

    @ActivityCallback
    private void scanResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("已取消");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("text", result.getData().getStringExtra(NativeCameraActivity.EXTRA_TEXT));
        call.resolve(ret);
    }

    @ActivityCallback
    private void cameraResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            String err = result.getData() != null ? result.getData().getStringExtra("error") : null;
            call.reject(err != null ? err : "已取消");
            return;
        }
        String path = result.getData().getStringExtra(NativeCameraActivity.EXTRA_PATH);
        String mime = result.getData().getStringExtra(NativeCameraActivity.EXTRA_MIME);
        JSObject ret = new JSObject();
        ret.put("path", path);
        ret.put("mime", mime);
        call.resolve(ret);
    }

    /**
     * 读取文件为 base64(兜底方案:若 WebView 直接 fetch convertFileSrc 失败时用)。
     * 大文件请优先用 convertFileSrc。
     */
    @PluginMethod
    public void readFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("缺少 path");
            return;
        }
        try {
            File f = new File(path);
            byte[] buf = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) {
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n <= 0) break;
                    off += n;
                }
            }
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(buf, Base64.NO_WRAP));
            ret.put("mime", call.getString("mime", "application/octet-stream"));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取失败:" + e.getMessage());
        }
    }
}
