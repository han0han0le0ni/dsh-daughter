using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace DshPet
{
    internal sealed class Frame
    {
        public string Path;
        public int DurationMs;
    }

    /// <summary>一个目录下的连续帧，Segments 是该目录相对 GraphType 的路径（如 Say/Self/A）。</summary>
    internal sealed class FrameSet
    {
        public string[] Segments;
        public List<Frame> Frames;
    }

    /// <summary>一次完整动作：起手 A → 循环 B → 收尾 C，缺哪段就跳过哪段。</summary>
    internal sealed class Clip
    {
        public string Graph;
        public FrameSet Start;
        public FrameSet Loop;
        public FrameSet End;
    }

    /// <summary>
    /// 扫描 VPet 素材目录，把 PNG 序列帧索引成可播放的 Clip。
    /// 只读文件，不需要游戏运行；帧时长取自文件名末尾（xxx_000_125.png 的 125）。
    /// </summary>
    internal sealed class AnimationLibrary
    {
        private static readonly Regex DurationPattern = new Regex(@"_(\d+)$", RegexOptions.Compiled);
        private readonly Dictionary<string, List<FrameSet>> graphs =
            new Dictionary<string, List<FrameSet>>(StringComparer.OrdinalIgnoreCase);

        public string Root { get; private set; }
        public int FrameCount { get; private set; }
        public int SetCount { get; private set; }
        public IReadOnlyCollection<string> Graphs => graphs.Keys;

        public bool Load(string root)
        {
            graphs.Clear();
            FrameCount = 0;
            SetCount = 0;
            Root = root;
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) return false;

            foreach (string graphDir in Directory.GetDirectories(root))
            {
                string graph = Path.GetFileName(graphDir);
                var grouped = new Dictionary<string, List<Frame>>(StringComparer.OrdinalIgnoreCase);
                try
                {
                    foreach (string file in Directory.EnumerateFiles(graphDir, "*.png", SearchOption.AllDirectories))
                    {
                        string relative = Path.GetRelativePath(graphDir, file);
                        string dir = Path.GetDirectoryName(relative) ?? string.Empty;
                        if (!grouped.TryGetValue(dir, out var list))
                        {
                            list = new List<Frame>();
                            grouped[dir] = list;
                        }
                        list.Add(new Frame { Path = file, DurationMs = ParseDuration(file) });
                    }
                }
                catch (Exception)
                {
                    // 单个动作目录读不动就跳过，不影响其它动作
                    continue;
                }

                var sets = new List<FrameSet>();
                foreach (var pair in grouped.OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    var frames = pair.Value
                        .OrderBy(f => Path.GetFileName(f.Path), StringComparer.Ordinal)
                        .ToList();
                    if (frames.Count == 0) continue;
                    sets.Add(new FrameSet
                    {
                        Segments = pair.Key.Length == 0
                            ? Array.Empty<string>()
                            : pair.Key.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries),
                        Frames = frames,
                    });
                    FrameCount += frames.Count;
                }
                if (sets.Count > 0)
                {
                    graphs[graph] = sets;
                    SetCount += sets.Count;
                }
            }
            return graphs.Count > 0;
        }

        private static int ParseDuration(string path)
        {
            string name = Path.GetFileNameWithoutExtension(path);
            Match match = DurationPattern.Match(name);
            if (match.Success && int.TryParse(match.Groups[1].Value, out int ms) && ms > 0 && ms <= 5000) return ms;
            return 125;
        }

        private static bool Has(FrameSet set, string name)
        {
            return !string.IsNullOrEmpty(name) &&
                   set.Segments.Any(s => s.Equals(name, StringComparison.OrdinalIgnoreCase));
        }

        private static char StageOf(FrameSet set)
        {
            if (set.Segments.Length == 0) return '\0';
            string last = set.Segments[set.Segments.Length - 1];
            if (last.Length == 0) return '\0';
            char c = char.ToUpperInvariant(last[0]);
            return c == 'A' || c == 'B' || c == 'C' ? c : '\0';
        }

        /// <summary>取优先表情（如 Self / Nomal）的帧组，全都对不上就退回原集合。</summary>
        private static List<FrameSet> Prefer(List<FrameSet> sets, string first, string second)
        {
            if (!string.IsNullOrEmpty(first))
            {
                var hit = sets.Where(s => Has(s, first)).ToList();
                if (hit.Count > 0) return hit;
            }
            if (!string.IsNullOrEmpty(second))
            {
                var hit = sets.Where(s => Has(s, second)).ToList();
                if (hit.Count > 0) return hit;
            }
            return sets;
        }

        /// <summary>
        /// 解析一个动作。prefer 用于挑表情组（如 Say 的 Self），emotion 用于挑状态组（如 Default 的 Nomal）。
        /// 没有 A/B/C 分段的动作整组当循环帧。
        /// </summary>
        public Clip Resolve(string graph, string prefer, string emotion, Random rng)
        {
            if (string.IsNullOrEmpty(graph)) return null;
            if (!graphs.TryGetValue(graph, out var all) || all.Count == 0) return null;

            List<FrameSet> picked = Prefer(all, prefer, emotion);
            if (picked.Count == 0) picked = all;

            var start = picked.FirstOrDefault(s => StageOf(s) == 'A');
            var loop = picked.FirstOrDefault(s => StageOf(s) == 'B');
            var end = picked.FirstOrDefault(s => StageOf(s) == 'C');

            if (start == null && loop == null && end == null)
            {
                // 没有分段（Default、IDEL 这类）：随机挑一组当循环
                var pool = picked;
                if (rng != null && pool.Count > 1) loop = pool[rng.Next(pool.Count)];
                else loop = pool[0];
            }
            if (start == null && loop == null && end == null) return null;

            return new Clip { Graph = graph, Start = start, Loop = loop, End = end };
        }

        /// <summary>从 IDEL 里随机挑一个小动作，用于长时间没消息时的自娱自乐。</summary>
        public Clip ResolveIdle(string emotion, Random rng)
        {
            if (rng == null) rng = new Random();
            if (!graphs.TryGetValue("IDEL", out var all) || all.Count == 0) return null;
            var pool = Prefer(all, emotion, null);
            if (pool.Count == 0) pool = all;
            var set = pool[rng.Next(pool.Count)];
            if (set == null || set.Frames.Count == 0) return null;
            return new Clip { Graph = "IDEL", Loop = set };
        }
    }
}
