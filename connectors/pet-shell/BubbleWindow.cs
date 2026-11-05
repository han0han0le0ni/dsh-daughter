using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Threading;

namespace DshPet
{
    /// <summary>
    /// 头顶气泡：独立透明小窗，跟着宠物窗口走，鼠标悬停时暂停倒计时。
    /// 不画云朵，只用一张圆角卡片，尽量少抢注意力。
    /// </summary>
    internal sealed class BubbleWindow : Window
    {
        private const double VisibleSeconds = 9;

        private readonly TextBlock text;
        private readonly Border card;
        private readonly DispatcherTimer life = new DispatcherTimer();
        private bool hovering;
        private double elapsed;

        public BubbleWindow()
        {
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ShowInTaskbar = false;
            ShowActivated = false;
            Topmost = true;
            ResizeMode = ResizeMode.NoResize;
            SizeToContent = SizeToContent.WidthAndHeight;
            WindowStartupLocation = WindowStartupLocation.Manual;
            SnapsToDevicePixels = true;

            text = new TextBlock
            {
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 13.5,
                Foreground = new SolidColorBrush(Color.FromRgb(0x2E, 0x3A, 0x59)),
                TextWrapping = TextWrapping.Wrap,
                TextAlignment = TextAlignment.Center,
                LineHeight = 21,
                MaxWidth = 260,
            };

            card = new Border
            {
                Background = new SolidColorBrush(Color.FromRgb(0xF6, 0xF9, 0xFF)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(0xDC, 0xE6, 0xF7)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(13),
                Padding = new Thickness(14, 9, 14, 10),
                Margin = new Thickness(14),
                Child = text,
                Effect = new DropShadowEffect
                {
                    Color = Color.FromRgb(0x5A, 0x6A, 0xA5),
                    BlurRadius = 16,
                    ShadowDepth = 3,
                    Direction = 270,
                    Opacity = 0.22,
                },
            };
            Content = card;

            life.Interval = TimeSpan.FromMilliseconds(120);
            life.Tick += OnLifeTick;
            MouseEnter += (_, __) => hovering = true;
            MouseLeave += (_, __) => hovering = false;
        }

        public void ShowText(string content, Point anchor, bool enabled)
        {
            if (!enabled || string.IsNullOrWhiteSpace(content))
            {
                Hide();
                return;
            }

            text.Text = content.Trim();
            elapsed = 0;
            hovering = false;

            if (!IsVisible) Show();
            UpdateLayout();
            PlaceAbove(anchor);

            BeginAnimation(OpacityProperty, null);
            Opacity = 0;
            BeginAnimation(
                OpacityProperty,
                new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(160))
                {
                    EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
                });

            life.Start();
        }

        private void PlaceAbove(Point anchor)
        {
            UpdateLayout();
            double width = ActualWidth;
            double height = ActualHeight;
            if (width <= 0 || height <= 0) return;

            double left = anchor.X - width / 2;
            double top = anchor.Y - height - 10;
            double minL = SystemParameters.VirtualScreenLeft;
            double minT = SystemParameters.VirtualScreenTop;
            double maxL = minL + SystemParameters.VirtualScreenWidth - width;
            double maxT = minT + SystemParameters.VirtualScreenHeight - height;
            Left = Math.Max(minL, Math.Min(left, maxL));
            Top = Math.Max(minT, Math.Min(top, maxT));
        }

        private void OnLifeTick(object sender, EventArgs e)
        {
            if (hovering) return;
            elapsed += life.Interval.TotalSeconds;
            if (elapsed < VisibleSeconds) return;
            life.Stop();
            var fade = new DoubleAnimation(Opacity, 0, TimeSpan.FromMilliseconds(240));
            fade.Completed += (_, __) => Hide();
            BeginAnimation(OpacityProperty, fade);
        }
    }
}
