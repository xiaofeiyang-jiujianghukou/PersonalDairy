package com.personaldiary.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册原生相机插件(必须在 super.onCreate 之前)
        registerPlugin(NativeCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
