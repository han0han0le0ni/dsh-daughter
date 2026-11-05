using System;
using VPet_Simulator.Core;

namespace DshDaughter
{
    /// <summary>
    /// MOD 的自我描述与运行状态，供 /vpet/consumer/report 上报给 DSH。
    /// 让 DSH 不再靠猜：它能知道 MOD 支持哪些原生动画、现在忙不忙、玩家是否正在交互。
    /// </summary>
    internal sealed class ConsumerState
    {
        public const string Version = "dsh-daughter-mod/1.1";

        private readonly string[] graphs = Enum.GetNames(typeof(GraphInfo.GraphType));

        public bool Busy;
        public string BusyReason = "idle";
        public string CurrentGraph;
        public bool PlayerActive;
        public string LastInteractionAt;
        public int Queued;
        public int Dropped;
        public string Activity;
        public bool Topmost;
        public PetWindowBounds Bounds = new PetWindowBounds();
        public int LastSeq;

        public object Build()
        {
            return new
            {
                version = Version,
                at = DateTime.Now.ToString("o"),
                pollMs = DshDaughterPlugin.PollIntervalMs,
                capabilities = new
                {
                    graphs = graphs,
                    actions = new[] { "animate", "move", "bubble", "topmost" },
                    queue = true,
                    queueCapacity = 16,
                },
                state = new
                {
                    busy = Busy,
                    reason = BusyReason,
                    currentGraph = CurrentGraph,
                    playerActive = PlayerActive,
                    lastInteractionAt = LastInteractionAt,
                    queued = Queued,
                    dropped = Dropped,
                    activity = Activity,
                    topmost = Topmost,
                    lastSeq = LastSeq,
                    window = new
                    {
                        left = Bounds.Left,
                        top = Bounds.Top,
                        width = Bounds.Width,
                        height = Bounds.Height,
                    },
                },
            };
        }
    }
}
