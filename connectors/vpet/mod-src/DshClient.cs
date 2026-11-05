using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace DshDaughter
{
    /// <summary>DSH 下发的一条桌宠事件，字段与 src/runtime/vpet-events.ts 的 VpetEvent 对应。</summary>
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

    /// <summary>一次游标读取的结果。</summary>
    internal sealed class EventBatch
    {
        public int Seq;
        public int Lost;
        public readonly List<PetEvent> Events = new List<PetEvent>();
    }

    /// <summary>启动时探测 /vpet/status 的结果：旧版插件返回 404 时退化为一次性领取。</summary>
    internal sealed class SeedResult
    {
        public bool Supported;
        public int LatestSeq;
    }

    /// <summary>
    /// DSH 本地桥接的 HTTP 客户端：只负责取事件、ack 游标、上报消费者状态，
    /// 不关心动画与窗口，方便单独替换或测试。
    /// </summary>
    internal sealed class DshClient : IDisposable
    {
        private static readonly JsonSerializerOptions SerializerOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };

        private readonly string endpoint;
        private readonly PetLog log;
        private readonly HttpClient client;
        private DateTime lastAckErrorAt = DateTime.MinValue;
        private DateTime lastReportErrorAt = DateTime.MinValue;

        public DshClient(string endpoint, PetLog log)
        {
            this.endpoint = endpoint;
            this.log = log;
            client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        }

        public async Task<SeedResult> SeedAsync()
        {
            using (HttpResponseMessage response = await client.GetAsync(endpoint + "/vpet/status"))
            {
                if (response.StatusCode == HttpStatusCode.NotFound) return new SeedResult { Supported = false };
                response.EnsureSuccessStatusCode();
                string body = await response.Content.ReadAsStringAsync();
                int latestSeq = 0;
                using (JsonDocument document = JsonDocument.Parse(body))
                {
                    latestSeq = ReadInt(document.RootElement, "latestSeq");
                }
                return new SeedResult { Supported = true, LatestSeq = latestSeq };
            }
        }

        /// <summary>游标读取；legacy 模式下不带 since，服务端只发一次。</summary>
        public async Task<EventBatch> FetchAsync(int since, bool legacy)
        {
            string path = legacy ? "/vpet/events" : "/vpet/events?since=" + since;
            using (HttpResponseMessage response = await client.GetAsync(endpoint + path))
            {
                response.EnsureSuccessStatusCode();
                string body = await response.Content.ReadAsStringAsync();
                var batch = new EventBatch();
                using (JsonDocument document = JsonDocument.Parse(body))
                {
                    JsonElement root = document.RootElement;
                    if (root.ValueKind != JsonValueKind.Object) return batch;

                    batch.Seq = ReadInt(root, "seq");
                    batch.Lost = ReadInt(root, "lost");
                    JsonElement events;
                    if (root.TryGetProperty("events", out events) && events.ValueKind == JsonValueKind.Array)
                    {
                        foreach (JsonElement item in events.EnumerateArray())
                        {
                            PetEvent parsed = ReadEvent(item);
                            if (parsed != null) batch.Events.Add(parsed);
                        }
                    }
                }
                return batch;
            }
        }

        public async Task AckAsync(int seq)
        {
            try
            {
                string payload = "{\"seq\":" + seq + "}";
                using (StringContent content = new StringContent(payload, Encoding.UTF8, "application/json"))
                using (HttpResponseMessage response = await client.PostAsync(endpoint + "/vpet/events/ack", content))
                {
                    response.EnsureSuccessStatusCode();
                }
            }
            catch (Exception error)
            {
                if ((DateTime.Now - lastAckErrorAt).TotalSeconds >= 30)
                {
                    lastAckErrorAt = DateTime.Now;
                    log.Write("ack failed: " + error.GetType().Name + ": " + error.Message);
                }
            }
        }

        /// <summary>
        /// 上报 MOD 自身能力与运行状态。返回 false 表示服务端还不支持该端点（旧版插件），
        /// 调用方据此降低重试频率即可。
        /// </summary>
        public async Task<bool> ReportAsync(object payload)
        {
            try
            {
                string json = JsonSerializer.Serialize(payload, SerializerOptions);
                using (StringContent content = new StringContent(json, Encoding.UTF8, "application/json"))
                using (HttpResponseMessage response = await client.PostAsync(endpoint + "/vpet/consumer/report", content))
                {
                    if (response.StatusCode == HttpStatusCode.NotFound) return false;
                    response.EnsureSuccessStatusCode();
                    return true;
                }
            }
            catch (Exception error)
            {
                if ((DateTime.Now - lastReportErrorAt).TotalSeconds >= 30)
                {
                    lastReportErrorAt = DateTime.Now;
                    log.Write("report failed: " + error.GetType().Name + ": " + error.Message);
                }
                return true;
            }
        }

        public void Dispose()
        {
            client.Dispose();
        }

        private static PetEvent ReadEvent(JsonElement item)
        {
            if (item.ValueKind != JsonValueKind.Object) return null;
            string kind = ReadString(item, "kind");
            if (string.IsNullOrEmpty(kind)) return null;

            return new PetEvent
            {
                Kind = kind,
                Text = ReadString(item, "text"),
                Tool = ReadString(item, "tool"),
                MotionId = ReadString(item, "motionId"),
                Graph = ReadString(item, "graph"),
                Loops = ReadInt(item, "loops"),
                Dx = ReadInt(item, "dx"),
                Dy = ReadInt(item, "dy"),
                DurationMs = ReadInt(item, "durationMs"),
                Seq = ReadInt(item, "seq"),
            };
        }

        private static string ReadString(JsonElement item, string name)
        {
            JsonElement value;
            if (!item.TryGetProperty(name, out value) || value.ValueKind != JsonValueKind.String) return null;
            string text = value.GetString();
            return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
        }

        private static int ReadInt(JsonElement item, string name)
        {
            JsonElement value;
            if (!item.TryGetProperty(name, out value) || value.ValueKind != JsonValueKind.Number) return 0;
            int number;
            return value.TryGetInt32(out number) ? number : 0;
        }
    }
}
