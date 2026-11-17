using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using VPet_Simulator.Windows.Interface;

namespace DshDaughter
{
    internal sealed class PetWindowBounds
    {
        public int Left;
        public int Top;
        public int Width;
        public int Height;
    }

    /// <summary>
    /// 桌宠窗口的物理属性：置顶自愈、相对平移、头顶锚点，与动画/事件解耦。
    /// </summary>
    internal sealed class PetWindowController
    {
        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOPMOST = 0x00000008;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;

        private readonly IMainWindow window;
        private readonly PetLog log;
        private DispatcherTimer moveTimer;
        private bool topmostNoticeLogged;

        public PetWindowController(IMainWindow window, PetLog log)
        {
            this.window = window;
            this.log = log;
        }

        public bool IsMoving
        {
            get { return moveTimer != null; }
        }

        public bool IsTopmost
        {
            get
            {
                IntPtr hwnd = Handle();
                if (hwnd == IntPtr.Zero) return false;
                return (GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
            }
        }

        public PetWindowBounds Bounds()
        {
            var bounds = new PetWindowBounds();
            var frame = window as Window;
            if (frame == null) return bounds;
            bounds.Left = (int)Math.Round(frame.Left);
            bounds.Top = (int)Math.Round(frame.Top);
            bounds.Width = (int)Math.Round(frame.Width);
            bounds.Height = (int)Math.Round(frame.Height);
            return bounds;
        }

        /// <summary>
        /// 置顶自愈：游戏切到前台后 VPet 偶尔会丢掉 WS_EX_TOPMOST，导致全屏/无边框游戏盖住桌宠。
        /// 只在标志缺失时补一次，避免每 5 秒重建 Z 序打断游戏画面。
        /// </summary>
        public void EnsureTopmost()
        {
            try
            {
                IntPtr hwnd = Handle();
                if (hwnd == IntPtr.Zero) return;
                if (IsTopmost) return;

                SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                if (!topmostNoticeLogged)
                {
                    topmostNoticeLogged = true;
                    log.Write("topmost lost while game in foreground, re-asserted");
                }
            }
            catch (Exception error)
            {
                log.Write("topmost failed: " + error.GetType().Name + ": " + error.Message);
            }
        }

        /// <summary>接管位置：按像素相对平滑移动宠物窗口；不改变桌宠自身的活动逻辑。</summary>
        public void Move(int dx, int dy, int durationMs, Action onFinished)
        {
            try
            {
                var frame = window as Window;
                if (frame == null || (dx == 0 && dy == 0))
                {
                    if (onFinished != null) onFinished();
                    return;
                }

                StopMove();
                if (durationMs <= 0) durationMs = 600;
                if (durationMs > 5000) durationMs = 5000;

                double startLeft = frame.Left;
                double startTop = frame.Top;
                double total = durationMs;
                double elapsed = 0;
                var timer = new DispatcherTimer(DispatcherPriority.Render);
                timer.Interval = TimeSpan.FromMilliseconds(16);
                moveTimer = timer;
                timer.Tick += (sender, args) =>
                {
                    elapsed += 16;
                    double progress = Math.Min(1.0, elapsed / total);
                    double eased = 1 - Math.Pow(1 - progress, 3);
                    frame.Left = startLeft + dx * eased;
                    frame.Top = startTop + dy * eased;
                    if (progress >= 1.0)
                    {
                        timer.Stop();
                        if (moveTimer == timer) moveTimer = null;
                        if (onFinished != null) onFinished();
                    }
                };
                timer.Start();
                log.Write("move window by " + dx + "," + dy + " in " + durationMs + "ms");
            }
            catch (Exception error)
            {
                log.Write("move failed: " + error.GetType().Name + ": " + error.Message);
                StopMove();
                if (onFinished != null) onFinished();
            }
        }

        public void StopMove()
        {
            if (moveTimer == null) return;
            moveTimer.Stop();
            moveTimer = null;
        }

        public Point GetHeadAnchor()
        {
            try
            {
                var petGrid = window.Main.PetGrid;
                if (petGrid != null && petGrid.ActualWidth > 0 && petGrid.ActualHeight > 0)
                {
                    var screen = petGrid.PointToScreen(new Point(petGrid.ActualWidth / 2, 0));
                    var source = PresentationSource.FromVisual(petGrid);
                    var back = source == null ? null : source.CompositionTarget == null ? null : (Matrix?)source.CompositionTarget.TransformFromDevice;
                    if (back != null) return back.Value.Transform(screen);
                    return screen;
                }
            }
            catch (Exception error)
            {
                log.Write("anchor failed: " + error.GetType().Name + ": " + error.Message);
            }

            var frame = window as Window;
            if (frame != null)
            {
                return new Point(frame.Left + frame.Width / 2, frame.Top + Math.Max(24, frame.Width * 0.12));
            }
            return new Point(0, 0);
        }

        private IntPtr Handle()
        {
            var frame = window as Window;
            if (frame == null) return IntPtr.Zero;
            return new WindowInteropHelper(frame).Handle;
        }

        [DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hwnd, int index);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    }
}
