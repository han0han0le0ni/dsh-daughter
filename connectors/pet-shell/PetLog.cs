using System;
using System.IO;
using System.Text;

namespace DshPet
{
    /// <summary>极简日志：写 %LOCALAPPDATA%\DshPet\pet.log，超过 256KB 就截断重来。</summary>
    internal static class PetLog
    {
        private static readonly object Gate = new object();
        private static string path;

        public static string Path
        {
            get
            {
                if (path != null) return path;
                string dir = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DshPet");
                Directory.CreateDirectory(dir);
                path = System.IO.Path.Combine(dir, "pet.log");
                return path;
            }
        }

        public static void Write(string message)
        {
            try
            {
                lock (Gate)
                {
                    string line = DateTime.Now.ToString("HH:mm:ss") + " " + message + Environment.NewLine;
                    FileInfo info = new FileInfo(Path);
                    if (info.Exists && info.Length > 256 * 1024) File.Delete(Path);
                    File.AppendAllText(Path, line, Encoding.UTF8);
                }
            }
            catch
            {
                // 日志失败不影响主流程
            }
        }
    }
}
