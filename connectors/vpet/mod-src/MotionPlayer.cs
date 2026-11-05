using System;
using VPet_Simulator.Core;
using VPet_Simulator.Windows.Interface;

namespace DshDaughter
{
    /// <summary>
    /// 动画执行器：只负责让 VPet 播放原生 GraphType 动画，并保证旧动画的回调不会打断新动画。
    /// 是否该播、什么时候播由 Plugin 根据冲突状态决定。
    /// </summary>
    internal sealed class MotionPlayer
    {
        /// <summary>两次自主动作的最小间隔：避免连续事件把点击动画打断成"卡"。</summary>
        private const int ReactionIntervalMs = 1200;

        /// <summary>动画卡住的安全阈值：很久没有回调就复位，避免排队永久阻塞。</summary>
        private const int StuckResetMs = 20_000;

        private readonly IMainWindow window;
        private readonly PetLog log;

        private int epoch;
        private bool animating;
        private DateTime animationStartedAt = DateTime.MinValue;
        private DateTime lastReactionAt = DateTime.MinValue;

        public MotionPlayer(IMainWindow window, PetLog log)
        {
            this.window = window;
            this.log = log;
        }

        public bool IsAnimating
        {
            get { return animating; }
        }

        public string CurrentGraph { get; private set; }

        /// <summary>动作包：motionId 映射到原生动画；DSH 也可直接用 graph 指定 GraphType。</summary>
        public void PlayMotion(string motionId, string graph, int loops, Action onFinished)
        {
            GraphInfo.GraphType parsed;
            if (!string.IsNullOrEmpty(graph) && Enum.TryParse<GraphInfo.GraphType>(graph, true, out parsed))
            {
                PlayGraph(parsed, loops, onFinished);
                return;
            }
            if (string.IsNullOrEmpty(motionId))
            {
                if (onFinished != null) onFinished();
                return;
            }

            switch (motionId)
            {
                case "MOT-HUG":
                    PlayGraph(GraphInfo.GraphType.Touch_Body, loops, onFinished);
                    break;
                case "MOT-PAT":
                    PlayGraph(GraphInfo.GraphType.Touch_Head, loops, onFinished);
                    break;
                default:
                    PlayGraph(GraphInfo.GraphType.Say, loops, onFinished);
                    break;
            }
        }

        /// <summary>
        /// 自主事件只用 Say 动作：Touch_* 是玩家的点击反馈，被 MOD 反复抢占会让人觉得"点了没反应"。
        /// </summary>
        public void PlayReaction(Action onFinished)
        {
            DateTime now = DateTime.UtcNow;
            if (animating || (now - lastReactionAt).TotalMilliseconds < ReactionIntervalMs)
            {
                if (onFinished != null) onFinished();
                return;
            }
            lastReactionAt = now;
            PlayGraph(GraphInfo.GraphType.Say, 1, onFinished);
        }

        /// <summary>播放原生 A_Start → B_Loop → C_End 动画，并回到默认状态；新指令让旧回调失效。</summary>
        public void PlayGraph(GraphInfo.GraphType type, int loops, Action onFinished)
        {
            int count = loops <= 0 ? 1 : Math.Min(10, loops);
            int token = ++epoch;
            animating = true;
            animationStartedAt = DateTime.Now;
            CurrentGraph = type.ToString();

            try
            {
                window.Main.Display(type, GraphInfo.AnimatType.A_Start, (Action<string>)(name =>
                {
                    if (token != epoch) return;
                    if (string.IsNullOrEmpty(name))
                    {
                        Finish(() => window.Main.DisplayToNomal(), onFinished);
                        return;
                    }
                    Loop(name, type, count, token, onFinished);
                }));
            }
            catch (Exception error)
            {
                log.Write("animation failed: " + error.GetType().Name + ": " + error.Message);
                Finish(null, onFinished);
            }
        }

        /// <summary>动画长时间没有回调时强制复位，防止一次被 VPet 自身动画打断就永久卡住队列。</summary>
        public void ResetIfStuck()
        {
            if (!animating) return;
            if ((DateTime.Now - animationStartedAt).TotalMilliseconds < StuckResetMs) return;
            log.Write("animation stuck for " + StuckResetMs + "ms, reset");
            epoch++;
            animating = false;
            CurrentGraph = null;
            try
            {
                window.Main.DisplayToNomal();
            }
            catch
            {
                // 复位失败不影响后续指令
            }
        }

        private void Loop(string name, GraphInfo.GraphType type, int loops, int token, Action onFinished)
        {
            if (token != epoch) return;
            window.Main.Display(name, GraphInfo.AnimatType.B_Loop, type, (Action<string>)(next =>
            {
                if (token != epoch) return;
                if (loops > 1) Loop(next, type, loops - 1, token, onFinished);
                else Finish(() => window.Main.DisplayCEndtoNomal(next), onFinished);
            }));
        }

        private void Finish(Action restore, Action onFinished)
        {
            animating = false;
            CurrentGraph = null;
            try
            {
                if (restore != null) restore();
            }
            catch (Exception error)
            {
                log.Write("animation restore failed: " + error.GetType().Name + ": " + error.Message);
            }
            if (onFinished != null) onFinished();
        }
    }
}
