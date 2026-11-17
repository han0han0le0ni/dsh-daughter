/**
 * 桌面画面层：PowerShell 单帧截图，以及可选的 ffmpeg 实时 JPEG 流。
 *
 * `/frames` 走截图循环，跨环境可用；`/stream` 走 ffmpeg，提供接近实时的画面。
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * 用 PowerShell + System.Drawing 截取主屏（可传 region）。
 * `format='jpeg'` 时按 quality 编码，显著降低连续抽帧带宽。
 *
 * `cursor=true` 时在图上叠加鼠标十字准星；`focusCursor=true` 或传
 * `centerX/centerY` 时截取以该点为中心的局部放大图，用于瞄准确认。
 * 截图进程会声明 DPI 感知，保证坐标与 input-worker 的物理像素一致。
 */
export async function captureScreenFrame({
  region,
  format = 'png',
  quality = 60,
  width = 0,
  dpi = false,
  cursor = false,
  focusCursor = false,
  centerX,
  centerY,
  cropWidth = 480,
  cropHeight = 320,
  powershell = 'powershell.exe',
  timeoutMs = 20000,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-'));
  const jpeg = format === 'jpeg';
  const file = join(dir, jpeg ? 'frame.jpg' : 'frame.png');
  const targetWidth = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.round(Number(width)) : 0;
  const hasRegion =
    region &&
    Number.isFinite(Number(region.x)) &&
    Number.isFinite(Number(region.y)) &&
    Number(region.width) > 0 &&
    Number(region.height) > 0;
  const hasCenter = Number.isFinite(Number(centerX)) && Number.isFinite(Number(centerY));
  const cropW = Math.min(4096, Math.max(64, Math.round(Number(cropWidth) || 480)));
  const cropH = Math.min(4096, Math.max(64, Math.round(Number(cropHeight) || 320)));
  const bounds = focusCursor || hasCenter
    ? `$centerX = ${focusCursor ? '$mouse.X' : Math.round(Number(centerX))}
$centerY = ${focusCursor ? '$mouse.Y' : Math.round(Number(centerY))}
$cropW = ${cropW}
$cropH = ${cropH}
$left = [Math]::Max($screen.X, $centerX - [int]($cropW / 2))
$top = [Math]::Max($screen.Y, $centerY - [int]($cropH / 2))
$right = [Math]::Min($screen.X + $screen.Width, $left + $cropW)
$bottom = [Math]::Min($screen.Y + $screen.Height, $top + $cropH)
$left = [Math]::Max($screen.X, $right - $cropW)
$top = [Math]::Max($screen.Y, $bottom - $cropH)
$bounds = New-Object System.Drawing.Rectangle($left, $top, [Math]::Max(1, $right - $left), [Math]::Max(1, $bottom - $top))`
    : hasRegion
      ? `$bounds = New-Object System.Drawing.Rectangle(${Number(region.x)}, ${Number(region.y)}, ${Number(region.width)}, ${Number(region.height)})`
      : '$bounds = $screen';
  const save = jpeg
    ? `$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
$parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${Math.min(95, Math.max(10, Number(quality) || 60))})
$saveTarget.Save('${psQuote(file)}', $codec, $parameters)`
    : `$saveTarget.Save('${psQuote(file)}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  const drawCursor = cursor
    ? `$scaleX = $saveTarget.Width / $source.Width
$scaleY = $saveTarget.Height / $source.Height
$markerX = [int](($mouse.X - $bounds.X) * $scaleX)
$markerY = [int](($mouse.Y - $bounds.Y) * $scaleY)
if ($markerX -ge 0 -and $markerY -ge 0 -and $markerX -lt $saveTarget.Width -and $markerY -lt $saveTarget.Height) {
  $penOuter = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 4)
  $penInner = New-Object System.Drawing.Pen([System.Drawing.Color]::Lime, 2)
  foreach ($pen in @($penOuter, $penInner)) {
    $markerGraphics = [System.Drawing.Graphics]::FromImage($saveTarget)
    $markerGraphics.DrawEllipse($pen, $markerX - 12, $markerY - 12, 24, 24)
    $markerGraphics.DrawLine($pen, $markerX - 18, $markerY, $markerX - 6, $markerY)
    $markerGraphics.DrawLine($pen, $markerX + 6, $markerY, $markerX + 18, $markerY)
    $markerGraphics.DrawLine($pen, $markerX, $markerY - 18, $markerX, $markerY - 6)
    $markerGraphics.DrawLine($pen, $markerX, $markerY + 6, $markerX, $markerY + 18)
    $markerGraphics.Dispose()
  }
  $penOuter.Dispose()
  $penInner.Dispose()
}`
    : '';

  const dpiSetup = dpi || cursor || focusCursor || hasCenter
    ? `Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class DshCaptureDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[void][DshCaptureDpi]::SetProcessDPIAware()`
    : '';
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${dpiSetup}
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$mouse = [System.Windows.Forms.Cursor]::Position
${bounds}
$source = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($source)
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $source.Size)
$saveTarget = $source
$scaled = $null
$targetWidth = ${targetWidth}
if ($targetWidth -gt 0 -and $targetWidth -lt $source.Width) {
  $targetHeight = [Math]::Max(1, [Math]::Round($source.Height * $targetWidth / $source.Width))
  $scaled = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
  $scaleGraphics = [System.Drawing.Graphics]::FromImage($scaled)
  $scaleGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $scaleGraphics.DrawImage($source, 0, 0, $targetWidth, $targetHeight)
  $scaleGraphics.Dispose()
  $saveTarget = $scaled
}
${drawCursor}
${save}
$graphics.Dispose()
$source.Dispose()
if ($scaled) { $scaled.Dispose() }
`;

  try {
    await execFileAsync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true },
    );
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function captureScreenPng(options = {}) {
  return captureScreenFrame({ ...options, format: 'png' });
}

