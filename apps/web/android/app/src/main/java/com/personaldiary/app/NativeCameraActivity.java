package com.personaldiary.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ExperimentalGetImage;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.core.UseCaseGroup;
import androidx.camera.core.ViewPort;
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
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.io.File;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 原生相机(CameraX)—— 只做两件事:轻触拍照、长按录像。
 * 拍完直接把文件路径交给插件(不经过任何编辑页)。
 *
 * 保留的最小功能:点按对焦、⚡ 启用/禁用闪光灯、⟳ 前后置、✕ 退出。
 */
public class NativeCameraActivity extends AppCompatActivity {

    public static final String EXTRA_PATH = "path";
    public static final String EXTRA_MIME = "mime";
    public static final String EXTRA_MODE = "mode";   // "scan" = 扫码模式
    public static final String EXTRA_TEXT = "text";   // 扫码结果

    private PreviewView previewView;
    private TextView hintView;
    private ImageView flashBtn;
    private View shutterInner;
    private View focusRing;

    private boolean scanMode = false;
    private boolean scanHandled = false;
    private ImageAnalysis imageAnalysis;
    private BarcodeScanner barcodeScanner;
    private ExecutorService analysisExecutor;

    private ProcessCameraProvider provider;
    private ImageCapture imageCapture;
    private VideoCapture<Recorder> videoCapture;
    private Recording recording;
    private Camera camera;
    private boolean backCamera = true;
    private boolean recordingNow = false;
    private boolean flashOn = false;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable longPressRunnable;
    private Runnable tickRunnable;
    private int seconds = 0;

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(Color.BLACK);
        w.setNavigationBarColor(Color.BLACK);
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        scanMode = "scan".equals(getIntent().getStringExtra(EXTRA_MODE));
        buildUi();
        startCamera();
    }

    private ImageView icon(int resId) {
        ImageView v = new ImageView(this);
        v.setImageResource(resId);
        v.setColorFilter(Color.WHITE);
        return v;
    }

    // ==================== UI ====================
    private void buildUi() {
        if (scanMode) {
            buildScanUi();
            return;
        }
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        root.addView(previewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 点按对焦的提示圈
        focusRing = new View(this);
        android.graphics.drawable.GradientDrawable ring = new android.graphics.drawable.GradientDrawable();
        ring.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        ring.setColor(Color.TRANSPARENT);
        ring.setStroke(dp(2), Color.WHITE);
        focusRing.setBackground(ring);
        focusRing.setAlpha(0f);
        focusRing.setLayoutParams(new FrameLayout.LayoutParams(dp(72), dp(72)));
        root.addView(focusRing);

        // 左上角 ✕
        ImageView close = icon(R.drawable.ic_close);
        close.setAlpha(0.75f);
        close.setPadding(dp(14), dp(14), dp(14), dp(14));
        FrameLayout.LayoutParams closeLp = new FrameLayout.LayoutParams(dp(52), dp(52));
        closeLp.gravity = Gravity.TOP | Gravity.START;
        closeLp.topMargin = dp(16);
        closeLp.leftMargin = dp(8);
        close.setOnClickListener(v -> cancel());
        root.addView(close, closeLp);

        // 底部:提示 + 控制行(⚡ 贴左、快门居中、⟳ 贴右)
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setGravity(Gravity.CENTER_HORIZONTAL);

        hintView = new TextView(this);
        hintView.setText("轻触拍照,长按摄像");
        hintView.setTextColor(0xEBFFFFFF);
        hintView.setTextSize(14);
        hintView.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.bottomMargin = dp(20);
        bottom.addView(hintView, hintLp);

        FrameLayout controls = new FrameLayout(this);
        controls.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(96)));

        // 快门
        FrameLayout shutter = new FrameLayout(this);
        View shutterRing = new View(this);
        android.graphics.drawable.GradientDrawable sr = new android.graphics.drawable.GradientDrawable();
        sr.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        sr.setColor(Color.TRANSPARENT);
        sr.setStroke(dp(3), Color.WHITE);
        shutterRing.setBackground(sr);
        FrameLayout.LayoutParams ringLp = new FrameLayout.LayoutParams(dp(76), dp(76));
        ringLp.gravity = Gravity.CENTER;
        shutter.addView(shutterRing, ringLp);

        shutterInner = new View(this);
        android.graphics.drawable.GradientDrawable dot = new android.graphics.drawable.GradientDrawable();
        dot.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        dot.setColor(Color.WHITE);
        shutterInner.setBackground(dot);
        FrameLayout.LayoutParams innerLp = new FrameLayout.LayoutParams(dp(62), dp(62));
        innerLp.gravity = Gravity.CENTER;
        shutter.addView(shutterInner, innerLp);

        FrameLayout.LayoutParams shutterLp = new FrameLayout.LayoutParams(dp(96), dp(96));
        shutterLp.gravity = Gravity.CENTER;
        controls.addView(shutter, shutterLp);

        // ⚡ 左
        flashBtn = icon(R.drawable.ic_flash_on);
        flashBtn.setPadding(dp(12), dp(12), dp(12), dp(12));
        FrameLayout.LayoutParams flashLp = new FrameLayout.LayoutParams(dp(52), dp(52));
        flashLp.gravity = Gravity.START | Gravity.CENTER_VERTICAL;
        flashLp.leftMargin = dp(34);
        flashBtn.setOnClickListener(v -> toggleFlash());
        controls.addView(flashBtn, flashLp);

        // ⟳ 右
        ImageView flip = icon(R.drawable.ic_flip);
        flip.setPadding(dp(12), dp(12), dp(12), dp(12));
        FrameLayout.LayoutParams flipLp = new FrameLayout.LayoutParams(dp(52), dp(52));
        flipLp.gravity = Gravity.END | Gravity.CENTER_VERTICAL;
        flipLp.rightMargin = dp(34);
        flip.setOnClickListener(v -> switchCamera());
        controls.addView(flip, flipLp);

        bottom.addView(controls);
        FrameLayout.LayoutParams bottomLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bottomLp.gravity = Gravity.BOTTOM;
        bottomLp.bottomMargin = dp(40);
        root.addView(bottom, bottomLp);

        setContentView(root);

        previewView.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_UP) focusAt(e.getX(), e.getY());
            return true;
        });

        shutter.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    longPressRunnable = this::startRecording;
                    handler.postDelayed(longPressRunnable, 350);
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (longPressRunnable != null) {
                        handler.removeCallbacks(longPressRunnable);
                        longPressRunnable = null;
                    }
                    if (recordingNow) stopRecording();
                    else takePhoto();
                    return true;
                default:
                    return false;
            }
        });

        updateFlashIcon();
    }

    /** 扫码界面:预览 + 取景框 + 提示 + ✕(没有快门/闪光灯,只负责扫)。 */
    private void buildScanUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        root.addView(previewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 取景框(正方形,四角白色)
        View frame = new View(this);
        android.graphics.drawable.GradientDrawable fd = new android.graphics.drawable.GradientDrawable();
        fd.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
        fd.setColor(Color.TRANSPARENT);
        fd.setStroke(dp(3), 0xFFFFFFFF);
        fd.setCornerRadius(dp(12));
        frame.setBackground(fd);
        FrameLayout.LayoutParams frameLp = new FrameLayout.LayoutParams(dp(240), dp(240));
        frameLp.gravity = Gravity.CENTER;
        root.addView(frame, frameLp);

        TextView tip = new TextView(this);
        tip.setText("将二维码放入框内");
        tip.setTextColor(0xEBFFFFFF);
        tip.setTextSize(14);
        tip.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        tip.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams tipLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tipLp.gravity = Gravity.CENTER_HORIZONTAL;
        tipLp.topMargin = dp(320);
        root.addView(tip, tipLp);

        ImageView close = icon(R.drawable.ic_close);
        close.setAlpha(0.75f);
        close.setPadding(dp(14), dp(14), dp(14), dp(14));
        FrameLayout.LayoutParams closeLp = new FrameLayout.LayoutParams(dp(52), dp(52));
        closeLp.gravity = Gravity.TOP | Gravity.START;
        closeLp.topMargin = dp(24);
        closeLp.leftMargin = dp(12);
        close.setOnClickListener(v -> cancel());
        root.addView(close, closeLp);

        setContentView(root);
        // 点按对焦(扫屏幕上的码时有用)
        previewView.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_UP) focusScanAt(e.getX(), e.getY());
            return true;
        });
    }

    private void focusScanAt(float x, float y) {
        if (camera == null) return;
        try {
            MeteringPoint point = previewView.getMeteringPointFactory().createPoint(x, y);
            camera.getCameraControl().startFocusAndMetering(new FocusMeteringAction.Builder(
                    point, FocusMeteringAction.FLAG_AF).setAutoCancelDuration(2, TimeUnit.SECONDS).build());
        } catch (Exception ignored) {
        }
    }

    /** 二维码分析器:识别到就把内容回传,并结束。 */
    private class QrAnalyzer implements ImageAnalysis.Analyzer {
        @Override
        @ExperimentalGetImage
        public void analyze(@NonNull ImageProxy image) {
            if (scanHandled) {
                image.close();
                return;
            }
            android.media.Image media = image.getImage();
            if (media == null) {
                image.close();
                return;
            }
            InputImage input = InputImage.fromMediaImage(media, image.getImageInfo().getRotationDegrees());
            barcodeScanner.process(input)
                    .addOnSuccessListener(barcodes -> {
                        for (Barcode b : barcodes) {
                            String raw = b.getRawValue();
                            if (raw != null && !raw.trim().isEmpty()) {
                                scanHandled = true;
                                finishWithText(raw.trim());
                                return;
                            }
                        }
                    })
                    .addOnCompleteListener(task -> image.close());
        }
    }

    private void finishWithText(String text) {
        Intent data = new Intent();
        data.putExtra(EXTRA_TEXT, text);
        setResult(Activity.RESULT_OK, data);
        finish();
    }

    private void focusAt(float x, float y) {
        if (camera == null) return;
        try {
            MeteringPoint point = previewView.getMeteringPointFactory().createPoint(x, y);
            camera.getCameraControl().startFocusAndMetering(new FocusMeteringAction.Builder(
                    point, FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                    .setAutoCancelDuration(3, TimeUnit.SECONDS)
                    .build());
        } catch (Exception ignored) {
        }
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) focusRing.getLayoutParams();
        lp.leftMargin = Math.round(x - dp(36));
        lp.topMargin = Math.round(y - dp(36));
        focusRing.setLayoutParams(lp);
        focusRing.animate().cancel();
        focusRing.setAlpha(0.9f);
        focusRing.animate().alpha(0f).setDuration(700).start();
    }

    // ==================== CameraX ====================
    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                provider = future.get();
            } catch (Exception e) {
                finishWithError("相机初始化失败:" + e.getMessage());
                return;
            }
            // 等预览布局完成,拿到有效 ViewPort → 拍照/录像按预览比例裁剪(所见即所得)
            previewView.post(this::bindUseCases);
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindUseCases() {
        if (provider == null) return;
        if (scanMode) {
            bindScanUseCases();
            return;
        }
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        imageCapture = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .setFlashMode(flashOn ? ImageCapture.FLASH_MODE_ON : ImageCapture.FLASH_MODE_OFF)
                .build();

        Recorder recorder = new Recorder.Builder()
                .setQualitySelector(QualitySelector.fromOrderedList(
                        Arrays.asList(Quality.FHD, Quality.HD, Quality.SD),
                        FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
                .build();
        videoCapture = VideoCapture.withOutput(recorder);

        CameraSelector selector = backCamera
                ? CameraSelector.DEFAULT_BACK_CAMERA
                : CameraSelector.DEFAULT_FRONT_CAMERA;

        provider.unbindAll();
        try {
            ViewPort vp = previewView.getViewPort();
            if (vp != null) {
                UseCaseGroup group = new UseCaseGroup.Builder()
                        .addUseCase(preview)
                        .addUseCase(imageCapture)
                        .addUseCase(videoCapture)
                        .setViewPort(vp)
                        .build();
                camera = provider.bindToLifecycle(this, selector, group);
            } else {
                camera = provider.bindToLifecycle(this, selector, preview, imageCapture, videoCapture);
            }
        } catch (Exception e) {
            finishWithError("打开相机失败:" + e.getMessage());
        }
    }

    /** 扫码模式:预览 + 图像分析(ML Kit 识别二维码)。 */
    private void bindScanUseCases() {
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        if (barcodeScanner == null) {
            barcodeScanner = BarcodeScanning.getClient(new BarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                    .build());
        }
        if (analysisExecutor == null) analysisExecutor = Executors.newSingleThreadExecutor();

        imageAnalysis = new ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build();
        imageAnalysis.setAnalyzer(analysisExecutor, new QrAnalyzer());

        provider.unbindAll();
        try {
            ViewPort vp = previewView.getViewPort();
            UseCaseGroup.Builder b = new UseCaseGroup.Builder()
                    .addUseCase(preview)
                    .addUseCase(imageAnalysis);
            if (vp != null) b.setViewPort(vp);
            camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, b.build());
        } catch (Exception e) {
            finishWithError("打开相机失败:" + e.getMessage());
        }
    }

    private void switchCamera() {
        if (recordingNow) return;
        backCamera = !backCamera;
        bindUseCases();
    }

    /** ⚡ = 启用/禁用【拍照闪光灯】(不是常亮手电筒)。 */
    private void toggleFlash() {
        if (camera == null || imageCapture == null) return;
        if (!camera.getCameraInfo().hasFlashUnit()) {
            toast("这台摄像头没有闪光灯");
            return;
        }
        flashOn = !flashOn;
        imageCapture.setFlashMode(flashOn ? ImageCapture.FLASH_MODE_ON : ImageCapture.FLASH_MODE_OFF);
        updateFlashIcon();
    }

    private void updateFlashIcon() {
        flashBtn.setImageResource(flashOn ? R.drawable.ic_flash_on : R.drawable.ic_flash_off);
        flashBtn.setAlpha(flashOn ? 1f : 0.6f);
    }

    private void toast(String text) {
        hintView.setText(text);
        handler.postDelayed(() -> {
            if (!recordingNow) hintView.setText("轻触拍照,长按摄像");
        }, 1800);
    }

    // ==================== 拍照 / 录像 ====================
    private void takePhoto() {
        if (imageCapture == null || recordingNow) return;
        File file = new File(getCacheDir(), "IMG_" + System.currentTimeMillis() + ".jpg");
        ImageCapture.OutputFileOptions opts = new ImageCapture.OutputFileOptions.Builder(file).build();
        imageCapture.takePicture(opts, ContextCompat.getMainExecutor(this),
                new ImageCapture.OnImageSavedCallback() {
                    @Override
                    public void onImageSaved(@NonNull ImageCapture.OutputFileResults r) {
                        finishWith(file, "image/jpeg"); // 不做编辑,直接交给日记
                    }

                    @Override
                    public void onError(@NonNull ImageCaptureException e) {
                        finishWithError("拍照失败:" + e.getMessage());
                    }
                });
    }

    private void startRecording() {
        if (videoCapture == null || recordingNow) return;
        File file = new File(getCacheDir(), "VID_" + System.currentTimeMillis() + ".mp4");
        FileOutputOptions opts = new FileOutputOptions.Builder(file).build();
        boolean withAudio = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        try {
            PendingRecording pending = videoCapture.getOutput().prepareRecording(this, opts);
            if (withAudio) pending = pending.withAudioEnabled();
            recording = pending.start(ContextCompat.getMainExecutor(this), event -> {
                if (event instanceof VideoRecordEvent.Finalize) {
                    VideoRecordEvent.Finalize f = (VideoRecordEvent.Finalize) event;
                    recordingNow = false;
                    stopTick();
                    setShutterRecording(false);
                    if (f.getError() == VideoRecordEvent.Finalize.ERROR_NONE) finishWith(file, "video/mp4");
                    else finishWithError("录像失败(error=" + f.getError() + ")");
                }
            });
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
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        if (on) {
            d.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
            d.setCornerRadius(dp(8));
            d.setColor(0xFFFF3B30);
        } else {
            d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
            d.setColor(Color.WHITE);
        }
        shutterInner.setBackground(d);
        hintView.setText(on ? ("● 摄像中 " + seconds + "s · 松手结束") : "轻触拍照,长按摄像");
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

    // ==================== 结果 ====================
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
            if (barcodeScanner != null) barcodeScanner.close();
            if (analysisExecutor != null) analysisExecutor.shutdown();
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }
}
