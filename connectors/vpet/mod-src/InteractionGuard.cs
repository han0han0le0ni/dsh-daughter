using System;
using VPet_Simulator.Windows.Interface;

namespace DshDaughter
{
    /// <summary>
    /// 玩家交互感知：桌宠被摸头/摸身体或窗口被点击后的短时间内由 MOD 本地优先，
    /// 期间 DSH 下发的动作排队等待，避免抢走玩家点击的反馈动画。
    /// </summary>
    internal sealed class InteractionGuard : IDisposable
    {
        private const int PriorityMs = 2500;

        private readonly IMainWindow window;
        private readonly PetLog log;
        private DateTime activeUntil = DateTime.MinValue;
        private long lastClickStamp = long.MinValue;
        private bool attached;

        public InteractionGuard(IMainWindow window, PetLog log)
        {
            this.window = window;
            this.log = log;
        }

        public DateTime LastInteractionAt { get; private set; }

        public void Attach()
        {
            if (attached) return;
            try
            {
                var main = window.Main;
                if (main != null)
                {
                    main.Event_TouchHead += OnTouch;
                    main.Event_TouchBody += OnTouch;
                    attached = true;
                    log.Write("interaction guard attached");
                }
            }
            catch (Exception error)
            {
                log.Write("interaction attach failed: " + error.GetType().Name + ": " + error.Message);
            }
        }

        /// <summary>兜底：玩家拖动/点击窗口时 IMainWindow 会更新 lastclicktime，但没有触发摸头事件。</summary>
        public void Refresh()
        {
            try
            {
                long stamp = window.lastclicktime;
                if (stamp != lastClickStamp)
                {
                    lastClickStamp = stamp;
                    if (stamp > 0) Mark();
                }
            }
            catch
            {
                // 读不到点击时间时只依赖摸头事件
            }
        }

        public bool IsActive()
        {
            return DateTime.Now < activeUntil;
        }

        public void Dispose()
        {
            if (!attached) return;
            attached = false;
            try
            {
                var main = window.Main;
                if (main != null)
                {
                    main.Event_TouchHead -= OnTouch;
                    main.Event_TouchBody -= OnTouch;
                }
            }
            catch
            {
                // 退出时取不到 Main 可忽略
            }
        }

        private void OnTouch()
        {
            Mark();
        }

        private void Mark()
        {
            activeUntil = DateTime.Now.AddMilliseconds(PriorityMs);
            LastInteractionAt = DateTime.Now;
        }
    }
}
