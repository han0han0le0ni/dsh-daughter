using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DshPet
{
    /// <summary>
    /// 壳的全部设置：只有素材位置、缩放、置顶、气泡、桥地址这几项，其余一律内置。
    /// 文件放在 %LOCALAPPDATA%\DshPet\pet.json，首次启动自动生成。
    /// </summary>
    internal sealed class PetSettings
    {
        private const string FolderName = "DshPet";
        private const string FileName = "pet.json";

        /// <summary>插件桥：dsh-daughter 监听 47612，壳和 VPet MOD 都从这里取 /vpet/* 事件。</summary>
        private const string DefaultBridgeUrl = "http://127.0.0.1:47612";

        /// <summary>旧版默认值。47614 是桌面连接器（/windows、/screenshot），指向它取不到桌宠事件。</summary>
        private const string LegacyBridgeUrl = "http://127.0.0.1:47614";

        private static readonly string[] KnownRoots =
        {
            @"E:\SteamLibrary\steamapps\common\VPet\mod\0000_core\pet\vup",
            @"D:\SteamLibrary\steamapps\common\VPet\mod\0000_core\pet\vup",
            @"C:\Program Files (x86)\Steam\steamapps\common\VPet\mod\0000_core\pet\vup",
        };

        public string AssetRoot { get; set; } = DetectAssetRoot();
        public double Scale { get; set; } = 0.55;
        public bool Topmost { get; set; } = true;
        public bool ClickThrough { get; set; } = true;
        public bool Bubble { get; set; } = true;
        /// <summary>
        /// 插件桥地址。注意是 47612（dsh-daughter 的 /vpet/* 端点），
        /// 47614 是桌面连接器（/windows、/screenshot），两者不是同一个服务。
        /// </summary>
        public string BridgeUrl { get; set; } = DefaultBridgeUrl;
        public double? Left { get; set; }
        public double? Top { get; set; }
        public int IdleMinMs { get; set; } = 22000;
        public int IdleMaxMs { get; set; } = 48000;
        /// <summary>默认表情组名，素材里对应 Default/&lt;表情&gt;，常见为 Nomal</summary>
        public string Emotion { get; set; } = "Nomal";

        [JsonIgnore]
        public static string SettingsPath
        {
            get
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    FolderName);
                Directory.CreateDirectory(dir);
                return Path.Combine(dir, FileName);
            }
        }

        public static PetSettings Load()
        {
            try
            {
                string path = SettingsPath;
                if (!File.Exists(path)) return new PetSettings();
                string json = File.ReadAllText(path);
                var loaded = JsonSerializer.Deserialize<PetSettings>(json);
                if (loaded == null) return new PetSettings();
                // 旧版存下来的 47614 一律归一到 47612，否则壳连的是桌面连接器，永远收不到事件
                if (string.Equals((loaded.BridgeUrl ?? string.Empty).TrimEnd('/'), LegacyBridgeUrl, StringComparison.OrdinalIgnoreCase))
                {
                    loaded.BridgeUrl = DefaultBridgeUrl;
                }
                return loaded;
            }
            catch
            {
                return new PetSettings();
            }
        }

        public void Save()
        {
            try
            {
                string json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(SettingsPath, json);
            }
            catch
            {
                // 设置写不进去不该影响运行
            }
        }

        private static string DetectAssetRoot()
        {
            foreach (string root in KnownRoots)
            {
                try
                {
                    if (Directory.Exists(root)) return root;
                }
                catch
                {
                    // 路径探测失败继续往下找
                }
            }
            return string.Empty;
        }
    }
}
