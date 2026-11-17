using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using VPet_Simulator.Windows.Interface;

namespace DshDaughter
{
    /// <summary>
    /// VPet 代码 MOD：轮询 DSH 陪伴插件的 /vpet/events 端点，按状态触发桌宠动画与气泡。
    ///
    /// 本类只做编排：HTTP 交给 DshClient，事件翻译交给 EventRouter，
    /// 动画交给 MotionPlayer，窗口属性交给 PetWindowController，
    /// 冲突与排队由本类根据玩家交互、桌宠原生状态和 MOD 自身忙闲统一裁决。
    /// </summary>
    public class DshDaughterPlugin : MainPlugin
    {
        public const int PollIntervalMs = 1000;

        /// <summary>置顶自愈间隔：只检查标志，不做重复 SetWindowPos。</summary>
        private const int TopmostIntervalMs = 5000;

        /// <summary>状态回传心跳：即使状态没变也定期上报，方便 DSH 判断 MOD 是否活着。</summary>
        private const int ReportHeartbeatMs = 10_000;

        private readonly string endpoint;
        private readonly PetLog log;
        private DshClient client;
        private InteractionGuard interaction;
        private CommandQueue queue;
        private MotionPlayer motions;
        private PetWindowController windows;
        private EventRouter router;
        private ConsumerState consumer;
        private CloudBubble bubble;
        private DispatcherTimer pollTimer;
        private DispatcherTimer topmostTimer;
        private bool polling;

        /// <summary>已处理到的服务端事件序号；-1 表示尚未从 /vpet/status 取到起点。</summary>
        private int lastSeq = -1;
        private bool cursorSeeded;
        private bool legacyMode;
        private DateTime lastPollErrorAt = DateTime.MinValue;
        private DateTime lastUpgradeProbeAt = DateTime.MinValue;

        private DateTime lastReportAt = DateTime.MinValue;
        private DateTime lastReportAttemptAt = DateTime.MinValue;
        private string lastReportSignature = string.Empty;
        private bool reporting;
        private bool reportUnsupported;

        public DshDaughterPlugin(IMainWindow mainwin) : base(mainwin)
        {
            endpoint = (Environment.GetEnvironmentVariable("DSH_DAUGHTER_ENDPOINT") ?? "http://127.0.0.1:47612").TrimEnd('/');
            log = new PetLog(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dsh-daughter-mod.log"));
        }

        public override string PluginName
        {
            get { return "dshdaughter"; }
        }

        public override void LoadPlugin()
        {
            log.Start();
            log.Write("LoadPlugin endpoint=" + endpoint);

            client = new DshClient(endpoint, log);
            interaction = new InteractionGuard(MW, log);
            queue = new CommandQueue(log);
            motions = new MotionPlayer(MW, log);
            windows = new PetWindowController(MW, log);
            consumer = new ConsumerState();
            router = new EventRouter(log, ShowCloud, queue.Enqueue, windows.EnsureTopmost);

            interaction.Attach();

            pollTimer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(PollIntervalMs) };
            pollTimer.Tick += (sender, args) => Tick();
            pollTimer.Start();

            topmostTimer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(TopmostIntervalMs) };
            topmostTimer.Tick += (sender, args) => windows.EnsureTopmost();
            topmostTimer.Start();
        }

        public override void EndGame()
        {
            log.Write("EndGame");
            if (pollTimer != null)
            {
                pollTimer.Stop();
                pollTimer = null;
            }
            if (topmostTimer != null)
            {
                topmostTimer.Stop();
                topmostTimer = null;
            }
            if (interaction != null)
            {
                interaction.Dispose();
                interaction = null;
            }
            if (windows != null)
            {
                windows.StopMove();
            }
            if (queue != null) queue.Clear();
            if (bubble != null)
            {
                bubble.CloseBubble();
                bubble.Close();
                bubble = null;
            }
            if (client != null)
            {
                client.Dispose();
                client = null;
            }
            log.Dispose();
        }

