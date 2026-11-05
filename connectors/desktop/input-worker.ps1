# dsh-daughter desktop input worker.
#
# Started as a child process by input.mjs. Compiles the Win32 wrapper once, then
# reads JSON requests from stdin and writes JSON responses to stdout. Keeping the
# process alive avoids recompiling C# for every click.
#
# Request fields (snake_case):
#   { id, action, normalized, x, y, from_x, from_y, to_x, to_y,
#     button, count, interval_ms, delta, key, mode, hold_ms, text, window, process }
# action: move | click | drag | scroll | key | type | activate | screen
#
# This file must stay ASCII-only: Windows PowerShell 5.1 reads .ps1 files without
# a BOM as ANSI, and non-ASCII bytes can swallow line breaks and break parsing.

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class DshInput {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool flag);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 2;
    public const uint KEYEVENTF_UNICODE = 4;

    public static void Scroll(int delta) {
        mouse_event(0x0800, 0, 0, (uint)delta, UIntPtr.Zero);
    }

    public static void TypeText(string text) {
        foreach (char c in text) {
            INPUT[] down = new INPUT[1];
            down[0].type = INPUT_KEYBOARD;
            down[0].u.ki.wVk = 0;
            down[0].u.ki.wScan = (ushort)c;
            down[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
            SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));

            INPUT[] up = new INPUT[1];
            up[0].type = INPUT_KEYBOARD;
            up[0].u.ki.wVk = 0;
            up[0].u.ki.wScan = (ushort)c;
            up[0].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(1);
        }
    }
}
'@

[void][DshInput]::SetProcessDPIAware()

$script:UseNormalized = $false
$script:ScreenWidth = 0
$script:ScreenHeight = 0

# Common virtual-key codes. Letters and digits are resolved by ASCII code.
$script:VkMap = @{
    'backspace' = 8
    'tab' = 9
    'enter' = 13
    'return' = 13
    'esc' = 27
    'escape' = 27
    'space' = 32
    'left' = 37
    'up' = 38
    'right' = 39
    'down' = 40
    'home' = 36
    'end' = 35
    'pageup' = 33
    'pagedown' = 34
    'insert' = 45
    'delete' = 46
    'shift' = 16
    'ctrl' = 17
    'control' = 17
    'alt' = 18
    'win' = 91
    'capslock' = 20
    'f1' = 112
    'f2' = 113
    'f3' = 114
    'f4' = 115
    'f5' = 116
    'f6' = 117
    'f7' = 118
    'f8' = 119
    'f9' = 120
    'f10' = 121
    'f11' = 122
    'f12' = 123
    'num0' = 96
    'num1' = 97
    'num2' = 98
    'num3' = 99
    'num4' = 100
    'num5' = 101
    'num6' = 102
    'num7' = 103
    'num8' = 104
    'num9' = 105
    'numpad0' = 96
    'numpad1' = 97
    'numpad2' = 98
    'numpad3' = 99
    'numpad4' = 100
    'numpad5' = 101
    'numpad6' = 102
    'numpad7' = 103
    'numpad8' = 104
    'numpad9' = 105
}

function Get-DshCursor {
    $point = [DshInput+POINT]::new()
    [void][DshInput]::GetCursorPos([ref]$point)
    return @{ x = $point.X; y = $point.Y }
}

function Get-DshScreenSummary {
    return @{ width = $script:ScreenWidth; height = $script:ScreenHeight }
}

function Resolve-Vk([string]$name) {
    $key = $name.Trim().ToLowerInvariant()
    if ($script:VkMap.ContainsKey($key)) {
        return [byte]$script:VkMap[$key]
    }
    if ($key.Length -eq 1) {
        $code = [int][char]$key.ToUpperInvariant()[0]
        if (($code -ge 48 -and $code -le 57) -or ($code -ge 65 -and $code -le 90)) {
            return [byte]$code
        }
    }
    throw "Unsupported key: $name"
}

function Key-Down([byte]$vk) {
    [DshInput]::keybd_event($vk, [byte]0, [uint32]0, [UIntPtr]::Zero)
}

