/**
 * Windows 桌面状态层：窗口列表、前台窗口、当前媒体会话。
 *
 * 依赖系统 PowerShell，不引入第三方包；查询失败时返回可读错误，
 * 不阻塞截图/推流等主能力。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runPowerShell(script, { timeoutMs = 12000, powershell = 'powershell.exe' } = {}) {
  // Windows PowerShell 默认按 GBK 输出，先统一切到 UTF-8，避免中文标题乱码
  const wrapped = `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`;
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  return String(stdout ?? '').trim();
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
@(Get-Process | Where-Object { $_.MainWindowTitle } |
  Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle |
  Sort-Object ProcessName) | ConvertTo-Json -Depth 3
`;

const FOREGROUND_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshWin32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
'@
[void][DshWin32]::SetProcessDPIAware()
$handle = [DshWin32]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 512
[void][DshWin32]::GetWindowText($handle, $builder, $builder.Capacity)
$rect = New-Object DshWin32+RECT
[void][DshWin32]::GetWindowRect($handle, [ref]$rect)
$clientRect = New-Object DshWin32+RECT
[void][DshWin32]::GetClientRect($handle, [ref]$clientRect)
$clientOrigin = New-Object DshWin32+POINT
[void][DshWin32]::ClientToScreen($handle, [ref]$clientOrigin)
$procId = [uint32]0
[void][DshWin32]::GetWindowThreadProcessId($handle, [ref]$procId)
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
$processName = ''
if ($proc) { $processName = $proc.ProcessName }
[pscustomobject]@{
  title = $builder.ToString()
  processId = [int]$procId
  processName = $processName
  bounds = @{
    left = $rect.Left
    top = $rect.Top
    width = [Math]::Max(0, $rect.Right - $rect.Left)
    height = [Math]::Max(0, $rect.Bottom - $rect.Top)
  }
  client = @{
    left = $clientOrigin.X
    top = $clientOrigin.Y
    width = [Math]::Max(0, $clientRect.Right - $clientRect.Left)
    height = [Math]::Max(0, $clientRect.Bottom - $clientRect.Top)
  }
} | ConvertTo-Json -Depth 4
`;

const MEDIA_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]

  function Await($operation, $resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(10000) | Out-Null
    if (-not $task.IsCompleted) { throw '等待 WinRT 结果超时' }
    $task.Result
  }

  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = $manager.GetCurrentSession()
  if (-not $session) {
    @{ available = $false; reason = 'no_active_session' } | ConvertTo-Json
    exit 0
  }

  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
  $playback = $session.GetPlaybackInfo()
  $timeline = $session.GetTimelineProperties()
  @{
    available = $true
    title = $props.Title
    artist = $props.Artist
    album = $props.AlbumTitle
    appId = $session.SourceAppUserModelId
    status = $playback.PlaybackStatus.ToString()
    positionSeconds = [Math]::Round($timeline.Position.TotalSeconds, 1)
    durationSeconds = [Math]::Round($timeline.EndTime.TotalSeconds, 1)
  } | ConvertTo-Json
} catch {
  @{ available = $false; reason = $_.Exception.Message } | ConvertTo-Json
  exit 0
}
`;

export function parseJsonList(text) {
  if (!text) return [];
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [data];
}

export function parseJsonObject(text) {
  if (!text) return null;
  return JSON.parse(text);
}

export function createDesktopSystem({ run = runPowerShell } = {}) {
  return {
    async listWindows() {
      return parseJsonList(await run(WINDOWS_SCRIPT));
    },
    async foreground() {
      return parseJsonObject(await run(FOREGROUND_SCRIPT));
    },
    async media() {
      try {
        const result = parseJsonObject(await run(MEDIA_SCRIPT));
        return result ?? { available: false, reason: 'empty' };
      } catch (error) {
        return { available: false, reason: String(error) };
      }
    },
  };
}
