using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace DshPet
{
    /// <summary>DSH 下发的一条桌宠事件，字段与 src/runtime/vpet-events.ts 对齐。</summary>
    internal sealed class PetEvent
    {
        public string Kind;
        public string Text;
        public string Tool;
        public string MotionId;
        public string Graph;
        public int Loops;
        public int Dx;
        public int Dy;
        public int DurationMs;
        public int Seq;
    }

    /// <summary>上报给 DSH 的自身状态，字段与 VpetConsumerState 对齐。</summary>
    internal sealed class PetSnapshot
    {
        public bool Busy;
        public string Reason = "idle";
        public string CurrentGraph;
        public bool PlayerActive;
        public int Queued;
        public int Dropped;
        public string Activity;
        public bool Topmost;
        public int LastSeq;
        public double Left;
        public double Top;
        public double Width;
        public double Height;
    }

    /// <summary>
    /// 只做三件事：长轮询事件、ack 游标、上报状态与心跳。
    /// 连不上就安静重试，壳自己继续待机，不弹窗不退出。
    /// </summary>
    internal sealed class BridgeClient : IDisposable
    {
        private readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(6) };
        private readonly string baseUrl;
        private string lastSeq = string.Empty;
        private DateTime lastWarnAt = DateTime.MinValue;

        public BridgeClient(string baseUrl)
        {
            this.baseUrl = (baseUrl ?? string.Empty).TrimEnd('/');

            // 插件端点要求连接器令牌（§12.2）。没有令牌就照常请求，让服务端 401 并记日志，
            // 不做"没令牌也就通融一下"的降级。
            string token = ResolveToken();
            if (string.IsNullOrEmpty(token))
            {
                PetLog.Write("未找到连接器令牌：插件端点会拒绝请求（token.txt 或 DSH_DAUGHTER_TOKEN）");
            }
            else
            {
                http.DefaultRequestHeaders.Add("x-dsh-token", token);
            }
        }

        /// <summary>令牌来源：环境变量 > 环境变量指定的文件 > 可执行文件目录下的 token.txt。</summary>
        private static string ResolveToken()
        {
            string fromEnv = Environment.GetEnvironmentVariable("DSH_DAUGHTER_TOKEN");
            if (!string.IsNullOrEmpty(fromEnv)) return fromEnv.Trim();

            string explicitFile = Environment.GetEnvironmentVariable("DSH_DAUGHTER_TOKEN_FILE");
            var candidates = new List<string>();
            if (!string.IsNullOrEmpty(explicitFile)) candidates.Add(explicitFile);
            string baseDir = AppContext.BaseDirectory;
            if (!string.IsNullOrEmpty(baseDir)) candidates.Add(Path.Combine(baseDir, "token.txt"));

            foreach (string path in candidates)
            {
                try
                {
                    if (!File.Exists(path)) continue;
                    string raw = File.ReadAllText(path).Trim();
                    if (raw.Length >= 16) return raw;
                }
                catch
                {
                    // 读不到就当没有：宁可连不上，也不要静默降级
                }
            }
            return string.Empty;
        }

        public bool Online { get; private set; }
        public int LastSeq { get; private set; }

        public async Task RunAsync(Func<PetEvent, Task> onEvent, CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await PollOnceAsync(onEvent, token);
                    if (!Online)
                    {
                        Online = true;
                        PetLog.Write("bridge online: " + baseUrl);
                    }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception error)
                {
                    if (Online)
                    {
                        Online = false;
                        PetLog.Write("bridge offline: " + error.GetType().Name);
                    }
                    else if ((DateTime.Now - lastWarnAt).TotalSeconds > 30)
                    {
                        lastWarnAt = DateTime.Now;
                        PetLog.Write("bridge still offline: " + error.GetType().Name);
                    }
                }

                try
                {
                    await Task.Delay(500, token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        private async Task PollOnceAsync(Func<PetEvent, Task> onEvent, CancellationToken token)
        {
            string url = baseUrl + "/vpet/events" + (lastSeq.Length == 0 ? string.Empty : "?since=" + lastSeq);
            using HttpResponseMessage response = await http.GetAsync(url, token);
            response.EnsureSuccessStatusCode();
            string body = await response.Content.ReadAsStringAsync(token);

            using JsonDocument doc = JsonDocument.Parse(body);
            JsonElement root = doc.RootElement;
            int seq = root.TryGetProperty("seq", out var seqEl) && seqEl.TryGetInt32(out int s) ? s : 0;

            if (root.TryGetProperty("events", out var eventsEl) && eventsEl.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement item in eventsEl.EnumerateArray())
                {
                    PetEvent ev = Parse(item);
                    if (ev == null) continue;
                    await onEvent(ev);
                }
            }

            if (seq > 0)
            {
                LastSeq = seq;
                lastSeq = seq.ToString();
                await AckAsync(seq, token);
            }
        }

        private async Task AckAsync(int seq, CancellationToken token)
        {
            using var content = new StringContent("{\"seq\":" + seq + "}", Encoding.UTF8, "application/json");
            using HttpResponseMessage response = await http.PostAsync(baseUrl + "/vpet/events/ack", content, token);
            response.EnsureSuccessStatusCode();
        }

        public async Task ReportAsync(PetSnapshot snapshot, CancellationToken token)
        {
            var payload = new
            {
                version = "dsh-pet/0.1",
                pollMs = 500,
                capabilities = new
                {
                    graphs = new[] { "Default", "Say", "Think", "IDEL", "Touch_Head", "Touch_Body", "Sleep", "Move" },
                    actions = new[] { "animate", "bubble", "move", "topmost" },
                    queue = true,
                    queueCapacity = 4,
                },
                state = new
                {
                    busy = snapshot.Busy,
                    reason = snapshot.Reason,
                    currentGraph = snapshot.CurrentGraph ?? string.Empty,
                    playerActive = snapshot.PlayerActive,
                    queued = snapshot.Queued,
                    dropped = snapshot.Dropped,
                    activity = snapshot.Activity ?? string.Empty,
                    topmost = snapshot.Topmost,
                    lastSeq = snapshot.LastSeq,
                    window = new
                    {
                        left = (int)Math.Round(snapshot.Left),
                        top = (int)Math.Round(snapshot.Top),
                        width = (int)Math.Round(snapshot.Width),
                        height = (int)Math.Round(snapshot.Height),
                    },
                },
            };
            using var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            using HttpResponseMessage response = await http.PostAsync(baseUrl + "/vpet/consumer/report", content, token);
            response.EnsureSuccessStatusCode();
        }

        public async Task HeartbeatAsync(CancellationToken token)
        {
            using var content = new StringContent(
                "{\"saveFound\":false,\"name\":\"daughter\",\"mode\":\"shell\"}",
                Encoding.UTF8,
                "application/json");
            using HttpResponseMessage response = await http.PostAsync(baseUrl + "/vpet/heartbeat", content, token);
            response.EnsureSuccessStatusCode();
        }

        private static PetEvent Parse(JsonElement item)
        {
            if (item.ValueKind != JsonValueKind.Object) return null;
            string kind = Str(item, "kind");
            if (string.IsNullOrEmpty(kind)) return null;
            return new PetEvent
            {
                Kind = kind,
                Text = Str(item, "text"),
                Tool = Str(item, "tool"),
                MotionId = Str(item, "motionId"),
                Graph = Str(item, "graph"),
                Loops = Int(item, "loops"),
                Dx = Int(item, "dx"),
                Dy = Int(item, "dy"),
                DurationMs = Int(item, "durationMs"),
                Seq = Int(item, "seq"),
            };
        }

        private static string Str(JsonElement item, string name)
        {
            return item.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;
        }

        private static int Int(JsonElement item, string name)
        {
            return item.TryGetProperty(name, out var el) && el.TryGetInt32(out int value) ? value : 0;
        }

        public void Dispose()
        {
            http.Dispose();
        }
    }
}
