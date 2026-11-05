using System;
using System.Threading;
using System.Windows;

namespace DshPet
{
    public partial class App : Application
    {
        private Mutex mutex;

        protected override void OnStartup(StartupEventArgs e)
        {
            mutex = new Mutex(true, @"Local\DshPet.SingleInstance", out bool created);
            if (!created)
            {
                Shutdown();
                return;
            }

            DispatcherUnhandledException += (_, args) =>
            {
                PetLog.Write("ui error: " + args.Exception);
                args.Handled = true;
            };
            AppDomain.CurrentDomain.UnhandledException += (_, args) =>
                PetLog.Write("fatal: " + args.ExceptionObject);

            base.OnStartup(e);

            var window = new MainWindow();
            MainWindow = window;
            window.Show();
        }

        protected override void OnExit(ExitEventArgs e)
        {
            try
            {
                mutex?.ReleaseMutex();
                mutex?.Dispose();
            }
            catch
            {
                // 进程退出路径不抛
            }
            base.OnExit(e);
        }
    }
}
