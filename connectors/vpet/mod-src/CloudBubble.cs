using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace DshDaughter
{
    /// <summary>
    /// 桌宠头顶的云朵气泡：点击穿透、不抢焦点，默认约 6 秒淡出，鼠标悬停时暂停倒计时。
    /// </summary>
    internal sealed class CloudBubble : Window
    {
        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int WS_EX_LAYERED = 0x00080000;

        private const double VisibleMs = 6000;
        private const double WindowMargin = 14;

        private static readonly Geometry CloudGeometry = CreateCloudGeometry();

        private readonly Canvas canvas;
        private readonly Path cloud;
        private readonly TextBlock textBlock;
        private readonly ScaleTransform scale = new ScaleTransform(0.6, 0.6);
        private readonly TranslateTransform rise = new TranslateTransform(0, 20);
        private readonly DispatcherTimer ticker;

        private const double FollowIntervalMs = 60;
        private const double FollowLerp = 0.28;
        private const double SnapPx = 2.0;

        private Func<Point> anchorSource;
        private Point anchor;
        private double visibleMs;
        private double targetLeft;
        private double targetTop;
        private bool following;
        private int stillTicks;
        private int tickCount;
        private bool closing;
        private int generation;

        public CloudBubble()
        {
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ShowInTaskbar = false;
            ShowActivated = false;
            ResizeMode = ResizeMode.NoResize;
            Topmost = true;
            Focusable = false;
            IsHitTestVisible = false;

            var host = new Grid
            {
                Margin = new Thickness(WindowMargin),
                RenderTransformOrigin = new Point(0.5, 1),
                RenderTransform = new TransformGroup { Children = new TransformCollection { scale, rise } },
            };

            canvas = new Canvas();
            host.Children.Add(canvas);
            Content = host;

            cloud = new Path
            {
                Data = CloudGeometry,
                Stretch = Stretch.Fill,
                Fill = new LinearGradientBrush(
                    Color.FromRgb(0xFF, 0xFF, 0xFF),
                    Color.FromRgb(0xF5, 0xF8, 0xFF),
                    new Point(0.5, 0),
                    new Point(0.5, 1)),
                Stroke = new SolidColorBrush(Color.FromRgb(0xD8, 0xE0, 0xFA)),
                StrokeThickness = 1.4,
                Effect = new DropShadowEffect
                {
                    Color = Color.FromRgb(0x5A, 0x6A, 0xA5),
                    BlurRadius = 18,
                    ShadowDepth = 3,
                    Direction = 270,
                    Opacity = 0.22,
                },
            };
            canvas.Children.Add(cloud);

            textBlock = new TextBlock
            {
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 13.5,
                Foreground = new SolidColorBrush(Color.FromRgb(0x2E, 0x3A, 0x59)),
                TextWrapping = TextWrapping.Wrap,
                TextAlignment = TextAlignment.Center,
                LineHeight = 21,
            };
            canvas.Children.Add(textBlock);

            ticker = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(FollowIntervalMs) };
            ticker.Tick += (_, __) => OnTick();
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var hwnd = new WindowInteropHelper(this).Handle;
            var style = GetWindowLong(hwnd, GWL_EXSTYLE);
            SetWindowLong(hwnd, GWL_EXSTYLE, style | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED);
        }

        /// <summary>显示一段文字，anchorSource 每次返回桌宠头顶中心点（WPF 逻辑像素，屏幕坐标）。</summary>
        public void ShowText(string text, Func<Point> anchorSource)
        {
            if (string.IsNullOrWhiteSpace(text)) return;

            this.anchorSource = anchorSource;
            textBlock.Text = text.Trim();
            textBlock.Width = 260;
            textBlock.Measure(new Size(260, double.PositiveInfinity));
            var desired = textBlock.DesiredSize;
            var textWidth = Math.Min(260, Math.Max(96, desired.Width + 4));
            textBlock.Width = textWidth;
            textBlock.Measure(new Size(textWidth, double.PositiveInfinity));
            var textHeight = Math.Max(20, textBlock.DesiredSize.Height);

            var bubbleWidth = textWidth + 46;
            var bubbleHeight = textHeight + 42;

            canvas.Width = bubbleWidth;
            canvas.Height = bubbleHeight;
            cloud.Width = bubbleWidth;
            cloud.Height = bubbleHeight;

            Canvas.SetLeft(textBlock, (bubbleWidth - textWidth) / 2);
            Canvas.SetTop(textBlock, 15 + Math.Max(0, (bubbleHeight * 0.78 - 15 - textHeight) / 2));

            Width = bubbleWidth + WindowMargin * 2;
            Height = bubbleHeight + WindowMargin * 2;

            SnapToTarget();

            closing = false;
            visibleMs = 0;
            generation++;
            if (!IsVisible) Show();
            PlayIn();
            ticker.Start();
        }

        /// <summary>取当前锚点并换算成气泡窗口的目标左上角（已限制在虚拟屏幕内）。</summary>
        private void UpdateTarget()
        {
            if (anchorSource != null)
            {
                try
                {
                    anchor = anchorSource();
                }
                catch
                {
                    // 取不到位置时保持上一次的锚点
                }
            }

            var left = Math.Round(anchor.X - Width / 2);
            var top = Math.Round(Math.Max(4, anchor.Y + 4 - (Height - WindowMargin)));
            targetLeft = Math.Max(SystemParameters.VirtualScreenLeft, Math.Min(left, SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth - Width));
            targetTop = Math.Max(SystemParameters.VirtualScreenTop, Math.Min(top, SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight - Height));
        }

        /// <summary>新气泡出现时直接落到目标位置，避免从上一条气泡的位置滑过来。</summary>
        private void SnapToTarget()
        {
            UpdateTarget();
            Left = targetLeft;
            Top = targetTop;
            following = false;
            stillTicks = 0;
        }

        /// <summary>
        /// 平滑跟随：桌宠走动时按固定步长向目标位置插值，看起来是“跟上去”而不是逐帧跳动；
        /// 距离足够近时直接吸附，停止跟随以免空转。
        /// </summary>
        private void FollowTarget()
        {
            UpdateTarget();
            var dx = targetLeft - Left;
            var dy = targetTop - Top;
            if (Math.Abs(dx) <= SnapPx && Math.Abs(dy) <= SnapPx)
            {
                if (following)
                {
                    Left = targetLeft;
                    Top = targetTop;
                    following = false;
                }
                stillTicks++;
                return;
            }

            following = true;
            stillTicks = 0;
            // 取整到像素，避免亚像素级连续重排带来的合成抖动
            Left = Math.Round(Left + dx * FollowLerp);
            Top = Math.Round(Top + dy * FollowLerp);
        }

        private void PlayIn()
        {
            BeginAnimation(OpacityProperty, null);
            Opacity = 0;
            BeginAnimation(
                OpacityProperty,
                new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(200)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });

            var bump = new DoubleAnimation(0.6, 1, TimeSpan.FromMilliseconds(360))
            {
                EasingFunction = new BackEase { Amplitude = 0.32, EasingMode = EasingMode.EaseOut },
            };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, bump);
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, bump);

            rise.BeginAnimation(
                TranslateTransform.YProperty,
                new DoubleAnimation(20, 0, TimeSpan.FromMilliseconds(320))
                {
                    EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
                });
        }

        private void OnTick()
        {
            if (!IsVisible || closing) return;

            tickCount++;
            // 桌宠静止一小段时间后降到每 2 拍采样一次；一旦开始走动立刻恢复逐拍跟随
            if (stillTicks <= 6 || (tickCount & 1) == 0) FollowTarget();

            POINT cursor;
            if (!GetCursorPos(out cursor)) return;
            var local = PointFromScreen(new Point(cursor.X, cursor.Y));
            var hovering = local.X >= 0 && local.Y >= 0 && local.X <= ActualWidth && local.Y <= ActualHeight;
            if (hovering) return;

            visibleMs += ticker.Interval.TotalMilliseconds;
            if (visibleMs >= VisibleMs) FadeOut();
        }

        private void FadeOut()
        {
            if (closing) return;
            closing = true;
            ticker.Stop();

            var token = generation;
            var fade = new DoubleAnimation(Opacity, 0, TimeSpan.FromMilliseconds(280))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn },
            };
            fade.Completed += (_, __) =>
            {
                if (token != generation) return;
                Hide();
                closing = false;
            };
            BeginAnimation(OpacityProperty, fade);
        }

        public void CloseBubble()
        {
            generation++;
            ticker.Stop();
            Hide();
        }

        private static Geometry CreateCloudGeometry()
        {
            var cloud = Geometry.Parse(
                "M 30,90 C 12,90 2,78 10,64 C 0,50 12,34 30,37 C 34,16 66,8 82,24 " +
                "C 94,8 128,10 136,30 C 154,22 178,34 174,52 C 190,58 194,80 176,90 " +
                "C 150,98 56,98 30,90 Z");
            var tail = Geometry.Parse("M 91,84 L 109,84 L 100,110 Z");
            return new CombinedGeometry(GeometryCombineMode.Union, cloud, tail);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT point);

        [DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hwnd, int index);

        [DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hwnd, int index, int value);
    }
}
