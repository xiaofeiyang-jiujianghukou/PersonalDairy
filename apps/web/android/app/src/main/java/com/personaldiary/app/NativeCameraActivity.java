package com.personaldiary.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
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
 * 拍照阶段:实时预览(原生方向/比例,铺满)、点按对焦、轻触拍照、长按摄像、
 *          ⚡ 启用/禁用拍照闪光灯、⟳ 前后置、左上角 ✕
 * 编辑阶段:取消 / 涂鸦 / 撤回 / 前进 / 完成(涂鸦直接合成进照片)
 * 结果以文件路径 + mime 返回给插件。
 */
public class NativeCameraActivity extends AppCompatActivity {

    public static final String EXTRA_PATH = "path";
    public static final String EXTRA_MIME = "mime";

    private FrameLayout root;
    private PreviewView previewView;
    private TextView hintView;
    private TextView torchIcon;
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

    // 编辑页
    private Bitmap photoBitmap;
    private File pendingFile;
    private DrawView drawView;
    private TextView drawBtn;
    private TextView undoBtn;
    private TextView redoBtn;
    private boolean drawMode = true;

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private android.graphics.drawable.GradientDrawable circle(int color) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        d.setColor(color);
        return d;
    }

    private android.graphics.drawable.GradientDrawable ringDrawable(int strokeDp, int color) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        d.setColor(Color.TRANSPARENT);
        d.setStroke(dp(strokeDp), color);
        return d;
    }

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
        focusRing.setBackground(ringDrawable(2, 0xFFFFFFFF));
        focusRing.setAlpha(0f);
        FrameLayout.LayoutParams frLp = new FrameLayout.LayoutParams(dp(72), dp(72));
        focusRing.setLayoutParams(frLp);
        root.addView(focusRing);

        // 左上角 ✕(纯白半透明,无底板,不挡画面)
        TextView close = new TextView(this);
        close.setText("✕");
        close.setTextColor(0xB3FFFFFF);
        close.setTextSize(26);
        close.setGravity(Gravity.CENTER);
        close.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        FrameLayout.LayoutParams closeLp = new FrameLayout.LayoutParams(dp(56), dp(56));
        closeLp.gravity = Gravity.TOP | Gravity.START;
        closeLp.topMargin = dp(16);
        closeLp.leftMargin = dp(6);
        close.setOnClickListener(v -> cancel());
        root.addView(close, closeLp);

        // 右上角:极淡的版本号(方便确认当前装的是哪一版)
        TextView verTag = new TextView(this);
        String vn = "?";
        try {
            vn = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
        }
        verTag.setText("v" + vn);
        verTag.setTextColor(0x59FFFFFF);
        verTag.setTextSize(12);
        verTag.setShadowLayer(4f, 0f, 1f, Color.BLACK);
        FrameLayout.LayoutParams verLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        verLp.gravity = Gravity.TOP | Gravity.END;
        verLp.topMargin = dp(30);
        verLp.rightMargin = dp(14);
        root.addView(verTag, verLp);

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
        hintLp.bottomMargin = dp(18);
        bottom.addView(hintView, hintLp);

        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setGravity(Gravity.CENTER_VERTICAL);

        // ⚡ 闪光灯:纯白,开/关用"划线"区分(不用颜色高亮)
        torchIcon = new TextView(this);
        torchIcon.setText("⚡");
        torchIcon.setTextSize(24);
        torchIcon.setTextColor(Color.WHITE);
        torchIcon.setGravity(Gravity.CENTER);
        torchIcon.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        torchIcon.setOnClickListener(v -> toggleFlash());
        LinearLayout.LayoutParams sideLp = new LinearLayout.LayoutParams(dp(52), dp(52));
        controls.addView(torchIcon, sideLp);

        // 快门:环和内圆都居中(之前环漏了 gravity,才会歪成月牙)
        FrameLayout shutter = new FrameLayout(this);
        View shutterRing = new View(this);
        shutterRing.setBackground(ringDrawable(4, Color.WHITE));
        FrameLayout.LayoutParams ringLp = new FrameLayout.LayoutParams(dp(78), dp(78));
        ringLp.gravity = Gravity.CENTER;
        shutter.addView(shutterRing, ringLp);

        shutterInner = new View(this);
        shutterInner.setBackground(circle(Color.WHITE));
        FrameLayout.LayoutParams innerLp = new FrameLayout.LayoutParams(dp(62), dp(62));
        innerLp.gravity = Gravity.CENTER;
        shutter.addView(shutterInner, innerLp);

        LinearLayout.LayoutParams shutterLp = new LinearLayout.LayoutParams(dp(96), dp(96));
        shutterLp.leftMargin = dp(30);
        shutterLp.rightMargin = dp(30);
        controls.addView(shutter, shutterLp);

        // ⟳ 前后置:纯白
        TextView flip = new TextView(this);
        flip.setText("⟳");
        flip.setTextSize(24);
        flip.setTextColor(Color.WHITE);
        flip.setGravity(Gravity.CENTER);
        flip.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        flip.setOnClickListener(v -> switchCamera());
        controls.addView(flip, sideLp);

        bottom.addView(controls);
        FrameLayout.LayoutParams bottomLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bottomLp.gravity = Gravity.BOTTOM;
        bottomLp.bottomMargin = dp(48);
        root.addView(bottom, bottomLp);

        setContentView(root);

        // 点按对焦
        previewView.setOnTouchListener((v, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                focusAt(event.getX(), event.getY());
            }
            return true;
        });

        // 快门:轻触拍照 / 长按(350ms)摄像
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
            FocusMeteringAction action = new FocusMeteringAction.Builder(
                    point, FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                    .setAutoCancelDuration(3, TimeUnit.SECONDS)
                    .build();
            camera.getCameraControl().startFocusAndMetering(action);
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
            bindUseCases();
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
            camera = provider.bindToLifecycle(this, selector, preview, imageCapture, videoCapture);
        } catch (Exception e) {
            finishWithError("打开相机失败:" + e.getMessage());
        }
    }

    private void switchCamera() {
        if (recordingNow) return;
        backCamera = !backCamera;
        bindUseCases();
    }

    /** ⚡ = 启用/禁用【拍照闪光灯】,不是常亮手电筒。 */
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
        // 保持纯白:开=正常,关=加一条划线
        torchIcon.setPaintFlags(flashOn
                ? (torchIcon.getPaintFlags() & ~Paint.STRIKE_THRU_TEXT_FLAG)
                : (torchIcon.getPaintFlags() | Paint.STRIKE_THRU_TEXT_FLAG));
    }

    private void toast(String text) {
        hintView.setText(text);
        handler.postDelayed(() -> {
            if (!recordingNow) hintView.setText("轻触拍照,长按摄像");
        }, 1800);
    }

    // ==================== 拍照 ====================
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

    // ==================== 录像 ====================
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
            shutterInner.setBackground(circle(Color.WHITE));
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

    // ==================== 编辑页:取消 / 涂鸦 / 撤回 / 前进 / 完成 ====================
    private void openEditor(File file) {
        pendingFile = file;
        try {
            photoBitmap = loadUprightBitmap(file);
        } catch (Exception e) {
            photoBitmap = null;
        }
        if (photoBitmap == null) {
            finishWith(file, "image/jpeg"); // 解码失败就原样返回
            return;
        }

        FrameLayout editor = new FrameLayout(this);
        editor.setBackgroundColor(Color.BLACK);

        drawView = new DrawView();
        drawView.setPhoto(photoBitmap);
        editor.addView(drawView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);

        TextView cancelBtn = toolText("取消", Color.WHITE);
        cancelBtn.setOnClickListener(v -> backToCamera());

        drawBtn = toolText("涂鸦", Color.WHITE);
        drawBtn.setOnClickListener(v -> {
            drawMode = !drawMode;
            if (drawView != null) drawView.setDrawEnabled(drawMode);
            drawBtn.setAlpha(drawMode ? 1f : 0.5f);
        });

        undoBtn = toolText("撤回", Color.WHITE);
        undoBtn.setOnClickListener(v -> {
            if (drawView != null && drawView.undo()) updateUndoRedo();
        });

        redoBtn = toolText("前进", Color.WHITE);
        redoBtn.setOnClickListener(v -> {
            if (drawView != null && drawView.redo()) updateUndoRedo();
        });

        TextView doneBtn = toolText("完成", 0xFF07C160);
        doneBtn.setOnClickListener(v -> finishEditing());

        LinearLayout.LayoutParams flex = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(cancelBtn, flex);
        bar.addView(drawBtn, flex);
        bar.addView(undoBtn, flex);
        bar.addView(redoBtn, flex);
        bar.addView(doneBtn, flex);

        FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        barLp.gravity = Gravity.BOTTOM;
        barLp.bottomMargin = dp(24);
        editor.addView(bar, barLp);

        setContentView(editor);
        updateUndoRedo();
    }

    private void backToCamera() {
        photoBitmap = null;
        drawView = null;
        buildCameraUi();
        bindUseCases();
    }

    private TextView toolText(String text, int color) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(color);
        t.setTextSize(16);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, dp(12), 0, dp(12));
        return t;
    }

    private void updateUndoRedo() {
        if (drawView == null) return;
        undoBtn.setAlpha(drawView.canUndo() ? 1f : 0.4f);
        redoBtn.setAlpha(drawView.canRedo() ? 1f : 0.4f);
    }

    private void finishEditing() {
        File out = new File(getCacheDir(), "EDIT_" + System.currentTimeMillis() + ".jpg");
        try {
            Bitmap flat = drawView.flatten();
            try (FileOutputStream fos = new FileOutputStream(out)) {
                flat.compress(Bitmap.CompressFormat.JPEG, 92, fos);
            }
            if (pendingFile != null) pendingFile.delete();
            finishWith(out, "image/jpeg");
        } catch (Exception e) {
            finishWithError("保存失败:" + e.getMessage());
        }
    }

    /** 按 EXIF 方向把照片摆正(否则编辑页显示 / 保存出来会歪)。 */
    private Bitmap loadUprightBitmap(File file) throws Exception {
        Bitmap bmp = BitmapFactory.decodeFile(file.getAbsolutePath());
        if (bmp == null) return null;
        ExifInterface exif = new ExifInterface(file.getAbsolutePath());
        int orientation = exif.getAttributeInt(
                ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        Matrix m = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90:
                m.postRotate(90);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                m.postRotate(180);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                m.postRotate(270);
                break;
            default:
                return bmp;
        }
        return Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
    }

    /** 涂鸦层:显示照片(等比居中)+ 手写笔迹;支持撤回/前进/合成导出。 */
    private class DrawView extends View {
        private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final List<Path> paths = new ArrayList<>();
        private final List<Path> redoStack = new ArrayList<>();
        private Bitmap photo;
        private final RectF dest = new RectF();
        private boolean drawEnabled = true;

        DrawView() {
            super(NativeCameraActivity.this);
            stroke.setColor(Color.WHITE);
            stroke.setStyle(Paint.Style.STROKE);
            stroke.setStrokeWidth(dp(5));
            stroke.setStrokeCap(Paint.Cap.ROUND);
            stroke.setStrokeJoin(Paint.Join.ROUND);
        }

        void setPhoto(Bitmap b) {
            photo = b;
            invalidate();
        }

        void setDrawEnabled(boolean on) {
            drawEnabled = on;
        }

        boolean canUndo() {
            return !paths.isEmpty();
        }

        boolean canRedo() {
            return !redoStack.isEmpty();
        }

        boolean undo() {
            if (paths.isEmpty()) return false;
            redoStack.add(paths.remove(paths.size() - 1));
            invalidate();
            return true;
        }

        boolean redo() {
            if (redoStack.isEmpty()) return false;
            paths.add(redoStack.remove(redoStack.size() - 1));
            invalidate();
            return true;
        }

        @Override
        protected void onSizeChanged(int w, int h, int ow, int oh) {
            super.onSizeChanged(w, h, ow, oh);
            dest.set(0, 0, w, h);
            if (photo == null || w == 0 || h == 0) return;
            float scale = Math.min((float) w / photo.getWidth(), (float) h / photo.getHeight());
            float dw = photo.getWidth() * scale;
            float dh = photo.getHeight() * scale;
            float left = (w - dw) / 2f;
            float top = (h - dh) / 2f;
            dest.set(left, top, left + dw, top + dh);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            if (photo != null) canvas.drawBitmap(photo, null, dest, null);
            for (Path p : paths) canvas.drawPath(p, stroke);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            if (!drawEnabled || photo == null) return false;
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN: {
                    Path p = new Path();
                    p.moveTo(event.getX(), event.getY());
                    paths.add(p);
                    redoStack.clear();
                    invalidate();
                    return true;
                }
                case MotionEvent.ACTION_MOVE: {
                    if (!paths.isEmpty()) {
                        paths.get(paths.size() - 1).lineTo(event.getX(), event.getY());
                        invalidate();
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    return true;
                default:
                    return false;
            }
        }

        /** 合成:原图 + 涂鸦(视图坐标按比例映射回原图坐标)。 */
        Bitmap flatten() {
            int bw = photo.getWidth();
            int bh = photo.getHeight();
            Bitmap out = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(out);
            c.drawBitmap(photo, 0, 0, null);
            if (!paths.isEmpty() && dest.width() > 0 && dest.height() > 0) {
                float sx = bw / dest.width();
                float sy = bh / dest.height();
                c.save();
                c.translate(-dest.left, -dest.top);
                c.scale(sx, sy);
                Paint scaled = new Paint(stroke);
                scaled.setStrokeWidth(stroke.getStrokeWidth() * Math.max(sx, sy));
                for (Path p : paths) c.drawPath(p, scaled);
                c.restore();
            }
            return out;
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
