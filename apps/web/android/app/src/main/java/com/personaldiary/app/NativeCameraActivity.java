package com.personaldiary.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.video.FallbackStrategy;
import androidx.camera.video.FileOutputOptions;
import androidx.camera.video.PendingRecording;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生相机(微信式):
 *   - CameraX 实时预览(PreviewView, FILL_CENTER 铺满整屏,方向/比例由原生控制 → 无黑边、不会歪)
 *   - 轻触快门 → 拍照(ImageCapture)
 *   - 长按快门 → 录像(VideoCapture + Recorder,带声音)
 *   - 左上角 ✕ 关闭;⚡ 闪光灯;⟳ 前后置切换
 * 结果通过 setResult 返回文件路径 + mime。
 */
@OptIn(markerClass = androidx.camera.core.ExperimentalGetImage.class)
public class NativeCameraActivity extends AppCompatActivity {

    public static final String EXTRA_PATH = "path";
    public static final String EXTRA_MIME = "mime";

    private PreviewView previewView;
    private TextView hintView;
    private View torchBtn;
    private View shutterInner;
    private View shutterRing;
    private TextView torchIcon;

    private ProcessCameraProvider provider;
    private ImageCapture imageCapture;
    private VideoCapture<Recorder> videoCapture;
    private Recording recording;
    private Camera camera;
    private boolean backCamera = true;
    private boolean recordingNow = false;
    private boolean torchOn = false;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
    private Runnable longPressRunnable;
    private int seconds = 0;
    private Runnable tickRunnable;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(Color.BLACK);
        w.setNavigationBarColor(Color.BLACK);
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        buildUi();
        startCamera();
    }

    // ---------------- UI(代码构建,免去 XML 资源) ----------------
    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        root.addView(previewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 关闭(左上角,半透明,不挡画面)
        TextView close = new TextView(this);
        close.setText("✕");
        close.setTextColor(0xB3FFFFFF);
        close.setTextSize(26);
        close.setGravity(Gravity.CENTER);
        close.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        FrameLayout.LayoutParams closeLp = new FrameLayout.LayoutParams(dp(56), dp(56));
        closeLp.gravity = Gravity.TOP | Gravity.START;
        closeLp.topMargin = dp(18);
        closeLp.leftMargin = dp(8);
        close.setOnClickListener(v -> cancel());
        root.addView(close, closeLp);

        // 底部区域:提示 + 一行控制
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setGravity(Gravity.CENTER_HORIZONTAL);

        hintView = new TextView(this);
        hintView.setText("轻触拍照,长按摄像");
        hintView.setTextColor(0xEBFFFFFF);
        hintView.setTextSize(14);
        hintView.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        hintView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.bottomMargin = dp(16);
        bottom.addView(hintView, hintLp);

        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setGravity(Gravity.CENTER_VERTICAL);

        // ⚡ 闪光灯
        torchIcon = new TextView(this);
        torchIcon.setText("⚡");
        torchIcon.setTextSize(22);
        torchIcon.setTextColor(Color.WHITE);
        torchIcon.setGravity(Gravity.CENTER);
        torchIcon.setBackground(makeCircle(0x29FFFFFF));
        torchBtn = torchIcon;
        torchBtn.setOnClickListener(v -> toggleTorch());
        LinearLayout.LayoutParams sideLp = new LinearLayout.LayoutParams(dp(48), dp(48));
        controls.addView(torchBtn, sideLp);

        // 快门
        FrameLayout shutter = new FrameLayout(this);
        shutterRing = new View(this);
        shutterRing.setBackground(makeRing());
        shutter.addView(shutterRing, new FrameLayout.LayoutParams(dp(78), dp(78)));
        shutterInner = new View(this);
        shutterInner.setBackground(makeCircle(0xFFFFFFFF));
        FrameLayout.LayoutParams innerLp = new FrameLayout.LayoutParams(dp(62), dp(62));
        innerLp.gravity = Gravity.CENTER;
        shutter.addView(shutterInner, innerLp);
        LinearLayout.LayoutParams shutterLp = new LinearLayout.LayoutParams(dp(96), dp(96));
        shutterLp.leftMargin = dp(28);
        shutterLp.rightMargin = dp(28);
        controls.addView(shutter, shutterLp);

        // ⟳ 前后置
        TextView flip = new TextView(this);
        flip.setText("⟳");
        flip.setTextSize(22);
        flip.setTextColor(Color.WHITE);
        flip.setGravity(Gravity.CENTER);
        flip.setBackground(makeCircle(0x29FFFFFF));
        flip.setOnClickListener(v -> switchCamera());
        controls.addView(flip, sideLp);

        bottom.addView(controls);
        FrameLayout.LayoutParams bottomLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bottomLp.gravity = Gravity.BOTTOM;
        bottomLp.bottomMargin = dp(48);
        root.addView(bottom, bottomLp);

        setContentView(root);

        // 快门手势:轻触拍照 / 长按录像(350ms 触发录像,松开结束)
        shutter.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    longPressRunnable = () -> startRecording();
                    handler.postDelayed(longPressRunnable, 350);
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (longPressRunnable != null) {
                        handler.removeCallbacks(longPressRunnable);
                        longPressRunnable = null;
                    }
                    if (recordingNow) {
                        stopRecording();
                    } else {
                        takePhoto();
                    }
                    return true;
                default:
                    return false;
            }
        });
    }

    private android.graphics.drawable.GradientDrawable makeCircle(int color) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        d.setColor(color);
        return d;
    }

    private android.graphics.drawable.GradientDrawable makeRing() {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        d.setColor(Color.TRANSPARENT);
        d.setStroke(dp(4), Color.WHITE);
        return d;
    }

    private android.graphics.drawable.GradientDrawable makeRounded(int color) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
        d.setCornerRadius(dp(8));
        d.setColor(color);
        return d;
    }

    // ---------------- CameraX ----------------
    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                provider = future.get();
            } catch (Exception e) {
                finishWithError("相机初始化失败:" + e.getMessage());
                return;
            }
            bindUseCases();
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindUseCases() {
        if (provider == null) return;
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        imageCapture = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .build();

        Recorder recorder = new Recorder.Builder()
                .setQualitySelector(QualitySelector.fromOrderedList(
                        java.util.Arrays.asList(Quality.FHD, Quality.HD, Quality.SD),
                        FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
                .build();
        videoCapture = VideoCapture.withOutput(recorder);

        CameraSelector selector = backCamera
                ? CameraSelector.DEFAULT_BACK_CAMERA
                : CameraSelector.DEFAULT_FRONT_CAMERA;

        provider.unbindAll();
        try {
            camera = provider.bindToLifecycle(this, selector, preview, imageCapture, videoCapture);
        } catch (Exception e) {
            finishWithError("打开相机失败:" + e.getMessage());
            return;
        }
        torchOn = false;
        updateTorchIcon();
        boolean hasFlash = camera.getCameraInfo().hasFlashUnit();
        torchBtn.setEnabled(hasFlash);
        torchBtn.setAlpha(hasFlash ? 1f : 0.5f);
    }

    private void switchCamera() {
        if (recordingNow) return;
        backCamera = !backCamera;
        bindUseCases();
    }

    private void toggleTorch() {
        if (camera == null) return;
        boolean hasFlash = camera.getCameraInfo().hasFlashUnit();
        if (!hasFlash) {
            hintView.setText("这台设备没有闪光灯");
            handler.postDelayed(() -> hintView.setText("轻触拍照,长按摄像"), 1800);
            return;
        }
        torchOn = !torchOn;
        camera.getCameraControl().enableTorch(torchOn);
        updateTorchIcon();
    }

    private void updateTorchIcon() {
        torchIcon.setTextColor(torchOn ? 0xFFFFD479 : Color.WHITE);
    }

    // ---------------- 拍照 ----------------
    private void takePhoto() {
        if (imageCapture == null || recordingNow) return;
        File file = new File(getCacheDir(), "IMG_" + System.currentTimeMillis() + ".jpg");
        ImageCapture.OutputFileOptions opts =
                new ImageCapture.OutputFileOptions.Builder(file).build();
        imageCapture.takePicture(opts, ContextCompat.getMainExecutor(this),
                new ImageCapture.OnImageSavedCallback() {
                    @Override
                    public void onImageSaved(@NonNull ImageCapture.OutputFileResults outputFileResults) {
                        finishWith(file, "image/jpeg");
                    }

                    @Override
                    public void onError(@NonNull ImageCaptureException exception) {
                        finishWithError("拍照失败:" + exception.getMessage());
                    }
                });
    }

    // ---------------- 录像 ----------------
    private void startRecording() {
        if (videoCapture == null || recordingNow) return;
        File file = new File(getCacheDir(), "VID_" + System.currentTimeMillis() + ".mp4");
        FileOutputOptions opts = new FileOutputOptions.Builder(file).build();

        boolean withAudio = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;

        try {
            PendingRecording pending = videoCapture.getOutput()
                    .prepareRecording(this, opts);
            if (withAudio) pending = pending.withAudioEnabled();
            Recording started = pending.start(ContextCompat.getMainExecutor(this), event -> {
                if (event instanceof VideoRecordEvent.Finalize) {
                    VideoRecordEvent.Finalize f = (VideoRecordEvent.Finalize) event;
                    recordingNow = false;
                    stopTick();
                    restoreShutter();
                    if (f.getError() == VideoRecordEvent.Finalize.ERROR_NONE) {
                        finishWith(file, "video/mp4");
                    } else {
                        finishWithError("录像失败(error=" + f.getError() + ")");
                    }
                }
            });
            recording = started;
            recordingNow = true;
            seconds = 0;
            startTick();
            setShutterRecording(true);
        } catch (Exception e) {
            finishWithError("录像启动失败:" + e.getMessage());
        }
    }

    private void stopRecording() {
        if (recording != null) {
            recording.stop();
            recording = null;
        }
    }

    private void setShutterRecording(boolean on) {
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) shutterInner.getLayoutParams();
        int size = on ? dp(34) : dp(62);
        lp.width = size;
        lp.height = size;
        shutterInner.setLayoutParams(lp);
        shutterInner.setBackground(on ? makeRounded(0xFFFF3B30) : makeCircle(0xFFFFFFFF));
        hintView.setText(on ? "● 摄像中 " + seconds + "s · 松手结束" : "轻触拍照,长按摄像");
    }

    private void restoreShutter() {
        setShutterRecording(false);
    }

    private void startTick() {
        tickRunnable = new Runnable() {
            @Override
            public void run() {
                seconds++;
                if (recordingNow) {
                    hintView.setText("● 摄像中 " + seconds + "s · 松手结束");
                    handler.postDelayed(this, 1000);
                }
            }
        };
        handler.postDelayed(tickRunnable, 1000);
    }

    private void stopTick() {
        if (tickRunnable != null) {
            handler.removeCallbacks(tickRunnable);
            tickRunnable = null;
        }
    }

    // ---------------- 结果 ----------------
    private void finishWith(File file, String mime) {
        Intent data = new Intent();
        data.putExtra(EXTRA_PATH, file.getAbsolutePath());
        data.putExtra(EXTRA_MIME, mime);
        setResult(Activity.RESULT_OK, data);
        finish();
    }

    private void finishWithError(String message) {
        Intent data = new Intent();
        data.putExtra("error", message);
        setResult(Activity.RESULT_CANCELED, data);
        finish();
    }

    private void cancel() {
        setResult(Activity.RESULT_CANCELED);
        finish();
    }

    @Override
    protected void onDestroy() {
        try {
            if (recording != null) recording.stop();
            if (provider != null) provider.unbindAll();
        } catch (Exception ignored) {
        }
        executor.shutdown();
        super.onDestroy();
    }
}
