package com.personaldiary.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.PathMeasure;
import android.graphics.Typeface;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.EditText;
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
import androidx.camera.core.ImageCaptureException;
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
import androidx.exifinterface.media.ExifInterface;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * 原生相机(CameraX)+ 微信式编辑页。
 *
 * 拍照阶段:预览(原生方向/比例,铺满)、点按对焦、轻触拍照、长按摄像、
 *          ⚡ 启用/禁用拍照闪光灯、⟳ 前后置、左上角 ✕
 *          图标全部用矢量(纯白)绘制 —— emoji 字符会被系统渲染成彩色,不能用。
 * 编辑阶段:涂鸦 / 文字 / 马赛克 / 裁剪 + 撤回 / 前进 + 取消 / 完成
 */
public class NativeCameraActivity extends AppCompatActivity {

    public static final String EXTRA_PATH = "path";
    public static final String EXTRA_MIME = "mime";

    private static final int WHITE = Color.WHITE;

    private static int dp(float v, android.content.Context ctx) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, ctx.getResources().getDisplayMetrics()));
    }

    private int dp(float v) {
        return dp(v, this);
    }

    // ---------------- 拍照阶段 ----------------
    private FrameLayout root;
    private PreviewView previewView;
    private TextView hintView;
    private ImageView flashBtn;
    private View shutterInner;
    private View focusRing;

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

    // ---------------- 编辑阶段 ----------------
    private enum Tool { DRAW, TEXT, STICKER, BLUR, CROP }
    private enum BlurMode { MOSAIC, GAUSSIAN }

    private Bitmap base;          // 当前底图(裁剪/旋转后)
    private Bitmap pixelated;     // 马赛克用的低清底图
    private Bitmap blurred;       // 高斯模糊用的更糊底图
    private File pendingFile;
    private EditorView editorView;
    private final List<Op> ops = new ArrayList<>();
    private final List<Op> redoOps = new ArrayList<>();
    private Tool tool = Tool.DRAW;
    private ImageView drawBtn, textBtn, stickerBtn, blurBtn, cropBtn, undoBtn, redoBtn;
    private LinearLayout emojiBar; // 表情选择条(默认隐藏)
    private LinearLayout subBar;   // 工具栏上方的"子工具条"(色板/字体/模糊模式/橡皮)
    private LinearLayout cropBar;  // 裁剪模式的按钮条
    private CropView cropView;     // 自定义裁剪层
    private int inkColor = WHITE;
    private int textColor = WHITE;
    private int textStyle = 0;     // 0默认 1细体 2中体 3粗体
    private boolean textBoxed = false;
    private TextOp selectedText;
    private BlurMode blurMode = BlurMode.MOSAIC;
    private boolean eraser = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(Color.BLACK);
        w.setNavigationBarColor(Color.BLACK);
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        buildCameraUi();
        startCamera();
    }

    private ImageView icon(int resId) {
        ImageView v = new ImageView(this);
        v.setImageResource(resId);
        v.setColorFilter(WHITE);
        return v;
    }

    private void circleBg(View v, int sizeDp, int color) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        d.setColor(color);
        v.setBackground(d);
    }

    // ==================== 拍照阶段 UI ====================
    private void buildCameraUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        root.addView(previewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 对焦圈
        focusRing = new View(this);
        android.graphics.drawable.GradientDrawable ring = new android.graphics.drawable.GradientDrawable();
        ring.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        ring.setColor(Color.TRANSPARENT);
        ring.setStroke(dp(2), WHITE);
        focusRing.setBackground(ring);
        focusRing.setAlpha(0f);
        focusRing.setLayoutParams(new FrameLayout.LayoutParams(dp(72), dp(72)));
        root.addView(focusRing);

        // 左上角 ✕(矢量,纯白半透明)
        ImageView close = icon(R.drawable.ic_close);
        close.setAlpha(0.75f);
        FrameLayout.LayoutParams closeLp = new FrameLayout.LayoutParams(dp(52), dp(52));
        closeLp.gravity = Gravity.TOP | Gravity.START;
        closeLp.topMargin = dp(16);
        closeLp.leftMargin = dp(8);
        close.setPadding(dp(14), dp(14), dp(14), dp(14));
        close.setOnClickListener(v -> cancel());
        root.addView(close, closeLp);

        // 右上角版本号(极淡)
        TextView verTag = new TextView(this);
        String vn = "?";
        try {
            vn = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
        }
        verTag.setText("v" + vn);
        verTag.setTextColor(0x59FFFFFF);
        verTag.setTextSize(12);
        FrameLayout.LayoutParams verLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        verLp.gravity = Gravity.TOP | Gravity.END;
        verLp.topMargin = dp(30);
        verLp.rightMargin = dp(14);
        root.addView(verTag, verLp);

        // 底部:提示 + 控制行(⚡ 贴左、快门居中、⟳ 贴右 —— 与微信一致)
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

        // 快门(居中):环 + 内圆,都居中
        FrameLayout shutter = new FrameLayout(this);
        View shutterRing = new View(this);
        android.graphics.drawable.GradientDrawable sr = new android.graphics.drawable.GradientDrawable();
        sr.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        sr.setColor(Color.TRANSPARENT);
        sr.setStroke(dp(3), WHITE);
        shutterRing.setBackground(sr);
        FrameLayout.LayoutParams ringLp = new FrameLayout.LayoutParams(dp(76), dp(76));
        ringLp.gravity = Gravity.CENTER;
        shutter.addView(shutterRing, ringLp);
        shutterInner = new View(this);
        circleBg(shutterInner, 62, WHITE);
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
            // 等预览完成布局,拿到有效的 ViewPort,再绑定 → 拍照/录像按预览比例裁剪(所见即所得)
            previewView.post(this::bindUseCases);
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindUseCases() {
        if (provider == null) return;
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
                // 共享视口:照片/视频按"预览看到的那一块"裁剪 → 编辑页不再有黑边
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

    private void switchCamera() {
        if (recordingNow) return;
        backCamera = !backCamera;
        bindUseCases();
    }

    /** ⚡ = 启用/禁用【拍照闪光灯】(不是常亮手电筒)。开/关用两个矢量图标区分,均为纯白。 */
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
                        openEditor(file);
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
        if (on) {
            android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
            d.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
            d.setCornerRadius(dp(8));
            d.setColor(0xFFFF3B30);
            shutterInner.setBackground(d);
        } else {
            circleBg(shutterInner, 62, WHITE);
        }
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

    // ==================== 编辑页 ====================
    private void openEditor(File file) {
        pendingFile = file;
        try {
            base = loadUprightBitmap(file);
        } catch (Exception e) {
            base = null;
        }
        if (base == null) {
            finishWith(file, "image/jpeg");
            return;
        }
        pixelated = null;
        ops.clear();
        redoOps.clear();
        tool = Tool.DRAW;
        showEditorUi();
    }

    private void showEditorUi() {
        FrameLayout editor = new FrameLayout(this);
        editor.setBackgroundColor(Color.BLACK);

        editorView = new EditorView();
        editor.addView(editorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        cropView = new CropView();
        editor.addView(cropView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // ---------- 顶部:取消(左) + 撤回/前进(右) ----------
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        TextView cancelBtn = textBtn("取消", WHITE);
        cancelBtn.setOnClickListener(v -> backToCamera());
        top.addView(cancelBtn, new LinearLayout.LayoutParams(dp(72), dp(48)));
        top.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1f));

        undoBtn = icon(R.drawable.ic_undo);
        redoBtn = icon(R.drawable.ic_redo);
        undoBtn.setPadding(dp(10), dp(10), dp(10), dp(10));
        redoBtn.setPadding(dp(10), dp(10), dp(10), dp(10));
        undoBtn.setOnClickListener(v -> {
            if (undo()) editorView.invalidate();
        });
        redoBtn.setOnClickListener(v -> {
            if (redo()) editorView.invalidate();
        });
        top.addView(undoBtn, new LinearLayout.LayoutParams(dp(48), dp(48)));
        LinearLayout.LayoutParams redoLp = new LinearLayout.LayoutParams(dp(48), dp(48));
        redoLp.rightMargin = dp(6);
        top.addView(redoBtn, redoLp);

        FrameLayout.LayoutParams topLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        topLp.gravity = Gravity.TOP;
        topLp.topMargin = dp(8);
        topLp.leftMargin = dp(8);
        topLp.rightMargin = dp(8);
        editor.addView(top, topLp);

        // ---------- 底部:涂鸦 文字 表情 模糊 裁剪(左) + 完成(右,绿色) ----------
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);

        drawBtn = icon(R.drawable.ic_draw);
        textBtn = icon(R.drawable.ic_text);
        stickerBtn = icon(R.drawable.ic_emoji);
        blurBtn = icon(R.drawable.ic_blur);
        cropBtn = icon(R.drawable.ic_crop);
        for (ImageView b : new ImageView[]{drawBtn, textBtn, stickerBtn, blurBtn, cropBtn}) {
            b.setPadding(dp(9), dp(9), dp(9), dp(9));
            bar.addView(b, new LinearLayout.LayoutParams(dp(48), dp(48)));
        }
        drawBtn.setOnClickListener(v -> selectTool(Tool.DRAW));
        textBtn.setOnClickListener(v -> selectTool(Tool.TEXT));
        stickerBtn.setOnClickListener(v -> selectTool(Tool.STICKER));
        blurBtn.setOnClickListener(v -> selectTool(Tool.BLUR));
        cropBtn.setOnClickListener(v -> selectTool(Tool.CROP));

        bar.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1f));

        TextView doneBtn = textBtn("完成", WHITE);
        android.graphics.drawable.GradientDrawable pill = new android.graphics.drawable.GradientDrawable();
        pill.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
        pill.setCornerRadius(dp(8));
        pill.setColor(0xFF07C160);
        doneBtn.setBackground(pill);
        doneBtn.setPadding(dp(18), dp(8), dp(18), dp(8));
        doneBtn.setOnClickListener(v -> finishEditing());
        bar.addView(doneBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        barLp.gravity = Gravity.BOTTOM;
        barLp.bottomMargin = dp(20);
        barLp.leftMargin = dp(10);
        barLp.rightMargin = dp(10);
        editor.addView(bar, barLp);

        // ---------- 子工具条(色板 / 字体 / 模糊模式 / 橡皮擦),位于底栏上方 ----------
        subBar = new LinearLayout(this);
        subBar.setOrientation(LinearLayout.HORIZONTAL);
        subBar.setGravity(Gravity.CENTER_VERTICAL);
        FrameLayout.LayoutParams subLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        subLp.gravity = Gravity.BOTTOM;
        subLp.bottomMargin = dp(74);
        editor.addView(subBar, subLp);

        // ---------- 表情条(点"表情"才出现) ----------
        emojiBar = buildEmojiBar();
        FrameLayout.LayoutParams emojiLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
        emojiLp.gravity = Gravity.BOTTOM;
        emojiLp.bottomMargin = dp(74);
        editor.addView(emojiBar, emojiLp);

        // ---------- 裁剪模式的按钮条:旋转 / 还原 / ✕ / ✓ ----------
        cropBar = new LinearLayout(this);
        cropBar.setOrientation(LinearLayout.HORIZONTAL);
        cropBar.setGravity(Gravity.CENTER_VERTICAL);
        cropBar.setVisibility(View.GONE);

        ImageView rotBtn = icon(R.drawable.ic_rotate);
        rotBtn.setPadding(dp(10), dp(10), dp(10), dp(10));
        rotBtn.setOnClickListener(v -> {
            rotateBase();
            if (cropView != null) cropView.resetCrop();
            if (editorView != null) editorView.invalidate();
        });
        cropBar.addView(rotBtn, new LinearLayout.LayoutParams(dp(48), dp(48)));

        TextView resetBtn = textBtn("还原", WHITE);
        resetBtn.setOnClickListener(v -> {
            if (cropView != null) cropView.resetCrop();
        });
        cropBar.addView(resetBtn, new LinearLayout.LayoutParams(dp(64), dp(48)));

        cropBar.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1f));

        ImageView cropCancel = icon(R.drawable.ic_close);
        cropCancel.setPadding(dp(10), dp(10), dp(10), dp(10));
        cropCancel.setOnClickListener(v -> selectTool(Tool.DRAW));
        cropBar.addView(cropCancel, new LinearLayout.LayoutParams(dp(48), dp(48)));

        ImageView cropOk = icon(R.drawable.ic_check);
        cropOk.setPadding(dp(10), dp(10), dp(10), dp(10));
        cropOk.setOnClickListener(v -> {
            if (cropView != null) cropView.applyCropNow();
            selectTool(Tool.DRAW);
            if (editorView != null) editorView.invalidate();
            updateUndoRedo();
        });
        LinearLayout.LayoutParams okLp = new LinearLayout.LayoutParams(dp(48), dp(48));
        okLp.leftMargin = dp(6);
        cropBar.addView(cropOk, okLp);

        FrameLayout.LayoutParams cropBarLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        cropBarLp.gravity = Gravity.BOTTOM;
        cropBarLp.bottomMargin = dp(12);
        cropBarLp.leftMargin = dp(10);
        cropBarLp.rightMargin = dp(10);
        editor.addView(cropBar, cropBarLp);

        setContentView(editor);
        selectTool(Tool.DRAW);
    }

    /** 表情选择条:横向可滚动的一排 emoji,点一个就贴到图上(之后可拖动)。 */
    private LinearLayout buildEmojiBar() {
        LinearLayout outer = new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setBackgroundColor(0xE6000000);
        outer.setVisibility(View.GONE);
        android.widget.HorizontalScrollView sv = new android.widget.HorizontalScrollView(this);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        String[] emojis = {
                "\uD83D\uDE00","\uD83D\uDE04","\uD83D\uDE01","\uD83D\uDE06","\uD83D\uDE05","\uD83D\uDE02",
                "\uD83D\uDE42","\uD83D\uDE09","\uD83D\uDE0A","\uD83D\uDE0D","\uD83E\uDD70","\uD83D\uDE18",
                "\uD83D\uDE0E","\uD83E\uDD14","\uD83D\uDE10","\uD83D\uDE44","\uD83D\uDE0F","\uD83D\uDE22",
                "\uD83D\uDE2D","\uD83D\uDE24","\uD83D\uDE21","\uD83E\uDD7A","\uD83D\uDE31","\uD83D\uDE34",
                "\uD83E\uDD17","\uD83E\uDD29","\uD83D\uDE07","\uD83E\uDD23","\uD83D\uDC4D","\uD83D\uDC4E",
                "\uD83D\uDC4F","\uD83D\uDE4F","\uD83D\uDCAA","\u2764\uFE0F","\uD83D\uDC94","\u2728",
                "\uD83C\uDF89","\uD83D\uDD25","\u2B50","\uD83C\uDF08","\uD83C\uDF38","\uD83C\uDF40",
                "\uD83C\uDFB5","\uD83D\uDCF7","\u2708\uFE0F","\uD83C\uDF7A","\uD83C\uDF81","\uD83D\uDC31","\uD83D\uDC36"
        };
        for (String e : emojis) {
            TextView t = new TextView(this);
            t.setText(e);
            t.setTextSize(28);
            t.setPadding(dp(9), dp(8), dp(9), dp(8));
            t.setOnClickListener(v -> addSticker(e));
            row.addView(t);
        }
        sv.addView(row);
        outer.addView(sv);
        return outer;
    }

    private void showEmojiBar() {
        if (emojiBar == null) return;
        emojiBar.setVisibility(emojiBar.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
    }

    private void addSticker(String emoji) {
        if (base == null) return;
        float size = Math.max(48f, base.getWidth() / 8f);
        ops.add(new StickerOp(emoji, base.getWidth() / 2f, base.getHeight() / 2f, size));
        redoOps.clear();
        if (emojiBar != null) emojiBar.setVisibility(View.GONE);
        if (editorView != null) editorView.invalidate();
        updateUndoRedo();
    }

    /** 切换工具:显示/隐藏裁剪层,并刷新子工具条。 */
    private void selectTool(Tool t) {
        tool = t;
        if (cropView != null) cropView.setVisibility(t == Tool.CROP ? View.VISIBLE : View.GONE);
        if (cropBar != null) cropBar.setVisibility(t == Tool.CROP ? View.VISIBLE : View.GONE);
        if (t == Tool.CROP && cropView != null) cropView.resetCrop();
        if (emojiBar != null) emojiBar.setVisibility(t == Tool.STICKER ? View.VISIBLE : View.GONE);

        drawBtn.setAlpha(t == Tool.DRAW ? 1f : 0.45f);
        textBtn.setAlpha(t == Tool.TEXT ? 1f : 0.45f);
        stickerBtn.setAlpha(t == Tool.STICKER ? 1f : 0.45f);
        blurBtn.setAlpha(t == Tool.BLUR ? 1f : 0.45f);
        cropBtn.setAlpha(t == Tool.CROP ? 1f : 0.45f);

        if (t != Tool.TEXT) selectedText = null;
        refreshSubBar();
        if (editorView != null) editorView.invalidate();
    }

    /** 子工具条内容:涂鸦=色板+橡皮;文字=字体+色板+T框;模糊=模式+橡皮。 */
    private void refreshSubBar() {
        if (subBar == null) return;
        subBar.removeAllViews();
        if (tool == Tool.CROP || tool == Tool.STICKER) {
            subBar.setVisibility(View.GONE);
            return;
        }
        subBar.setVisibility(View.VISIBLE);

        if (tool == Tool.TEXT) {
            String[] fonts = {"默认", "细体", "中体", "粗体"};
            for (int i = 0; i < fonts.length; i++) {
                final int idx = i;
                subBar.addView(chip(fonts[i], textStyle == idx, v -> {
                    textStyle = idx;
                    applyTextStyle();
                    refreshSubBar();
                }));
            }
        }

        int current = tool == Tool.TEXT ? textColor : inkColor;
        for (int c : PALETTE) {
            subBar.addView(dot(c, current == c, v -> {
                if (tool == Tool.TEXT) textColor = c;
                else inkColor = c;
                applyTextStyle();
                refreshSubBar();
            }));
        }

        if (tool == Tool.TEXT) {
            subBar.addView(chip("T框", textBoxed, v -> {
                textBoxed = !textBoxed;
                applyTextStyle();
                refreshSubBar();
            }));
        } else if (tool == Tool.DRAW) {
            subBar.addView(chip("橡皮", eraser, v -> {
                eraser = !eraser;
                refreshSubBar();
            }));
        } else if (tool == Tool.BLUR) {
            subBar.addView(chip("马赛克", blurMode == BlurMode.MOSAIC, v -> {
                blurMode = BlurMode.MOSAIC;
                eraser = false;
                refreshSubBar();
            }));
            subBar.addView(chip("高斯模糊", blurMode == BlurMode.GAUSSIAN, v -> {
                blurMode = BlurMode.GAUSSIAN;
                eraser = false;
                refreshSubBar();
            }));
            subBar.addView(chip("橡皮", eraser, v -> {
                eraser = !eraser;
                refreshSubBar();
            }));
        }
    }

    /** 把当前文字样式应用到选中的文字(没有选中则只是设为"新建默认")。 */
    private void applyTextStyle() {
        if (selectedText != null) {
            selectedText.color = textColor;
            selectedText.style = textStyle;
            selectedText.boxed = textBoxed;
            if (editorView != null) editorView.invalidate();
        }
    }

    private TextView chip(String label, boolean active, View.OnClickListener onClick) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextSize(13);
        t.setTextColor(active ? Color.BLACK : WHITE);
        t.setGravity(Gravity.CENTER);
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
        d.setCornerRadius(dp(14));
        d.setStroke(dp(1), 0x88FFFFFF);
        d.setColor(active ? WHITE : 0x33000000);
        t.setBackground(d);
        t.setPadding(dp(12), dp(6), dp(12), dp(6));
        t.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(6);
        t.setLayoutParams(lp);
        return t;
    }

    private View dot(int color, boolean active, View.OnClickListener onClick) {
        View v = new View(this);
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        d.setColor(color);
        d.setStroke(active ? dp(3) : dp(1), active ? 0xFFFFD479 : 0x66FFFFFF);
        v.setBackground(d);
        v.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(28), dp(28));
        lp.rightMargin = dp(8);
        v.setLayoutParams(lp);
        return v;
    }

    private TextView textBtn(String text, int color) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(color);
        t.setTextSize(16);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, dp(12), 0, dp(12));
        return t;
    }

    private void backToCamera() {
        base = null;
        pixelated = null;
        editorView = null;
        emojiBar = null;
        subBar = null;
        cropView = null;
        cropBar = null;
        selectedText = null;
        ops.clear();
        redoOps.clear();
        buildCameraUi();
        bindUseCases();
    }

    private boolean undo() {
        if (ops.isEmpty()) return false;
        redoOps.add(ops.remove(ops.size() - 1));
        updateUndoRedo();
        return true;
    }

    private boolean redo() {
        if (redoOps.isEmpty()) return false;
        ops.add(redoOps.remove(redoOps.size() - 1));
        updateUndoRedo();
        return true;
    }

    private void updateUndoRedo() {
        if (undoBtn != null) undoBtn.setAlpha(ops.isEmpty() ? 0.4f : 1f);
        if (redoBtn != null) redoBtn.setAlpha(redoOps.isEmpty() ? 0.4f : 1f);
    }

    private void promptText(float x, float y) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setHint("输入文字");
        new AlertDialog.Builder(this)
                .setTitle("添加文字")
                .setView(input)
                .setPositiveButton("确定", (d, w) -> {
                    String s = input.getText().toString().trim();
                    if (s.isEmpty() || base == null) return;
                    TextOp op = new TextOp(s, x, y, Math.max(24f, base.getWidth() / 14f),
                            textColor, textStyle, textBoxed);
                    ops.add(op);
                    selectedText = op;
                    redoOps.clear();
                    if (editorView != null) editorView.invalidate();
                    updateUndoRedo();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void rotateBase() {
        if (base == null) return;
        int w = base.getWidth();
        int h = base.getHeight();
        Matrix rm = new Matrix();
        rm.postRotate(90);
        rm.postTranslate(h, 0); // (x,y) -> (h - y, x)
        Bitmap rotated = Bitmap.createBitmap(base, 0, 0, w, h, rm, true);
        base = rotated;
        pixelated = null;
        blurred = null;
        for (Op op : ops) op.transform(rm);
        for (Op op : redoOps) op.transform(rm);
    }

    private void finishEditing() {
        File out = new File(getCacheDir(), "EDIT_" + System.currentTimeMillis() + ".jpg");
        try {
            Bitmap flat = editorView.flatten();
            try (FileOutputStream fos = new FileOutputStream(out)) {
                flat.compress(Bitmap.CompressFormat.JPEG, 92, fos);
            }
            if (pendingFile != null) pendingFile.delete();
            finishWith(out, "image/jpeg");
        } catch (Exception e) {
            finishWithError("保存失败:" + e.getMessage());
        }
    }

    private Bitmap loadUprightBitmap(File file) throws Exception {
        Bitmap bmp = BitmapFactory.decodeFile(file.getAbsolutePath());
        if (bmp == null) return null;
        ExifInterface exif = new ExifInterface(file.getAbsolutePath());
        int o = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        Matrix m = new Matrix();
        switch (o) {
            case ExifInterface.ORIENTATION_ROTATE_90: m.postRotate(90); break;
            case ExifInterface.ORIENTATION_ROTATE_180: m.postRotate(180); break;
            case ExifInterface.ORIENTATION_ROTATE_270: m.postRotate(270); break;
            default: return bmp;
        }
        return Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
    }

    // ==================== 编辑操作模型(坐标一律用"图像像素") ====================
    private static final int[] PALETTE = {
            0xFFFFFFFF, 0xFF000000, 0xFFE53935, 0xFFF57C00, 0xFFFDD835,
            0xFF7CB342, 0xFF00A86B, 0xFF1E88E5
    };

    private static Typeface typefaceFor(int style) {
        switch (style) {
            case 1: return Typeface.create("sans-serif-light", Typeface.NORMAL);
            case 2: return Typeface.create("sans-serif-medium", Typeface.NORMAL);
            case 3: return Typeface.create("sans-serif", Typeface.BOLD);
            default: return Typeface.create("sans-serif", Typeface.NORMAL);
        }
    }

    /** 把一条笔画路径"加粗"成区域(圆并集),用于模糊/打码/擦除的取形。 */
    private static Path buildOutline(Path src, float width) {
        Path out = new Path();
        PathMeasure pm = new PathMeasure(src, false);
        float len = pm.getLength();
        if (len <= 0) return out;
        float step = Math.max(2f, width / 3f);
        float[] pos = new float[2];
        Path circle = new Path();
        for (float d = 0; d <= len; d += step) {
            pm.getPosTan(d, pos, null);
            circle.reset();
            circle.addCircle(pos[0], pos[1], width / 2f, Path.Direction.CW);
            out.op(circle, Path.Op.UNION);
        }
        return out;
    }

    private static float luminance(int c) {
        return (0.299f * Color.red(c) + 0.587f * Color.green(c) + 0.114f * Color.blue(c)) / 255f;
    }

    private abstract static class Op {
        boolean erase = false;
        abstract void drawImage(Canvas c, Bitmap pixelated, Bitmap blurred, RectF imageRect);
        abstract void drawView(Canvas c, Matrix img2view, Bitmap pixelated, Bitmap blurred, RectF dest);
        abstract void transform(Matrix m);
    }

    /** 涂鸦笔画(自由手写;可带颜色,也可作为橡皮擦)。 */
    private static class StrokeOp extends Op {
        final Path path = new Path();
        final float width;
        final int color;
        private Path outline;

        StrokeOp(float w, int color, boolean erase) {
            width = w;
            this.color = color;
            this.erase = erase;
        }

        Path outlineImage() {
            if (outline == null) outline = buildOutline(path, width);
            return outline;
        }

        private Paint strokePaint(float scale, boolean clear) {
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(width * scale);
            p.setStrokeCap(Paint.Cap.ROUND);
            p.setStrokeJoin(Paint.Join.ROUND);
            if (clear) p.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
            else p.setColor(color);
            return p;
        }

        @Override
        void drawImage(Canvas c, Bitmap pixelated, Bitmap blurred, RectF imageRect) {
            c.drawPath(path, strokePaint(1f, erase));
        }

        @Override
        void drawView(Canvas c, Matrix img2view, Bitmap pixelated, Bitmap blurred, RectF dest) {
            Path p = new Path(path);
            p.transform(img2view);
            c.drawPath(p, strokePaint(img2view.mapRadius(1f), erase));
        }

        @Override
        void transform(Matrix m) {
            path.transform(m);
            outline = null;
        }
    }

    /** 模糊/打码笔画:沿笔画把该区域换成"打码"或"高斯模糊"底图;也可作为橡皮擦。 */
    private static class BlurOp extends Op {
        final Path path = new Path();
        final float width;
        final boolean gaussian;
        private Path outline;

        BlurOp(float w, boolean gaussian, boolean erase) {
            width = w;
            this.gaussian = gaussian;
            this.erase = erase;
        }

        private Path outlineImage() {
            if (outline == null) outline = buildOutline(path, width);
            return outline;
        }

        @Override
        void drawImage(Canvas c, Bitmap pixelated, Bitmap blurred, RectF imageRect) {
            Bitmap src = gaussian ? blurred : pixelated;
            if (src == null) return;
            Paint noFilter = new Paint();
            noFilter.setFilterBitmap(gaussian);
            noFilter.setAntiAlias(gaussian);
            if (erase) noFilter.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
            c.save();
            c.clipPath(outlineImage());
            c.drawBitmap(src, new Rect(0, 0, src.getWidth(), src.getHeight()), imageRect, noFilter);
            c.restore();
        }

        @Override
        void drawView(Canvas c, Matrix img2view, Bitmap pixelated, Bitmap blurred, RectF dest) {
            Bitmap src = gaussian ? blurred : pixelated;
            if (src == null) return;
            Path outlineView = new Path(outlineImage());
            outlineView.transform(img2view);
            Paint noFilter = new Paint();
            noFilter.setFilterBitmap(gaussian);
            noFilter.setAntiAlias(gaussian);
            if (erase) noFilter.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
            c.save();
            c.clipPath(outlineView);
            c.drawBitmap(src, new Rect(0, 0, src.getWidth(), src.getHeight()), dest, noFilter);
            c.restore();
        }

        @Override
        void transform(Matrix m) {
            path.transform(m);
            outline = null;
        }
    }

    /** 文字:支持颜色 / 字体粗细 / 带框。 */
    private static class TextOp extends Op {
        String text;
        float x, y, size;
        int color;
        int style;
        boolean boxed;

        TextOp(String text, float x, float y, float size, int color, int style, boolean boxed) {
            this.text = text;
            this.x = x;
            this.y = y;
            this.size = size;
            this.color = color;
            this.style = style;
            this.boxed = boxed;
        }

        private Paint paint(float scale) {
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            p.setColor(color);
            p.setTextSize(size * scale);
            p.setTypeface(typefaceFor(style));
            p.setShadowLayer(boxed ? 0f : 8f, 0f, 2f, 0xAA000000);
            return p;
        }

        private void draw(Canvas c, Paint p, float scale) {
            if (boxed) {
                float pad = size * scale * 0.25f;
                RectF r = new RectF(x, y - size * scale, x + p.measureText(text) + pad * 2f, y + pad * 1.6f);
                Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
                bg.setColor(color);
                float rad = size * scale * 0.2f;
                c.drawRoundRect(r, rad, rad, bg);
                Paint tp = new Paint(p);
                tp.setColor(luminance(color) > 0.6f ? Color.BLACK : Color.WHITE);
                c.drawText(text, x + pad, y, tp);
            } else {
                c.drawText(text, x, y, p);
            }
        }

        @Override
        void drawImage(Canvas c, Bitmap pixelated, Bitmap blurred, RectF imageRect) {
            draw(c, paint(1f), 1f);
        }

        @Override
        void drawView(Canvas c, Matrix img2view, Bitmap pixelated, Bitmap blurred, RectF dest) {
            float scale = img2view.mapRadius(1f);
            float[] pt = {x, y};
            img2view.mapPoints(pt);
            TextOp tmp = new TextOp(text, pt[0], pt[1], size, color, style, boxed);
            tmp.draw(c, tmp.paint(scale), scale);
        }

        @Override
        void transform(Matrix m) {
            float[] pt = {x, y};
            m.mapPoints(pt);
            x = pt[0];
            y = pt[1];
        }
    }

    /** 表情贴纸(可拖动;emoji 用系统彩色字体渲染)。 */
    private static class StickerOp extends Op {
        String emoji;
        float x, y, size;

        StickerOp(String emoji, float x, float y, float size) {
            this.emoji = emoji;
            this.x = x;
            this.y = y;
            this.size = size;
        }

        private Paint paint(float scale) {
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            p.setTextSize(size * scale);
            p.setTextAlign(Paint.Align.CENTER);
            p.setShadowLayer(8f, 0f, 2f, 0xAA000000);
            return p;
        }

        @Override
        void drawImage(Canvas c, Bitmap pixelated, Bitmap blurred, RectF imageRect) {
            c.drawText(emoji, x, y + size * 0.34f, paint(1f));
        }

        @Override
        void drawView(Canvas c, Matrix img2view, Bitmap pixelated, Bitmap blurred, RectF dest) {
            float[] pt = {x, y};
            img2view.mapPoints(pt);
            float scale = img2view.mapRadius(1f);
            c.drawText(emoji, pt[0], pt[1] + size * scale * 0.34f, paint(scale));
        }

        @Override
        void transform(Matrix m) {
            float[] pt = {x, y};
            m.mapPoints(pt);
            x = pt[0];
            y = pt[1];
        }
    }

    /** 编辑器视图:底图(等比居中)+ 墨迹层/模糊层(各支持橡皮擦)+ 文字贴纸层。 */
    private class EditorView extends View {
        private final RectF dest = new RectF();
        private final Matrix img2view = new Matrix();
        private Op active;
        private Op dragging;
        private float downX, downY;

        EditorView() {
            super(NativeCameraActivity.this);
        }

        private void ensureLayers() {
            if (base == null) return;
            if (pixelated == null) {
                pixelated = Bitmap.createScaledBitmap(base,
                        Math.max(1, base.getWidth() / 18), Math.max(1, base.getHeight() / 18), true);
            }
            if (blurred == null) {
                blurred = Bitmap.createScaledBitmap(base,
                        Math.max(1, base.getWidth() / 40), Math.max(1, base.getHeight() / 40), true);
            }
        }

        private void computeDest() {
            int w = getWidth();
            int h = getHeight();
            dest.set(0, 0, w, h);
            if (base == null || w == 0 || h == 0) return;
            float scale = Math.min((float) w / base.getWidth(), (float) h / base.getHeight());
            float dw = base.getWidth() * scale;
            float dh = base.getHeight() * scale;
            float left = (w - dw) / 2f;
            float top = (h - dh) / 2f;
            dest.set(left, top, left + dw, top + dh);
            img2view.setRectToRect(new RectF(0, 0, base.getWidth(), base.getHeight()), dest, Matrix.ScaleToFit.FILL);
        }

        private boolean isInk(Op op) {
            return op instanceof StrokeOp;
        }

        private boolean isBlur(Op op) {
            return op instanceof BlurOp;
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            computeDest();
            if (base == null) return;
            canvas.drawBitmap(base, null, dest, null);
            ensureLayers();

            // 墨迹层(画笔 + 橡皮擦)
            int c1 = canvas.saveLayer(dest, null);
            for (Op op : ops) if (isInk(op) && !op.erase) op.drawView(canvas, img2view, pixelated, blurred, dest);
            if (active != null && isInk(active) && !active.erase) active.drawView(canvas, img2view, pixelated, blurred, dest);
            for (Op op : ops) if (isInk(op) && op.erase) op.drawView(canvas, img2view, pixelated, blurred, dest);
            if (active != null && isInk(active) && active.erase) active.drawView(canvas, img2view, pixelated, blurred, dest);
            canvas.restoreToCount(c1);

            // 模糊层(打码/高斯 + 橡皮擦)
            int c2 = canvas.saveLayer(dest, null);
            for (Op op : ops) if (isBlur(op) && !op.erase) op.drawView(canvas, img2view, pixelated, blurred, dest);
            if (active != null && isBlur(active) && !active.erase) active.drawView(canvas, img2view, pixelated, blurred, dest);
            for (Op op : ops) if (isBlur(op) && op.erase) op.drawView(canvas, img2view, pixelated, blurred, dest);
            if (active != null && isBlur(active) && active.erase) active.drawView(canvas, img2view, pixelated, blurred, dest);
            canvas.restoreToCount(c2);

            // 文字 / 贴纸
            for (Op op : ops) if (!isInk(op) && !isBlur(op)) op.drawView(canvas, img2view, pixelated, blurred, dest);
            if (selectedText != null && !ops.contains(selectedText)) selectedText = null;
        }

        private float[] toImage(float vx, float vy) {
            Matrix inv = new Matrix();
            if (!img2view.invert(inv)) return new float[]{vx, vy};
            float[] pt = {vx, vy};
            inv.mapPoints(pt);
            return pt;
        }

        private Op hitTextOrSticker(float ix, float iy) {
            for (int i = ops.size() - 1; i >= 0; i--) {
                Op op = ops.get(i);
                float ox, oy, os;
                if (op instanceof TextOp) {
                    TextOp t = (TextOp) op;
                    ox = t.x; oy = t.y; os = t.size;
                } else if (op instanceof StickerOp) {
                    StickerOp t = (StickerOp) op;
                    ox = t.x; oy = t.y; os = t.size;
                } else {
                    continue;
                }
                if (Math.abs(ox - ix) < os * 1.6f && Math.abs(oy - iy) < os * 1.4f) return op;
            }
            return null;
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
            if (base == null) return false;
            float imScale = (float) base.getWidth() / Math.max(1f, dest.width());
            float[] pt = toImage(e.getX(), e.getY());
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = pt[0];
                    downY = pt[1];
                    if (tool == Tool.TEXT || tool == Tool.STICKER) {
                        dragging = hitTextOrSticker(pt[0], pt[1]);
                        if (dragging instanceof TextOp) {
                            selectedText = (TextOp) dragging;
                            refreshSubBar();
                        }
                        if (dragging == null && tool == Tool.TEXT) promptText(pt[0], pt[1]);
                        return true;
                    }
                    if (tool == Tool.DRAW) {
                        active = new StrokeOp(Math.max(2f, 7f * imScale), inkColor, eraser);
                    } else if (tool == Tool.BLUR) {
                        active = new BlurOp(Math.max(4f, 26f * imScale), blurMode == BlurMode.GAUSSIAN, eraser);
                    } else {
                        return false;
                    }
                    if (active instanceof StrokeOp) ((StrokeOp) active).path.moveTo(pt[0], pt[1]);
                    else ((BlurOp) active).path.moveTo(pt[0], pt[1]);
                    invalidate();
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (dragging != null) {
                        if (dragging instanceof TextOp) {
                            TextOp t = (TextOp) dragging;
                            t.x = pt[0];
                            t.y = pt[1];
                        } else if (dragging instanceof StickerOp) {
                            StickerOp t = (StickerOp) dragging;
                            t.x = pt[0];
                            t.y = pt[1];
                        }
                        invalidate();
                        return true;
                    }
                    if (active instanceof StrokeOp) ((StrokeOp) active).path.lineTo(pt[0], pt[1]);
                    else if (active instanceof BlurOp) ((BlurOp) active).path.lineTo(pt[0], pt[1]);
                    invalidate();
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (dragging != null) {
                        dragging = null;
                        return true;
                    }
                    if (active != null) {
                        ops.add(active);
                        redoOps.clear();
                        active = null;
                        updateUndoRedo();
                        invalidate();
                    }
                    return true;
                default:
                    return false;
            }
        }

        Bitmap flatten() {
            int w = base.getWidth();
            int h = base.getHeight();
            Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(out);
            RectF imgRect = new RectF(0, 0, w, h);
            ensureLayersFor(c);
            c.drawBitmap(base, 0, 0, null);
            int l1 = c.saveLayer(imgRect, null);
            for (Op op : ops) if (isInk(op) && !op.erase) op.drawImage(c, pixelated, blurred, imgRect);
            for (Op op : ops) if (isInk(op) && op.erase) op.drawImage(c, pixelated, blurred, imgRect);
            c.restoreToCount(l1);
            int l2 = c.saveLayer(imgRect, null);
            for (Op op : ops) if (isBlur(op) && !op.erase) op.drawImage(c, pixelated, blurred, imgRect);
            for (Op op : ops) if (isBlur(op) && op.erase) op.drawImage(c, pixelated, blurred, imgRect);
            c.restoreToCount(l2);
            for (Op op : ops) if (!isInk(op) && !isBlur(op)) op.drawImage(c, pixelated, blurred, imgRect);
            return out;
        }

        private void ensureLayersFor(Canvas c) {
            ensureLayers();
        }
    }

    // ==================== 自定义裁剪 ====================
    private class CropView extends View {
        private final RectF imgRect = new RectF();
        private final RectF crop = new RectF();
        private int handle = -1; // 0..7 八个把手, 8 移动, -1 无
        private float lastX, lastY;

        CropView() {
            super(NativeCameraActivity.this);
            setVisibility(GONE);
        }

        void resetCrop() {
            computeImgRect();
            crop.set(imgRect);
            invalidate();
        }

        private void computeImgRect() {
            int w = getWidth();
            int h = getHeight();
            if (base == null || w == 0 || h == 0) return;
            float scale = Math.min((float) w / base.getWidth(), (float) h / base.getHeight());
            float dw = base.getWidth() * scale;
            float dh = base.getHeight() * scale;
            float left = (w - dw) / 2f;
            float top = (h - dh) / 2f;
            imgRect.set(left, top, left + dw, top + dh);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            if (base == null) return;
            computeImgRect();
            if (crop.isEmpty()) crop.set(imgRect);
            canvas.drawBitmap(base, null, imgRect, null);

            // 裁剪区外压暗
            Paint dim = new Paint();
            dim.setColor(0x99000000);
            Path outside = new Path();
            outside.addRect(imgRect, Path.Direction.CW);
            Path inner = new Path();
            inner.addRect(crop, Path.Direction.CW);
            outside.op(inner, Path.Op.DIFFERENCE);
            canvas.drawPath(outside, dim);

            Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
            line.setColor(WHITE);
            line.setStyle(Paint.Style.STROKE);
            line.setStrokeWidth(dp(2));
            canvas.drawRect(crop, line);

            // 八个把手
            Paint h = new Paint(Paint.ANTI_ALIAS_FLAG);
            h.setColor(WHITE);
            float r = dp(4);
            float[] hx = {crop.left, crop.centerX(), crop.right, crop.right, crop.right, crop.centerX(), crop.left, crop.left};
            float[] hy = {crop.top, crop.top, crop.top, crop.centerY(), crop.bottom, crop.bottom, crop.bottom, crop.centerY()};
            for (int i = 0; i < 8; i++) canvas.drawCircle(hx[i], hy[i], r, h);
        }

        private int pickHandle(float x, float y) {
            float t = dp(28);
            float[] hx = {crop.left, crop.centerX(), crop.right, crop.right, crop.right, crop.centerX(), crop.left, crop.left};
            float[] hy = {crop.top, crop.top, crop.top, crop.centerY(), crop.bottom, crop.bottom, crop.bottom, crop.centerY()};
            for (int i = 0; i < 8; i++) {
                if (Math.abs(x - hx[i]) < t && Math.abs(y - hy[i]) < t) return i;
            }
            if (crop.contains(x, y)) return 8;
            return -1;
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
            float x = e.getX();
            float y = e.getY();
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    handle = pickHandle(x, y);
                    lastX = x;
                    lastY = y;
                    return handle >= 0;
                case MotionEvent.ACTION_MOVE:
                    if (handle < 0) return false;
                    float dx = x - lastX;
                    float dy = y - lastY;
                    lastX = x;
                    lastY = y;
                    float min = dp(64);
                    if (handle == 8) {
                        crop.offset(dx, dy);
                        if (crop.left < imgRect.left) crop.offset(imgRect.left - crop.left, 0);
                        if (crop.right > imgRect.right) crop.offset(imgRect.right - crop.right, 0);
                        if (crop.top < imgRect.top) crop.offset(0, imgRect.top - crop.top);
                        if (crop.bottom > imgRect.bottom) crop.offset(0, imgRect.bottom - crop.bottom);
                    } else {
                        if (handle == 0 || handle == 6 || handle == 7) crop.left = Math.max(imgRect.left, Math.min(crop.left + dx, crop.right - min));
                        if (handle == 2 || handle == 3 || handle == 4) crop.right = Math.min(imgRect.right, Math.max(crop.right + dx, crop.left + min));
                        if (handle == 0 || handle == 1 || handle == 2) crop.top = Math.max(imgRect.top, Math.min(crop.top + dy, crop.bottom - min));
                        if (handle == 4 || handle == 5 || handle == 6) crop.bottom = Math.min(imgRect.bottom, Math.max(crop.bottom + dy, crop.top + min));
                    }
                    invalidate();
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    handle = -1;
                    return true;
                default:
                    return false;
            }
        }

        /** 把视图坐标的裁剪框换算回图像坐标并执行裁剪。 */
        void applyCropNow() {
            if (base == null || imgRect.width() <= 0) return;
            float sx = base.getWidth() / imgRect.width();
            float sy = base.getHeight() / imgRect.height();
            int left = Math.round((crop.left - imgRect.left) * sx);
            int top = Math.round((crop.top - imgRect.top) * sy);
            int w = Math.round(crop.width() * sx);
            int h = Math.round(crop.height() * sy);
            left = Math.max(0, Math.min(left, base.getWidth() - 1));
            top = Math.max(0, Math.min(top, base.getHeight() - 1));
            w = Math.max(1, Math.min(w, base.getWidth() - left));
            h = Math.max(1, Math.min(h, base.getHeight() - top));
            base = Bitmap.createBitmap(base, left, top, w, h);
            pixelated = null;
            blurred = null;
            Matrix m = new Matrix();
            m.postTranslate(-left, -top);
            for (Op op : ops) op.transform(m);
            for (Op op : redoOps) op.transform(m);
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
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }
}