function Key-Up([byte]$vk) {
    [DshInput]::keybd_event($vk, [byte]0, [uint32]2, [UIntPtr]::Zero)
}

function To-Pixel($value, [int]$total) {
    if ($null -eq $value -or $value -eq '') {
        return $null
    }
    $number = [double]$value
    if ($script:UseNormalized) {
        if ($number -lt 0) { $number = 0 }
        if ($number -gt 1) { $number = 1 }
        return [int][Math]::Round($number * $total)
    }
    return [int][Math]::Round($number)
}

function Find-DshWindow([string]$title, [string]$processName) {
    $candidates = @(Get-Process | Where-Object {
        if ($_.MainWindowHandle -eq 0) { return $false }
        $windowTitle = [string]$_.MainWindowTitle
        $procName = [string]$_.ProcessName
        if ($title -and $windowTitle -and $windowTitle.Contains($title)) { return $true }
        if ($processName -and $procName -and $procName.Contains($processName)) { return $true }
        return $false
    })
    if ($candidates.Count -eq 0) {
        throw "Window not found: $title $processName"
    }
    return $candidates[0]
}

function Focus-DshWindow([IntPtr]$handle) {
    if ([DshInput]::IsIconic($handle)) {
        [void][DshInput]::ShowWindow($handle, 9)
    }
    $foreground = [DshInput]::GetForegroundWindow()
    $foregroundProcessId = [uint32]0
    $foregroundThread = [DshInput]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
    $currentThread = [DshInput]::GetCurrentThreadId()
    $attached = $false
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
        $attached = [DshInput]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }
    $focused = [DshInput]::SetForegroundWindow($handle)
    if ($attached) {
        [void][DshInput]::AttachThreadInput($currentThread, $foregroundThread, $false)
    }
    Start-Sleep -Milliseconds 150
    return $focused
}

function Get-DshWindowInfo([IntPtr]$handle) {
    $rect = [DshInput+RECT]::new()
    [void][DshInput]::GetWindowRect($handle, [ref]$rect)
    $clientRect = [DshInput+RECT]::new()
    [void][DshInput]::GetClientRect($handle, [ref]$clientRect)
    $clientOrigin = [DshInput+POINT]::new()
    [void][DshInput]::ClientToScreen($handle, [ref]$clientOrigin)
    $processId = [uint32]0
    [void][DshInput]::GetWindowThreadProcessId($handle, [ref]$processId)
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    $title = ''
    $processName = ''
    if ($proc) {
        $title = [string]$proc.MainWindowTitle
        $processName = [string]$proc.ProcessName
    }
    return @{
        title = $title
        processId = [int]$processId
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
    }
}

# Pointer actions can target a window's client area: pass relative=true, and
# resolve window by title/process or fall back to the foreground window.
function Resolve-DshPointerWindow($request) {
    $relative = ($request.relative -eq $true)
    $title = [string]$request.window
    $processName = [string]$request.process
    if (-not $relative -and -not $title -and -not $processName) {
        return $null
    }
    if ($title -or $processName) {
        $target = Find-DshWindow $title $processName
        return Get-DshWindowInfo ([IntPtr]$target.MainWindowHandle)
    }
    $handle = [DshInput]::GetForegroundWindow()
    if ($handle -eq [IntPtr]::Zero) {
        throw 'Relative coordinates require a target window or a foreground window'
    }
    return Get-DshWindowInfo $handle
}

function Resolve-DshPointer($value, [int]$clientSize, $windowInfo, [string]$axis) {
    $pixel = To-Pixel $value $clientSize
    if ($null -eq $pixel) { return $null }
    if ($axis -eq 'x') { return [int]($windowInfo.client.left + $pixel) }
    return [int]($windowInfo.client.top + $pixel)
}

