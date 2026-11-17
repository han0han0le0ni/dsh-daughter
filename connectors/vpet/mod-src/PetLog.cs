using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Threading;

namespace DshDaughter
{
    /// <summary>
    /// 轻量日志：UI 线程只入队，后台计时器批量落盘；避免同步文件 I/O 拖慢点击动画。
    /// </summary>
    internal sealed class PetLog : IDisposable
    {
        private const int MaxQueued = 200;

        private readonly ConcurrentQueue<string> queue = new ConcurrentQueue<string>();
        private readonly string path;
        private Timer timer;

        public PetLog(string path)
        {
            this.path = path;
        }

        public void Start()
        {
            if (timer != null) return;
            timer = new Timer(_ => Flush(), null, 1000, 2000);
        }

        public void Write(string message)
        {
            if (queue.Count >= MaxQueued) queue.TryDequeue(out _);
            queue.Enqueue(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message);
        }

        public void Flush()
        {
            if (queue.IsEmpty) return;
            var builder = new StringBuilder();
            string line;
            while (queue.TryDequeue(out line)) builder.AppendLine(line);
            try
            {
                File.AppendAllText(path, builder.ToString(), Encoding.UTF8);
            }
            catch
            {
                // 日志失败不影响桌宠
            }
        }

        public void Dispose()
        {
            if (timer != null)
            {
                timer.Dispose();
                timer = null;
            }
            Flush();
        }
    }
}
