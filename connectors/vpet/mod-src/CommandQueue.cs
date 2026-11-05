using System;
using System.Collections.Generic;

namespace DshDaughter
{
    internal static class PetCommandKind
    {
        public const string Motion = "motion";
        public const string Reaction = "reaction";
        public const string Move = "move";
    }

    /// <summary>一条等待执行的桌宠指令，来源是 DSH 的事件队列。</summary>
    internal sealed class PetCommand
    {
        public string Kind;
        public string Graph;
        public string MotionId;
        public int Loops;
        public int Dx;
        public int Dy;
        public int DurationMs;
        public DateTime EnqueuedAt;
    }

    /// <summary>
    /// 冲突协调用的本地队列：玩家正在交互、桌宠在打工/睡觉、或上一条动画没播完时，
    /// DSH 的动作与位移先排队，空闲后按到达顺序执行；过期指令直接丢弃，避免突然跳变。
    /// </summary>
    internal sealed class CommandQueue
    {
        private const int Capacity = 16;
        private const int MaxAgeMs = 20_000;

        private readonly Queue<PetCommand> items = new Queue<PetCommand>();
        private readonly PetLog log;
        private int dropped;

        public CommandQueue(PetLog log)
        {
            this.log = log;
        }

        public int Count
        {
            get { return items.Count; }
        }

        public int Dropped
        {
            get { return dropped; }
        }

        public void Enqueue(PetCommand command)
        {
            command.EnqueuedAt = DateTime.Now;
            if (items.Count >= Capacity)
            {
                // 队列已满时丢最旧的：保留最近的指令，避免动作滞后太多
                items.Dequeue();
                dropped++;
                log.Write("command queue full, dropped oldest: " + command.Kind);
            }
            items.Enqueue(command);
        }

        /// <summary>取出下一条未过期指令；过期指令计入 dropped。</summary>
        public PetCommand Dequeue()
        {
            DateTime now = DateTime.Now;
            while (items.Count > 0)
            {
                PetCommand command = items.Dequeue();
                if ((now - command.EnqueuedAt).TotalMilliseconds <= MaxAgeMs) return command;
                dropped++;
                log.Write("command expired: " + command.Kind + " " + (command.Graph ?? command.MotionId ?? ""));
            }
            return null;
        }

        public void Clear()
        {
            items.Clear();
        }
    }
}