export function captureScreenJpeg(options = {}) {
  return captureScreenFrame({ ...options, format: 'jpeg' });
}

export async function hasFfmpeg({ ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg' } = {}) {
  try {
    await execFileAsync(ffmpegPath, ['-version'], { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** ffmpeg 输出到 image2pipe 的 JPEG 参数；窗口优先 gdigrab，桌面优先 ddagrab */
export function buildFfmpegArgs({
  fps = 30,
  windowTitle = '',
  source = 'ddagrab',
  width = 1280,
  quality = 7,
} = {}) {
  const input = windowTitle
    ? ['-f', 'gdigrab', '-framerate', String(fps), '-i', `title=${windowTitle}`]
    : source === 'gdigrab'
      ? ['-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop']
      : ['-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${fps}`];
  const targetWidth = Number(width);
  const scale =
    Number.isFinite(targetWidth) && targetWidth > 0
      ? ['-vf', `scale=${Math.round(targetWidth)}:-2`]
      : [];
  const targetQuality = Math.min(31, Math.max(2, Number(quality) || 7));

  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...input,
    ...scale,
    '-c:v',
    'mjpeg',
    '-q:v',
    String(targetQuality),
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-',
  ];
}

/** 从连续字节流中切出 JPEG 帧（SOI FFD8 / EOI FFD9） */
export function createJpegFrameReader(onFrame) {
  let buffer = Buffer.alloc(0);
  const soi = Buffer.from([0xff, 0xd8]);
  const eoi = Buffer.from([0xff, 0xd9]);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const start = buffer.indexOf(soi);
      if (start < 0) {
        buffer = buffer.subarray(Math.max(0, buffer.length - 1));
        return;
      }
      const end = buffer.indexOf(eoi, start + 2);
      if (end < 0) {
        buffer = buffer.subarray(start);
        return;
      }
      const frame = buffer.subarray(start, end + 2);
      buffer = buffer.subarray(end + 2);
      onFrame(frame);
    }
  };
}

/**
 * 启动 ffmpeg 实时流；ddagrab 失败时自动回退 gdigrab。
 * 返回 `{ stop }`，调用后结束子进程。
 */
export function createFfmpegStream(options = {}) {
  const {
    fps = 30,
    windowTitle = '',
    source = 'ddagrab',
    width = 1280,
    quality = 7,
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    onFrame,
    onError = () => undefined,
  } = options;

  let child = null;
  let stopped = false;
  let frames = 0;
  let lastError = '';
  let usedSource = windowTitle ? 'gdigrab' : source;

  function start(nextSource) {
    if (stopped) return;
    usedSource = nextSource;
    child = spawn(ffmpegPath, buildFfmpegArgs({ fps, windowTitle, source: nextSource, width, quality }), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const read = createJpegFrameReader((frame) => {
      frames += 1;
      onFrame(frame);
    });
    child.stdout.on('data', read);
    child.stderr.on('data', (chunk) => {
      if (stopped) return;
      const text = String(chunk).trim();
      if (!text) return;
      lastError = text;
      // ddagrab 在旧版 ffmpeg / 远程桌面下可能不可用，这类错误交给回退处理
      if (!(frames === 0 && nextSource === 'ddagrab')) onError(new Error(text));
    });
    child.once('error', (error) => {
      if (!stopped) onError(error);
    });
    child.once('exit', (code) => {
      if (stopped) return;
      if (frames === 0 && nextSource === 'ddagrab') {
        start('gdigrab');
        return;
      }
      onError(new Error(lastError || `ffmpeg exited: ${code}`));
    });
  }

  start(usedSource);

  return {
    get source() {
      return usedSource;
    },
    stop() {
      stopped = true;
      child?.kill('SIGKILL');
    },
  };
}