function Invoke-DshInput($request) {
    $action = [string]$request.action
    $script:UseNormalized = ($request.normalized -eq $true)
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $script:ScreenWidth = [int]$bounds.Width
    $script:ScreenHeight = [int]$bounds.Height

    if ($action -eq 'screen') {
        return @{
            screen = Get-DshScreenSummary
            cursor = Get-DshCursor
        }
    }

    if ($action -eq 'activate') {
        $title = [string]$request.window
        $processName = [string]$request.process
        if (-not $title -and -not $processName) {
            throw 'activate requires window or process'
        }
        $target = Find-DshWindow $title $processName
        $handle = [IntPtr]$target.MainWindowHandle
        $focused = Focus-DshWindow $handle
        $windowInfo = Get-DshWindowInfo $handle
        $windowInfo.focused = [bool]$focused
        return @{
            screen = Get-DshScreenSummary
            cursor = Get-DshCursor
            window = $windowInfo
        }
    }

    if ($action -eq 'move') {
        $windowInfo = $null
        if ($null -ne $request.dx -or $null -ne $request.dy) {
            # Nudge relative to the current cursor, used for fine aiming corrections.
            $current = Get-DshCursor
            $dx = 0
            $dy = 0
            if ($null -ne $request.dx) { $dx = [int]$request.dx }
            if ($null -ne $request.dy) { $dy = [int]$request.dy }
            $px = [Math]::Max(0, [Math]::Min($script:ScreenWidth - 1, $current.x + $dx))
            $py = [Math]::Max(0, [Math]::Min($script:ScreenHeight - 1, $current.y + $dy))
        } else {
            $windowInfo = Resolve-DshPointerWindow $request
            if ($windowInfo) {
                $px = Resolve-DshPointer $request.x ([int]$windowInfo.client.width) $windowInfo 'x'
                $py = Resolve-DshPointer $request.y ([int]$windowInfo.client.height) $windowInfo 'y'
            } else {
                $px = To-Pixel $request.x $script:ScreenWidth
                $py = To-Pixel $request.y $script:ScreenHeight
            }
        }
        if ($null -eq $px -or $null -eq $py) {
            throw 'move requires x/y or dx/dy'
        }
        $duration = 0
        if ($null -ne $request.duration_ms) { $duration = [int]$request.duration_ms }
        if ($duration -lt 0) { $duration = 0 }
        if ($duration -gt 5000) { $duration = 5000 }
        if ($duration -eq 0) {
            [void][DshInput]::SetCursorPos($px, $py)
        } else {
            $start = Get-DshCursor
            $steps = [int][Math]::Max(1, [Math]::Min(100, [Math]::Floor($duration / 10)))
            $delay = [int][Math]::Max(1, [Math]::Floor($duration / $steps))
            for ($i = 1; $i -le $steps; $i++) {
                $t = $i / $steps
                $cx = [int]($start.x + ($px - $start.x) * $t)
                $cy = [int]($start.y + ($py - $start.y) * $t)
                [void][DshInput]::SetCursorPos($cx, $cy)
                Start-Sleep -Milliseconds $delay
            }
        }
        $result = @{
            screen = Get-DshScreenSummary
            cursor = Get-DshCursor
        }
        if ($windowInfo) { $result.window = $windowInfo }
        return $result
    }

    if ($action -eq 'click') {
        $windowInfo = Resolve-DshPointerWindow $request
        if ($windowInfo) {
            $px = Resolve-DshPointer $request.x ([int]$windowInfo.client.width) $windowInfo 'x'
            $py = Resolve-DshPointer $request.y ([int]$windowInfo.client.height) $windowInfo 'y'
        } else {
            $px = To-Pixel $request.x $script:ScreenWidth
            $py = To-Pixel $request.y $script:ScreenHeight
        }
        if ($null -ne $px -and $null -ne $py) {
            [void][DshInput]::SetCursorPos($px, $py)
            Start-Sleep -Milliseconds 25
        }
        $button = 'left'
        if ($request.button) { $button = ([string]$request.button).ToLowerInvariant() }
        $downFlag = 0x0002
        $upFlag = 0x0004
        if ($button -eq 'right') { $downFlag = 0x0008; $upFlag = 0x0010 }
        elseif ($button -eq 'middle') { $downFlag = 0x0020; $upFlag = 0x0040 }
        elseif ($button -ne 'left') { throw "Unsupported mouse button: $button" }
        $count = 1
        if ($null -ne $request.count) { $count = [int]$request.count }
        if ($count -lt 1) { $count = 1 }
        if ($count -gt 3) { $count = 3 }
        $interval = 80
        if ($null -ne $request.interval_ms) { $interval = [int]$request.interval_ms }
        if ($interval -lt 20) { $interval = 20 }
        if ($interval -gt 500) { $interval = 500 }
        for ($i = 0; $i -lt $count; $i++) {
            [DshInput]::mouse_event([uint32]$downFlag, 0, 0, 0, [UIntPtr]::Zero)
            # Games that poll input per frame can miss a press shorter than one frame.
            Start-Sleep -Milliseconds 80
            [DshInput]::mouse_event([uint32]$upFlag, 0, 0, 0, [UIntPtr]::Zero)
            if ($i -lt ($count - 1)) {
                Start-Sleep -Milliseconds $interval
            }
        }
        $result = @{
            screen = Get-DshScreenSummary
            cursor = Get-DshCursor
        }
        if ($windowInfo) { $result.window = $windowInfo }
        return $result
    }

    if ($action -eq 'drag') {
        $windowInfo = Resolve-DshPointerWindow $request
        if ($windowInfo) {
            $fromX = Resolve-DshPointer $request.from_x ([int]$windowInfo.client.width) $windowInfo 'x'
            $fromY = Resolve-DshPointer $request.from_y ([int]$windowInfo.client.height) $windowInfo 'y'
            $toX = Resolve-DshPointer $request.to_x ([int]$windowInfo.client.width) $windowInfo 'x'
            $toY = Resolve-DshPointer $request.to_y ([int]$windowInfo.client.height) $windowInfo 'y'
        } else {
            $fromX = To-Pixel $request.from_x $script:ScreenWidth
            $fromY = To-Pixel $request.from_y $script:ScreenHeight
            $toX = To-Pixel $request.to_x $script:ScreenWidth
            $toY = To-Pixel $request.to_y $script:ScreenHeight
        }
        if ($null -eq $fromX -or $null -eq $fromY -or $null -eq $toX -or $null -eq $toY) {
            throw 'drag requires from_x, from_y, to_x and to_y'
        }
        $button = 'left'
        if ($request.button) { $button = ([string]$request.button).ToLowerInvariant() }
        $downFlag = 0x0002
        $upFlag = 0x0004
        if ($button -eq 'right') { $downFlag = 0x0008; $upFlag = 0x0010 }
        elseif ($button -eq 'middle') { $downFlag = 0x0020; $upFlag = 0x0040 }
        elseif ($button -ne 'left') { throw "Unsupported mouse button: $button" }
        $duration = 500
        if ($null -ne $request.duration_ms) { $duration = [int]$request.duration_ms }
        if ($duration -lt 0) { $duration = 0 }
        if ($duration -gt 5000) { $duration = 5000 }
        [void][DshInput]::SetCursorPos($fromX, $fromY)
        Start-Sleep -Milliseconds 30
        [DshInput]::mouse_event([uint32]$downFlag, 0, 0, 0, [UIntPtr]::Zero)
        $steps = [int][Math]::Max(1, [Math]::Min(100, [Math]::Floor($duration / 10)))
        $delay = 0
        if ($duration -gt 0) {
            $delay = [int][Math]::Max(1, [Math]::Floor($duration / $steps))
        }
        for ($i = 1; $i -le $steps; $i++) {
            $t = $i / $steps
            $cx = [int]($fromX + ($toX - $fromX) * $t)
            $cy = [int]($fromY + ($toY - $fromY) * $t)
            [void][DshInput]::SetCursorPos($cx, $cy)
            if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
        }
        [DshInput]::mouse_event([uint32]$upFlag, 0, 0, 0, [UIntPtr]::Zero)
        $result = @{
            screen = Get-DshScreenSummary
            cursor = Get-DshCursor
        }
        if ($windowInfo) { $result.window = $windowInfo }
        return $result
    }

    if ($action -eq 'scroll') {
        $windowInfo = Resolve-DshPointerWindow $request
        if ($windowInfo) {
            $px = Resolve-DshPointer $request.x ([int]$windowInfo.client.width) $windowInfo 'x'
            $py = Resolve-DshPointer $request.y ([int]$windowInfo.client.height) $windowInfo 'y'
        } else {
            $px = To-Pixel $request.x $script:ScreenWidth
            $py = To-Pixel $request.y $script:ScreenHeight
        }
        if ($null -ne $px -and $null -ne $py) {
            [void][DshInput]::SetCursorPos($px, $py)
        }
        $delta = [int]$request.delta
        if ($delta -eq 0) { throw 'scroll requires a non-zero delta' }
        if ($delta -lt -1200) { $delta = -1200 }
        if ($delta -gt 1200) { $delta = 1200 }
        [DshInput]::Scroll($delta)
        $result = @{
            screen = Get-DshScreenSummary
            cursor = Get-DshCursor
        }
        if ($windowInfo) { $result.window = $windowInfo }
        return $result
    }

    if ($action -eq 'key') {
        $spec = [string]$request.key
        if (-not $spec) { throw 'key requires a key, for example a or ctrl+a' }
        $parts = $spec -split '\+'
        $modifiers = @()
        for ($i = 0; $i -lt ($parts.Length - 1); $i++) {
            if (-not [string]::IsNullOrWhiteSpace($parts[$i])) {
                $modifiers += Resolve-Vk $parts[$i]
            }
        }
        $vk = Resolve-Vk $parts[$parts.Length - 1]
        $mode = 'press'
        if ($request.mode) { $mode = ([string]$request.mode).ToLowerInvariant() }
        if ($mode -ne 'press' -and $mode -ne 'down' -and $mode -ne 'up') {
            throw "Unsupported key mode: $mode"
        }
        $hold = 0
        if ($null -ne $request.hold_ms) { $hold = [int]$request.hold_ms }
        if ($hold -lt 0) { $hold = 0 }
        if ($hold -gt 2000) { $hold = 2000 }
        if ($mode -eq 'down') {
            foreach ($modifier in $modifiers) { Key-Down $modifier }
            Key-Down $vk
        } elseif ($mode -eq 'up') {
            Key-Up $vk
            for ($i = $modifiers.Length - 1; $i -ge 0; $i--) { Key-Up $modifiers[$i] }
        } else {
            foreach ($modifier in $modifiers) { Key-Down $modifier }
            Key-Down $vk
            if ($hold -gt 0) { Start-Sleep -Milliseconds $hold }
            Key-Up $vk
            for ($i = $modifiers.Length - 1; $i -ge 0; $i--) { Key-Up $modifiers[$i] }
        }
        return @{
            screen = Get-DshScreenSummary
            cursor = Get-DshCursor
        }
    }

    if ($action -eq 'type') {
        $text = [string]$request.text
        if ([string]::IsNullOrEmpty($text)) { throw 'type requires text' }
        if ($text.Length -gt 200) { throw 'type text is limited to 200 characters' }
        [DshInput]::TypeText($text)
        return @{
            screen = Get-DshScreenSummary
            cursor = Get-DshCursor
        }
    }

    throw "Unsupported action: $action"
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $request = $null
    try {
        $request = $line | ConvertFrom-Json
        $result = Invoke-DshInput $request
        @{
            id = $request.id
            ok = $true
            action = [string]$request.action
            result = $result
        } | ConvertTo-Json -Compress -Depth 8
    } catch {
        $id = $null
        if ($request) { $id = $request.id }
        @{
            id = $id
            ok = $false
            error = $_.Exception.Message
        } | ConvertTo-Json -Compress -Depth 8
    }
    [Console]::Out.Flush()
}
