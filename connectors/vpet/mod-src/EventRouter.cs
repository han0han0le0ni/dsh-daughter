using System;

namespace DshDaughter
{
    /// <summary>
    /// 事件路由：把 DSH 事件翻译成"气泡 + 待执行指令"。
    /// 这里只做协议到本地动作的映射，不懂冲突与排队——队列由 Plugin 统一调度。
    /// </summary>
    internal sealed class EventRouter
    {
        private readonly PetLog log;
        private readonly Action<string> bubble;
        private readonly Action<PetCommand> enqueue;
        private readonly Action reassertTopmost;
        /// <summary>最近一次回复时间，避免紧随其后的工具气泡把刚说的话顶掉。</summary>
        private int lastReplyAt;

        public EventRouter(PetLog log, Action<string> bubble, Action<PetCommand> enqueue, Action reassertTopmost)
        {
            this.log = log;
            this.bubble = bubble;
            this.enqueue = enqueue;
            this.reassertTopmost = reassertTopmost;
        }

        public void Route(PetEvent item)
        {
            if (item == null) return;
            log.Write("event: " + item.Kind + (string.IsNullOrEmpty(item.Text) ? "" : " " + item.Text));

            switch (item.Kind)
            {
                case "reply":
                    lastReplyAt = Environment.TickCount;
                    enqueue(new PetCommand { Kind = PetCommandKind.Reaction });
                    bubble(item.Text ?? "……");
                    break;
                case "thinking":
                    bubble(item.Text ?? "让我想想…");
                    break;
                case "tool":
                    enqueue(new PetCommand { Kind = PetCommandKind.Reaction });
                    // 刚说完话就立刻换工具气泡会把台词顶掉，保留回复 3 秒。
                    if (Environment.TickCount - lastReplyAt > 3000) bubble(item.Text ?? "正在处理…");
                    break;
                case "error":
                    enqueue(new PetCommand { Kind = PetCommandKind.Reaction });
                    reassertTopmost();
                    bubble(item.Text ?? "呜…出了点问题");
                    break;
                case "motion":
                    enqueue(new PetCommand
                    {
                        Kind = PetCommandKind.Motion,
                        Graph = item.Graph,
                        MotionId = item.MotionId,
                        Loops = item.Loops,
                    });
                    if (!string.IsNullOrEmpty(item.Text)) bubble(item.Text);
                    break;
                case "move":
                    enqueue(new PetCommand
                    {
                        Kind = PetCommandKind.Move,
                        Dx = item.Dx,
                        Dy = item.Dy,
                        DurationMs = item.DurationMs,
                    });
                    break;
            }
        }
    }
}
