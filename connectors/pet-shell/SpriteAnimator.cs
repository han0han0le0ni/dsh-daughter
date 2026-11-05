using System;
using System.Collections.Generic;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace DshPet
{
    /// <summary>
    /// PNG 序列帧播放器：按文件名里的帧时长推进，支持 起手→循环 n 次→收尾，也支持无限待机循环。
    /// 图片按显示尺寸解码并做 LRU，避免 849 帧的 IDEL 把内存吃穿。
    /// </summary>
    internal sealed class SpriteAnimator
    {
        private const int CacheLimit = 64;

        private readonly Image target;
        private readonly DispatcherTimer timer = new DispatcherTimer(DispatcherPriority.Render);
        private readonly Dictionary<string, BitmapSource> cache = new Dictionary<string, BitmapSource>();
        private readonly Queue<string> cacheOrder = new Queue<string>();

        private List<Frame> frames = new List<Frame>();
        private int index;
        private int epoch;
        private bool repeat;
        private Action onDone;
        private int decodeWidth = 550;

        public SpriteAnimator(Image target)
        {
            this.target = target;
            timer.Tick += OnTick;
        }

        /// <summary>每换一帧通知一次，窗口用它更新点击穿透所需的 alpha。</summary>
        public event Action<BitmapSource> FrameChanged;

        public bool IsPlaying => timer.IsEnabled;
        public string CurrentGraph { get; private set; }

        public void SetDecodeWidth(int width)
        {
            if (width > 0 && width != decodeWidth)
            {
                decodeWidth = width;
                cache.Clear();
                cacheOrder.Clear();
            }
        }

        public void Play(Clip clip, int loops, Action done)
        {
            if (clip == null)
            {
                done?.Invoke();
                return;
            }
            var list = new List<Frame>();
            if (clip.Start != null) list.AddRange(clip.Start.Frames);
            if (clip.Loop != null)
            {
                int times = loops <= 0 ? 1 : Math.Min(10, loops);
                for (int i = 0; i < times; i++) list.AddRange(clip.Loop.Frames);
            }
            if (clip.End != null) list.AddRange(clip.End.Frames);
            if (list.Count == 0)
            {
                done?.Invoke();
                return;
            }
            Start(list, clip.Graph, false, done);
        }

        /// <summary>常驻循环（Default / IDEL），直到被下一个动作打断。</summary>
        public void PlayLoop(Clip clip)
        {
            if (clip?.Loop == null || clip.Loop.Frames.Count == 0) return;
            Start(clip.Loop.Frames, clip.Graph, true, null);
        }

        public void Stop()
        {
            epoch++;
            timer.Stop();
            frames = new List<Frame>();
            index = 0;
            onDone = null;
            CurrentGraph = null;
        }

        private void Start(List<Frame> list, string graph, bool loop, Action done)
        {
            int token = ++epoch;
            frames = list;
            index = 0;
            repeat = loop;
            onDone = done;
            CurrentGraph = graph;
            Show(index);
            timer.Interval = TimeSpan.FromMilliseconds(Math.Max(20, frames[0].DurationMs));
            timer.Start();
            if (token != epoch) return;
        }

        private void OnTick(object sender, EventArgs e)
        {
            if (frames.Count == 0)
            {
                timer.Stop();
                return;
            }
            index++;
            if (index >= frames.Count)
            {
                if (!repeat)
                {
                    timer.Stop();
                    Action done = onDone;
                    onDone = null;
                    CurrentGraph = null;
                    done?.Invoke();
                    return;
                }
                index = 0;
            }
            Show(index);
            timer.Interval = TimeSpan.FromMilliseconds(Math.Max(20, frames[index].DurationMs));
        }

        private void Show(int position)
        {
            if (position < 0 || position >= frames.Count) return;
            BitmapSource bitmap = LoadBitmap(frames[position].Path);
            if (bitmap == null) return;
            target.Source = bitmap;
            FrameChanged?.Invoke(bitmap);
        }

        private BitmapSource LoadBitmap(string path)
        {
            if (cache.TryGetValue(path, out var hit)) return hit;
            try
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.UriSource = new Uri(path, UriKind.Absolute);
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
                image.DecodePixelWidth = decodeWidth;
                image.EndInit();
                image.Freeze();

                cache[path] = image;
                cacheOrder.Enqueue(path);
                while (cacheOrder.Count > CacheLimit)
                {
                    string old = cacheOrder.Dequeue();
                    cache.Remove(old);
                }
                return image;
            }
            catch
            {
                return null;
            }
        }
    }
}