        /// <summary>每秒一拍：先刷新本地状态并调度队列，再发起一次非阻塞的游标读取。</summary>
        private void Tick()
        {
            if (client == null) return;

            interaction.Refresh();
            motions.ResetIfStuck();
            Pump();
            UpdateConsumer();
            MaybeReport();

            if (polling) return;
            polling = true;
            _ = PollAsync();
        }

        private async Task PollAsync()
        {
            try
            {
                if (!cursorSeeded)
                {
                    SeedResult seed = await client.SeedAsync();
                    if (!seed.Supported)
                    {
                        legacyMode = true;
                        lastSeq = 0;
                        cursorSeeded = true;
                        log.Write("legacy bridge detected, cursor disabled");
                    }
                    else
                    {
                        lastSeq = seed.LatestSeq;
                        cursorSeeded = true;
                        log.Write("cursor seeded at " + lastSeq);
                    }
                    consumer.LastSeq = lastSeq;
                    return;
                }

                if (legacyMode) await TryUpgradeAsync();

                EventBatch batch = await client.FetchAsync(lastSeq, legacyMode);
                foreach (PetEvent item in batch.Events)
                {
                    router.Route(item);
                    if (item.Seq > lastSeq) lastSeq = item.Seq;
                }

                if (batch.Lost > 0) log.Write("events dropped by bridge queue: " + batch.Lost);
                if (batch.Seq < lastSeq)
                {
                    // 服务端重启后序号从 0 重新计数：回到 0 重取，避免跳过新队列里的前几条
                    log.Write("bridge restarted, cursor reset " + lastSeq + " -> 0");
                    lastSeq = 0;
                }
                else if (batch.Seq > lastSeq)
                {
                    lastSeq = batch.Seq;
                }
                consumer.LastSeq = lastSeq;

                if (!legacyMode) await client.AckAsync(lastSeq);
                Pump();
            }
            catch (Exception error)
            {
                if ((DateTime.Now - lastPollErrorAt).TotalSeconds >= 30)
                {
                    lastPollErrorAt = DateTime.Now;
                    log.Write("poll failed: " + error.GetType().Name + ": " + error.Message);
                }
            }
            finally
            {
                polling = false;
            }
        }

        /// <summary>旧版插件升级后无需重启游戏：每 60 秒探一次 /vpet/status，可用即切到游标模式。</summary>
        private async Task TryUpgradeAsync()
        {
            if ((DateTime.Now - lastUpgradeProbeAt).TotalSeconds < 60) return;
            lastUpgradeProbeAt = DateTime.Now;
            try
            {
                SeedResult seed = await client.SeedAsync();
                if (!seed.Supported) return;
                lastSeq = seed.LatestSeq;
                legacyMode = false;
                log.Write("bridge upgraded, cursor seeded at " + lastSeq);
            }
            catch
            {
                // 旧版插件仍在运行，保持 legacy 模式
            }
        }

        private void Pump()
        {
            if (queue.Count == 0 || IsBusy()) return;
            PetCommand command = queue.Dequeue();
            if (command == null) return;

            switch (command.Kind)
            {
                case PetCommandKind.Motion:
                    motions.PlayMotion(command.MotionId, command.Graph, command.Loops, PumpLater);
                    break;
                case PetCommandKind.Reaction:
                    motions.PlayReaction(PumpLater);
                    break;
                case PetCommandKind.Move:
                    windows.Move(command.Dx, command.Dy, command.DurationMs, PumpLater);
                    break;
                default:
                    PumpLater();
                    break;
            }
        }

        /// <summary>完成回调里继续取下一跳；放到下一次 Dispatcher 空闲，避免在同一帧连环 Display。</summary>
        private void PumpLater()
        {
            try
            {
                MW.Dispatcher.BeginInvoke((Action)Pump, DispatcherPriority.Background);
            }
            catch
            {
                // 退出过程中 Dispatcher 可能已关闭
            }
        }

