using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace DshPet
{
    /// <summary>
    /// 独立的桌宠窗口：透明、置顶、可跨屏拖动，靠 alpha 判定点击穿透。
    /// 数据来自 DSH 的本地桥；桥断了就自己待机，连上再接事件。
    /// </summary>
    public partial class MainWindow : Window
    {
        private const int WM_NCHITTEST = 0x0084;
        private const int HTTRANSPARENT = -1;

        private readonly PetSettings settings = PetSettings.Load();
        private readonly AnimationLibrary library = new AnimationLibrary();
        private readonly Random random = new Random();
        private readonly SpriteAnimator animator;

        private BubbleWindow bubble;
        private BridgeClient bridge;
        private CancellationTokenSource lifetime;
        private DispatcherTimer idleTimer;
        private DispatcherTimer reportTimer;
        private int reportTicks;

        private Rect spriteRect = Rect.Empty;
        private byte[] alpha;
        private int alphaW;
        private int alphaH;
        private bool hasPosition;
        private string activity = string.Empty;

        private bool pointerDown;
        private bool dragging;
        private Point pressPoint;

        public MainWindow()
        {
            InitializeComponent();
            animator = new SpriteAnimator(Sprite);
            animator.FrameChanged += OnFrameChanged;
            Loaded += OnLoaded;
            Closed += OnClosed;

            MouseLeftButtonDown += OnMouseDown;
            MouseMove += OnMouseMove;
            MouseLeftButtonUp += OnMouseUp;
        }

        /* ------------------------------ 生命周期 ------------------------------ */

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            Topmost = settings.Topmost;
            bubble = new BubbleWindow();

            if (!LoadAssets())
            {
                MessageBox.Show(
                    "没有找到动画素材。\n\n请编辑 pet.json 里的 assetRoot，指向 VPet 的 pet 目录，例如：\n" +
                    @"E:\SteamLibrary\steamapps\common\VPet\mod\0000_core\pet\vup",
                    "DshPet",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
                Application.Current.Shutdown();
                return;
            }

            RestorePosition();
            hasPosition = true;
            PlayDefault();
            BuildMenu();

            idleTimer = new DispatcherTimer(DispatcherPriority.Background);
            idleTimer.Tick += OnIdleTick;
            ResetIdle();

            StartBridge();

            reportTimer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(1) };
            reportTimer.Tick += OnReportTick;
            reportTimer.Start();

            PetLog.Write("pet ready: frames=" + library.FrameCount + " sets=" + library.SetCount + " root=" + library.Root);
        }

        private void OnClosed(object sender, EventArgs e)
        {
            try
            {
                idleTimer?.Stop();
                reportTimer?.Stop();
                lifetime?.Cancel();
                bridge?.Dispose();
                bubble?.Close();
                settings.Left = Left;
                settings.Top = Top;
                settings.Save();
            }
            catch
            {
                // 退出路径不抛
            }
        }

        /* ------------------------------ 素材与布局 ------------------------------ */

        private bool LoadAssets()
        {
            if (!library.Load(settings.AssetRoot)) return false;
            var first = FirstFrame();
            if (first == null) return false;
            ApplyLayout(first);
            return true;
        }

        private BitmapSource FirstFrame()
        {
            Clip clip = library.Resolve("Default", null, settings.Emotion, null);
            if (clip == null) clip = library.Resolve(library.Graphs.Count > 0 ? System.Linq.Enumerable.First(library.Graphs) : null, null, null, null);
            FrameSet set = clip?.Loop ?? clip?.Start ?? clip?.End;
            if (set == null || set.Frames.Count == 0) return null;
            try
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.UriSource = new Uri(set.Frames[0].Path, UriKind.Absolute);
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
                image.EndInit();
                image.Freeze();
                return image;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>按首帧的非透明包围盒裁剪窗口，避免一个 1000×1000 的透明方块挡住桌面。</summary>
        private void ApplyLayout(BitmapSource frame)
        {
            Int32Rect bounds = ComputeBounds(frame);
            double scale = Math.Max(0.2, Math.Min(1.6, settings.Scale));
            double imageWidth = frame.PixelWidth * scale;
            double imageHeight = frame.PixelHeight * scale;

            Sprite.Width = imageWidth;
            Sprite.Height = imageHeight;
            Sprite.Margin = new Thickness(-bounds.X * scale, -bounds.Y * scale, 0, 0);

            double centerX = Left + Width / 2;
            double bottom = Top + Height;
            double nextWidth = Math.Max(32, bounds.Width * scale);
            double nextHeight = Math.Max(32, bounds.Height * scale);

            Width = nextWidth;
            Height = nextHeight;
            // 首次布局时窗口还没定位，别用默认的 0,0 去推位置，否则会闪一下再被 RestorePosition 纠正
            if (hasPosition && !double.IsNaN(centerX) && centerX > 0)
            {
                Left = centerX - nextWidth / 2;
                Top = bottom - nextHeight;
            }

            spriteRect = new Rect(-bounds.X * scale, -bounds.Y * scale, imageWidth, imageHeight);
            animator.SetDecodeWidth((int)Math.Max(64, imageWidth));
            ClampToScreen();
        }

        private static Int32Rect ComputeBounds(BitmapSource source)
        {
            try
            {
                var converted = new FormatConvertedBitmap(source, PixelFormats.Bgra32, null, 0);
                int w = converted.PixelWidth;
                int h = converted.PixelHeight;
                int stride = w * 4;
                var pixels = new byte[stride * h];
                converted.CopyPixels(pixels, stride, 0);

                int minX = w, minY = h, maxX = -1, maxY = -1;
                for (int y = 0; y < h; y++)
                {
                    int row = y * stride;
                    for (int x = 0; x < w; x++)
                    {
                        if (pixels[row + x * 4 + 3] <= 8) continue;
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
                if (maxX < 0) return new Int32Rect(0, 0, w, h);
                return new Int32Rect(minX, minY, maxX - minX + 1, maxY - minY + 1);
            }
            catch
            {
                return new Int32Rect(0, 0, source.PixelWidth, source.PixelHeight);
            }
        }

        private void RestorePosition()
        {
            if (settings.Left is double left && settings.Top is double top)
            {
                Left = left;
                Top = top;
            }
            else
            {
                Rect work = SystemParameters.WorkArea;
                Left = work.Right - Width - 60;
                Top = work.Bottom - Height - 24;
            }
            ClampToScreen();
        }

        private void ClampToScreen()
        {
            double minLeft = SystemParameters.VirtualScreenLeft;
            double minTop = SystemParameters.VirtualScreenTop;
            double maxLeft = minLeft + SystemParameters.VirtualScreenWidth - Width;
            double maxTop = minTop + SystemParameters.VirtualScreenHeight - Height;
            Left = Math.Max(minLeft, Math.Min(Left, Math.Max(minLeft, maxLeft)));
            Top = Math.Max(minTop, Math.Min(Top, Math.Max(minTop, maxTop)));
        }

        /* ------------------------------ 播放 ------------------------------ */

        private void PlayDefault()
        {
            Clip clip = library.Resolve("Default", null, settings.Emotion, random);
            if (clip?.Loop != null) animator.PlayLoop(clip);
        }

        private void PlayGraph(string graph, int loops)
        {
            Clip clip = library.Resolve(graph, "Self", settings.Emotion, random);
            if (clip == null)
            {
                // 素材里没有这个动作就退回待机，不弹错误
                PlayDefault();
                return;
            }
            activity = graph;
            animator.Play(clip, loops <= 0 ? 1 : loops, PlayDefault);
        }

        private void PatHead()
        {
            PlayGraph("Touch_Head", 1);
            ResetIdle();
        }

        private void ResetIdle()
        {
            if (idleTimer == null) return;
            idleTimer.Stop();
            int min = Math.Max(5000, settings.IdleMinMs);
            int max = Math.Max(min + 1000, settings.IdleMaxMs);
            idleTimer.Interval = TimeSpan.FromMilliseconds(random.Next(min, max));
            idleTimer.Start();
        }

        private void OnIdleTick(object sender, EventArgs e)
        {
            idleTimer.Stop();
            Clip clip = library.ResolveIdle(settings.Emotion, random);
            if (clip != null)
            {
                activity = "IDEL";
                animator.Play(clip, 1, PlayDefault);
            }
            ResetIdle();
        }

        /* ------------------------------ 桥接 ------------------------------ */

        private void StartBridge()
        {
            lifetime = new CancellationTokenSource();
            bridge = new BridgeClient(settings.BridgeUrl);
            CancellationToken token = lifetime.Token;
            _ = Task.Run(() => bridge.RunAsync(ev =>
            {
                Dispatcher.InvokeAsync(() => HandleEvent(ev));
                return Task.CompletedTask;
            }, token), token);
        }

        private void HandleEvent(PetEvent ev)
        {
            if (ev == null) return;
            switch (ev.Kind)
            {
                case "reply":
                    PlayGraph("Say", 1);
                    Say(ev.Text);
                    break;
                case "thinking":
                case "tool":
                    PlayGraph("Think", 1);
                    break;
                case "error":
                    PlayGraph("Default", 1);
                    Say(ev.Text);
                    break;
                case "motion":
                    PlayGraph(string.IsNullOrEmpty(ev.Graph) ? "Say" : ev.Graph, ev.Loops);
                    break;
                case "move":
                    Left += ev.Dx;
                    Top += ev.Dy;
                    ClampToScreen();
                    settings.Left = Left;
                    settings.Top = Top;
                    settings.Save();
                    break;
            }
            ResetIdle();
        }

        private void Say(string text)
        {
            if (bubble == null || string.IsNullOrWhiteSpace(text)) return;
            bubble.ShowText(text, new Point(Left + Width / 2, Top + 4), settings.Bubble);
        }

        private async void OnReportTick(object sender, EventArgs e)
        {
            if (bridge == null || !bridge.Online || lifetime == null) return;
            try
            {
                await bridge.ReportAsync(Snapshot(), lifetime.Token);
                reportTicks++;
                if (reportTicks % 5 == 0) await bridge.HeartbeatAsync(lifetime.Token);
            }
            catch (OperationCanceledException)
            {
                // 退出中
            }
            catch
            {
                // 上报失败下一轮再试
            }
        }

        private PetSnapshot Snapshot()
        {
            return new PetSnapshot
            {
                Busy = dragging || animator.IsPlaying,
                Reason = dragging ? "player" : animator.IsPlaying ? "animating" : "idle",
                CurrentGraph = animator.CurrentGraph,
                PlayerActive = dragging,
                Queued = 0,
                Dropped = 0,
                Activity = activity,
                Topmost = Topmost,
                LastSeq = bridge?.LastSeq ?? 0,
                Left = Left,
                Top = Top,
                Width = Width,
                Height = Height,
            };
        }

        /* --------------------------- 点击穿透（alpha） --------------------------- */

        private void OnFrameChanged(BitmapSource frame)
        {
            if (!settings.ClickThrough || frame == null) return;
            try
            {
                // 缩到 1/4 再取 alpha，够判定又省内存
                var scaled = new TransformedBitmap(frame, new ScaleTransform(0.25, 0.25));
                var converted = new FormatConvertedBitmap(scaled, PixelFormats.Bgra32, null, 0);
                int w = converted.PixelWidth;
                int h = converted.PixelHeight;
                if (w <= 0 || h <= 0) return;
                int stride = w * 4;
                var pixels = new byte[stride * h];
                converted.CopyPixels(pixels, stride, 0);

                var mask = new byte[w * h];
                for (int y = 0; y < h; y++)
                {
                    int row = y * stride;
                    for (int x = 0; x < w; x++) mask[y * w + x] = pixels[row + x * 4 + 3];
                }
                alpha = mask;
                alphaW = w;
                alphaH = h;
            }
            catch
            {
                alpha = null;
            }
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var source = PresentationSource.FromVisual(this) as HwndSource;
            source?.AddHook(WndProc);
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg != WM_NCHITTEST || !settings.ClickThrough || alpha == null || alphaW <= 0 || alphaH <= 0)
                return IntPtr.Zero;

            try
            {
                long packed = lParam.ToInt64();
                int screenX = (short)(packed & 0xFFFF);
                int screenY = (short)((packed >> 16) & 0xFFFF);

                GetWindowRect(hwnd, out RECT rect);
                double width = rect.Right - rect.Left;
                double height = rect.Bottom - rect.Top;
                if (width <= 0 || height <= 0) return IntPtr.Zero;

                // 用窗口内的相对比例定位，绕开不同屏幕的 DPI 换算
                double relX = (screenX - rect.Left) / width;
                double relY = (screenY - rect.Top) / height;
                double localX = relX * Width;
                double localY = relY * Height;

                if (spriteRect.IsEmpty || !spriteRect.Contains(new Point(localX, localY)))
                {
                    handled = true;
                    return new IntPtr(HTTRANSPARENT);
                }

                double imgX = (localX - spriteRect.X) / spriteRect.Width;
                double imgY = (localY - spriteRect.Y) / spriteRect.Height;
                int px = (int)(imgX * alphaW);
                int py = (int)(imgY * alphaH);
                if (px < 0 || py < 0 || px >= alphaW || py >= alphaH)
                {
                    handled = true;
                    return new IntPtr(HTTRANSPARENT);
                }
                if (alpha[py * alphaW + px] < 12)
                {
                    handled = true;
                    return new IntPtr(HTTRANSPARENT);
                }
            }
            catch
            {
                // 判定失败就当普通点击
            }
            return IntPtr.Zero;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        /* ------------------------------ 交互 ------------------------------ */

        private void OnMouseDown(object sender, MouseButtonEventArgs e)
        {
            if (e.ChangedButton != MouseButton.Left) return;
            pointerDown = true;
            dragging = false;
            pressPoint = e.GetPosition(this);
            CaptureMouse();
        }

        private void OnMouseMove(object sender, MouseEventArgs e)
        {
            if (!pointerDown || dragging) return;
            Point now = e.GetPosition(this);
            if (Math.Abs(now.X - pressPoint.X) + Math.Abs(now.Y - pressPoint.Y) < 4) return;

            dragging = true;
            pointerDown = false;
            ReleaseMouseCapture();
            try
            {
                DragMove();
            }
            catch
            {
                // 拖拽被打断不影响其它操作
            }
            dragging = false;
            ClampToScreen();
            settings.Left = Left;
            settings.Top = Top;
            settings.Save();
        }

        private void OnMouseUp(object sender, MouseButtonEventArgs e)
        {
            if (e.ChangedButton != MouseButton.Left) return;
            if (pointerDown)
            {
                pointerDown = false;
                ReleaseMouseCapture();
                PatHead();
            }
        }

        /* ------------------------------ 右键菜单 ------------------------------ */

        private void BuildMenu()
        {
            var menu = new ContextMenu();

            MenuItem top = new MenuItem { Header = "总在最前", IsCheckable = true, IsChecked = settings.Topmost };
            top.Click += (_, __) =>
            {
                settings.Topmost = top.IsChecked;
                Topmost = settings.Topmost;
                settings.Save();
            };
            menu.Items.Add(top);

            MenuItem bubbleItem = new MenuItem { Header = "显示气泡", IsCheckable = true, IsChecked = settings.Bubble };
            bubbleItem.Click += (_, __) =>
            {
                settings.Bubble = bubbleItem.IsChecked;
                settings.Save();
            };
            menu.Items.Add(bubbleItem);

            MenuItem clickThrough = new MenuItem { Header = "透明处点击穿透", IsCheckable = true, IsChecked = settings.ClickThrough };
            clickThrough.Click += (_, __) =>
            {
                settings.ClickThrough = clickThrough.IsChecked;
                settings.Save();
                if (!settings.ClickThrough) alpha = null;
            };
            menu.Items.Add(clickThrough);

            var sizeMenu = new MenuItem { Header = "大小" };
            foreach (double scale in new[] { 0.35, 0.45, 0.55, 0.7, 0.85 })
            {
                double value = scale;
                var item = new MenuItem
                {
                    Header = (int)(value * 100) + "%",
                    IsCheckable = true,
                    IsChecked = Math.Abs(settings.Scale - value) < 0.001,
                };
                item.Click += (_, __) =>
                {
                    settings.Scale = value;
                    settings.Save();
                    ReloadLayout();
                };
                sizeMenu.Items.Add(item);
            }
            menu.Items.Add(sizeMenu);

            menu.Items.Add(new Separator());

            MenuItem reload = new MenuItem { Header = "重新载入素材" };
            reload.Click += (_, __) =>
            {
                if (library.Load(settings.AssetRoot))
                {
                    BitmapSource first = FirstFrame();
                    if (first != null) ApplyLayout(first);
                    PlayDefault();
                }
            };
            menu.Items.Add(reload);

            MenuItem openSettings = new MenuItem { Header = "打开设置文件" };
            openSettings.Click += (_, __) =>
            {
                try
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + PetSettings.SettingsPath + "\"")
                    {
                        UseShellExecute = true,
                    });
                }
                catch
                {
                    // 打不开就算了
                }
            };
            menu.Items.Add(openSettings);

            menu.Items.Add(new Separator());

            MenuItem exit = new MenuItem { Header = "退出" };
            exit.Click += (_, __) => Close();
            menu.Items.Add(exit);

            ContextMenu = menu;
        }

        private void ReloadLayout()
        {
            BitmapSource first = FirstFrame();
            if (first != null) ApplyLayout(first);
            PlayDefault();
            ClampToScreen();
        }
    }
}