        private bool IsBusy()
        {
            if (motions.IsAnimating || windows.IsMoving) return true;
            if (interaction.IsActive()) return true;
            return IsNativeBusy();
        }

        /// <summary>桌宠自己在打工/学习/睡觉/出门/拿东西时让行，不抢原生动画。</summary>
        private bool IsNativeBusy()
        {
            try
            {
                var main = MW.Main;
                if (main == null) return false;
                if (main.IsWorking) return true;
                int activity = (int)MW.Activity;
                int busy = (int)(PetActivity.Sleep | PetActivity.Work | PetActivity.Study | PetActivity.Travel | PetActivity.TakeItem);
                return (activity & busy) != 0;
            }
            catch
            {
                return false;
            }
        }

        private void UpdateConsumer()
        {
            bool playerActive = interaction.IsActive();
            bool nativeBusy = IsNativeBusy();
            bool busy = motions.IsAnimating || windows.IsMoving || playerActive || nativeBusy;

            consumer.Busy = busy;
            consumer.BusyReason = playerActive
                ? "player"
                : motions.IsAnimating
                    ? "animating"
                    : windows.IsMoving
                        ? "moving"
                        : nativeBusy
                            ? "native"
                            : "idle";
            consumer.CurrentGraph = motions.CurrentGraph;
            consumer.PlayerActive = playerActive;
            consumer.LastInteractionAt = interaction.LastInteractionAt == default(DateTime)
                ? null
                : interaction.LastInteractionAt.ToString("o");
            consumer.Queued = queue.Count;
            consumer.Dropped = queue.Dropped;
            consumer.Activity = ReadActivity();
            consumer.Topmost = windows.IsTopmost;
            consumer.Bounds = windows.Bounds();
            consumer.LastSeq = lastSeq;
        }

        private string ReadActivity()
        {
            try
            {
                return MW.Activity.ToString();
            }
            catch
            {
                return null;
            }
        }

        private void MaybeReport()
        {
            DateTime now = DateTime.Now;
            string signature = BuildReportSignature();
            bool changed = signature != lastReportSignature;
            bool heartbeat = (now - lastReportAt).TotalMilliseconds >= ReportHeartbeatMs;
            if (!changed && !heartbeat) return;
            if (reporting) return;
            if ((now - lastReportAttemptAt).TotalMilliseconds < 1000) return;
            if (reportUnsupported && (now - lastReportAttemptAt).TotalMilliseconds < 60_000) return;

            lastReportSignature = signature;
            lastReportAttemptAt = now;
            reporting = true;
            _ = ReportAsync();
        }

        private async Task ReportAsync()
        {
            try
            {
                bool supported = await client.ReportAsync(consumer.Build());
                if (!supported)
                {
                    if (!reportUnsupported)
                    {
                        reportUnsupported = true;
                        log.Write("consumer report unsupported by bridge, retrying every 60s");
                    }
                    return;
                }
                if (reportUnsupported)
                {
                    reportUnsupported = false;
                    log.Write("consumer report accepted by bridge");
                }
                lastReportAt = DateTime.Now;
            }
            finally
            {
                reporting = false;
            }
        }

        private string BuildReportSignature()
        {
            return string.Join("|", new[]
            {
                consumer.Busy ? "1" : "0",
                consumer.BusyReason ?? string.Empty,
                consumer.CurrentGraph ?? string.Empty,
                consumer.PlayerActive ? "1" : "0",
                consumer.Queued.ToString(),
                consumer.Activity ?? string.Empty,
                consumer.Topmost ? "1" : "0",
                (consumer.Bounds.Left / 10).ToString(),
                (consumer.Bounds.Top / 10).ToString(),
            });
        }

        private void ShowCloud(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            try
            {
                if (bubble == null) bubble = new CloudBubble();
                bubble.ShowText(text, windows.GetHeadAnchor);
            }
            catch (Exception error)
            {
                log.Write("bubble failed: " + error.GetType().Name + ": " + error.Message);
            }
        }
    }
}
