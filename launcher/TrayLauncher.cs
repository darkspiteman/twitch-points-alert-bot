// Twitch Alert Bot — лаунчер в системном трее.
// Запускает бота (Node.js) без окна консоли, перезапускает при сбое,
// показывает состояние подключения цветом значка, корректно останавливает бота при выходе.
// Компилируется штатным csc.exe из .NET Framework 4.x (см. build-launcher.ps1).
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("Twitch Alert Bot")]
[assembly: System.Reflection.AssemblyProduct("Twitch Alert Bot")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace TwitchAlertBot
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, "Local\\TwitchAlertBot_Launcher", out created))
            {
                if (!created)
                {
                    // Уже запущен — просто открываем панель.
                    TrayApp.OpenUrl("http://127.0.0.1:" + TrayApp.ReadPort() + "/panel/");
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                bool autostart = Array.IndexOf(args, "--autostart") >= 0;
                Application.Run(new TrayApp(autostart));
            }
        }
    }

    class TrayApp : ApplicationContext
    {
        readonly NotifyIcon tray = new NotifyIcon();
        readonly System.Windows.Forms.Timer healthTimer = new System.Windows.Forms.Timer();
        readonly string root = AppDomain.CurrentDomain.BaseDirectory;
        readonly bool autostart;
        Process bot;
        bool attached;        // бот уже был запущен кем-то другим
        bool exiting;
        bool openedPanel;
        int restartDelay = 2000;
        DateTime lastStart = DateTime.MinValue;
        string lastState = "";
        Icon iconGreen, iconYellow, iconRed, iconGray;
        SynchronizationContext ui;
        int downCount;
        // Язык меню и подсказок — как в панели бота (поле language в /api/health и runtime.json).
        bool en = ReadLanguage() == "en";
        ToolStripMenuItem miOpen, miCopy, miRestart, miLogs, miExit;

        string L(string ru, string english) { return en ? english : ru; }

        public static string ReadLanguage()
        {
            try
            {
                string f = Path.Combine(DataDir(), "runtime.json");
                if (File.Exists(f))
                {
                    var m = Regex.Match(File.ReadAllText(f), "\"language\"\\s*:\\s*\"(\\w+)\"");
                    if (m.Success) return m.Groups[1].Value;
                }
            }
            catch { }
            return "ru";
        }

        void ApplyMenuLanguage()
        {
            miOpen.Text = L("Открыть панель управления", "Open control panel");
            miCopy.Text = L("Скопировать адрес overlay (OBS / Streamlabs)", "Copy overlay address (OBS / Streamlabs)");
            miRestart.Text = L("Перезапустить бота", "Restart the bot");
            miLogs.Text = L("Открыть папку логов", "Open logs folder");
            miExit.Text = L("Выход", "Exit");
        }

        public TrayApp(bool autostart)
        {
            this.autostart = autostart;
            iconGreen = MakeIcon(Color.FromArgb(47, 191, 113));
            iconYellow = MakeIcon(Color.FromArgb(232, 163, 61));
            iconRed = MakeIcon(Color.FromArgb(229, 72, 77));
            iconGray = MakeIcon(Color.FromArgb(145, 71, 255));

            var menu = new ContextMenuStrip();
            miOpen = new ToolStripMenuItem("", null, delegate { OpenPanel(); });
            miOpen.Font = new Font(miOpen.Font, FontStyle.Bold);
            menu.Items.Add(miOpen);
            miCopy = new ToolStripMenuItem("", null, delegate { CopyOverlayUrl(); });
            menu.Items.Add(miCopy);
            menu.Items.Add(new ToolStripSeparator());
            miRestart = new ToolStripMenuItem("", null, delegate { RestartBot(); });
            menu.Items.Add(miRestart);
            miLogs = new ToolStripMenuItem("", null, delegate { OpenFolder(Path.Combine(DataDir(), "logs")); });
            menu.Items.Add(miLogs);
            menu.Items.Add(new ToolStripSeparator());
            miExit = new ToolStripMenuItem("", null, delegate { ExitApp(); });
            menu.Items.Add(miExit);
            ApplyMenuLanguage();

            tray.ContextMenuStrip = menu;
            var handle = menu.Handle; // создаёт окно → устанавливается WindowsFormsSynchronizationContext
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            tray.Icon = iconGray;
            tray.Text = L("Twitch Alert Bot: запуск…", "Twitch Alert Bot: starting…");
            tray.Visible = true;
            tray.DoubleClick += delegate { OpenPanel(); };

            SystemEvents.SessionEnding += delegate { ExitApp(); };

            StartBot();
            healthTimer.Interval = 4000;
            healthTimer.Tick += delegate { CheckHealth(); };
            healthTimer.Start();
        }

        // ---------------- процесс бота ----------------
        public static string DataDir()
        {
            string env = Environment.GetEnvironmentVariable("TAB_DATA_DIR");
            if (!string.IsNullOrEmpty(env)) return env;
            // Данные бота лежат в папке программы (data), рядом с лаунчером.
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");
        }

        public static int ReadPort()
        {
            try
            {
                string f = Path.Combine(DataDir(), "runtime.json");
                if (File.Exists(f))
                {
                    var m = Regex.Match(File.ReadAllText(f), "\"port\"\\s*:\\s*(\\d+)");
                    if (m.Success) return int.Parse(m.Groups[1].Value);
                }
            }
            catch { }
            return 17420;
        }

        string NodePath()
        {
            string local = Path.Combine(root, "runtime", "node.exe");
            return File.Exists(local) ? local : "node.exe";
        }

        void StartBot()
        {
            if (exiting) return;
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = NodePath();
                psi.Arguments = "--disable-warning=ExperimentalWarning \"" + Path.Combine(root, "src", "main.ts") + "\"" + (autostart ? " --autostart" : "");
                psi.WorkingDirectory = root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                bot = Process.Start(psi);
                bot.EnableRaisingEvents = true;
                bot.Exited += OnBotExited;
                attached = false;
                lastStart = DateTime.Now;
            }
            catch (Exception e)
            {
                ShowBalloon(L("Не удалось запустить бота", "Couldn't start the bot"), e.Message + L("\nПроверьте, что установлен Node.js (запустите install.cmd).", "\nMake sure Node.js is installed (run install.cmd)."), ToolTipIcon.Error);
            }
        }

        void OnBotExited(object sender, EventArgs e)
        {
            int code = 0;
            try { code = bot.ExitCode; } catch { }
            if (exiting) return;
            if (code == 3)
            {
                // Бот уже работает (запущен вручную или прошлым лаунчером) — следим за ним.
                attached = true;
                return;
            }
            if (code == 4)
            {
                // Установлено обновление — сразу запускаем новую версию.
                restartDelay = 2000;
                BeginInvokeUi(delegate
                {
                    ShowBalloon("Twitch Alert Bot", L("Обновление установлено, бот перезапускается", "Update installed, the bot is restarting"), ToolTipIcon.Info);
                    StartBot();
                });
                return;
            }
            if (code == 0)
            {
                // Корректная остановка из панели — закрываем и лаунчер.
                BeginInvokeUi(delegate { ExitApp(); });
                return;
            }
            // Аварийное завершение — перезапуск с нарастающей задержкой.
            if ((DateTime.Now - lastStart).TotalSeconds > 120) restartDelay = 2000;
            int delay = restartDelay;
            restartDelay = Math.Min(restartDelay * 2, 60000);
            BeginInvokeUi(delegate
            {
                ShowBalloon(L("Бот аварийно завершился", "The bot crashed"), L("Перезапуск через " + (delay / 1000) + " с. Подробности — в логах.", "Restarting in " + (delay / 1000) + " s. Details are in the logs."), ToolTipIcon.Warning);
                var t = new System.Windows.Forms.Timer();
                t.Interval = delay;
                t.Tick += delegate { t.Stop(); t.Dispose(); StartBot(); };
                t.Start();
            });
        }

        void BeginInvokeUi(MethodInvoker a)
        {
            ui.Post(delegate { a(); }, null);
        }

        bool StopBot(int waitMs)
        {
            int port = ReadPort();
            try
            {
                using (var wc = new WebClient())
                {
                    wc.Headers.Add("x-tab-request", "1");
                    wc.Headers.Add("Content-Type", "application/json");
                    wc.UploadString("http://127.0.0.1:" + port + "/api/shutdown", "POST", "{}");
                }
            }
            catch { }
            if (bot != null && !bot.HasExited)
            {
                if (!bot.WaitForExit(waitMs)) { try { bot.Kill(); } catch { } return false; }
            }
            else
            {
                Thread.Sleep(1500);
            }
            return true;
        }

        void RestartBot()
        {
            healthTimer.Stop();
            if (bot != null) bot.Exited -= OnBotExited;
            StopBot(8000);
            restartDelay = 2000;
            StartBot();
            healthTimer.Start();
            ShowBalloon("Twitch Alert Bot", L("Бот перезапущен", "The bot was restarted"), ToolTipIcon.Info);
        }

        void ExitApp()
        {
            if (exiting) return;
            exiting = true;
            healthTimer.Stop();
            tray.Text = L("Twitch Alert Bot: остановка…", "Twitch Alert Bot: stopping…");
            if (!attached) StopBot(8000);
            tray.Visible = false;
            tray.Dispose();
            ExitThread();
        }

        // ---------------- состояние ----------------
        void CheckHealth()
        {
            int port = ReadPort();
            var wc = new WebClient();
            wc.Encoding = Encoding.UTF8;
            wc.DownloadStringCompleted += delegate (object s, DownloadStringCompletedEventArgs ev)
            {
                wc.Dispose();
                if (exiting) return;
                if (ev.Error != null || ev.Cancelled)
                {
                    SetState("down", L("бот не отвечает", "bot not responding"));
                    // Бот был запущен не нами и пропал — запускаем свой экземпляр.
                    if (attached && ++downCount >= 3) { downCount = 0; StartBot(); }
                    return;
                }
                downCount = 0;
                string j = ev.Result;
                bool nowEn = j.Contains("\"language\":\"en\"");
                if (nowEn != en) { en = nowEn; ApplyMenuLanguage(); }
                bool tw = j.Contains("\"twitch\":\"ok\"");
                bool es = j.Contains("\"eventsub\":\"connected\"");
                var m = Regex.Match(j, "\"obsOverlays\":(\\d+)");
                int obs = m.Success ? int.Parse(m.Groups[1].Value) : 0;
                bool observe = j.Contains("\"mode\":\"observe\"");
                // Программа для стрима, выбранная в настройках бота: OBS Studio или Streamlabs Desktop.
                string appLabel = j.Contains("\"streamApp\":\"streamlabs\"") ? "Streamlabs" : "OBS";
                string text = "Twitch " + (tw ? "✓" : "✗") + "  EventSub " + (es ? "✓" : "✗") + "  " + appLabel + " " + (obs > 0 ? "✓" : "✗") + (observe ? L("  (наблюдение)", "  (observe)") : "");
                SetState(tw && es && obs > 0 ? "ok" : "partial", text);
                if (!openedPanel)
                {
                    openedPanel = true;
                    if (!autostart || !tw) OpenPanel();
                }
            };
            try { wc.DownloadStringAsync(new Uri("http://127.0.0.1:" + port + "/api/health")); }
            catch { SetState("down", L("бот не отвечает", "bot not responding")); }
        }

        void SetState(string state, string text)
        {
            string t = "Alert Bot: " + text;
            tray.Text = t.Length > 63 ? t.Substring(0, 63) : t;
            if (state == lastState) return;
            string prev = lastState;
            lastState = state;
            tray.Icon = state == "ok" ? iconGreen : state == "partial" ? iconYellow : iconRed;
            if (prev == "ok" && state != "ok") ShowBalloon("Twitch Alert Bot", L("Проблема с подключением: ", "Connection problem: ") + text, ToolTipIcon.Warning);
            else if (prev != "" && prev != "ok" && state == "ok") ShowBalloon("Twitch Alert Bot", L("Всё подключено", "Everything is connected"), ToolTipIcon.Info);
        }

        // ---------------- действия ----------------
        void OpenPanel() { OpenUrl("http://127.0.0.1:" + ReadPort() + "/panel/"); }

        void CopyOverlayUrl()
        {
            string url = "http://127.0.0.1:" + ReadPort() + "/overlay";
            try { Clipboard.SetText(url); ShowBalloon(L("Адрес скопирован", "Address copied"), url + L("\nВставьте его в Browser Source в OBS или Streamlabs.", "\nPaste it into a Browser Source in OBS or Streamlabs."), ToolTipIcon.Info); } catch { }
        }

        public static void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        static void OpenFolder(string dir)
        {
            try { Directory.CreateDirectory(dir); Process.Start("explorer.exe", "\"" + dir + "\""); } catch { }
        }

        void ShowBalloon(string title, string text, ToolTipIcon icon)
        {
            try { tray.ShowBalloonTip(5000, title, text, icon); } catch { }
        }

        static Icon MakeIcon(Color color)
        {
            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var b = new SolidBrush(Color.FromArgb(145, 71, 255))) FillRounded(g, b, 1, 1, 30, 30, 8);
                // звезда
                var pts = new PointF[10];
                for (int i = 0; i < 10; i++)
                {
                    double a = -Math.PI / 2 + i * Math.PI / 5;
                    float r = i % 2 == 0 ? 11f : 4.6f;
                    pts[i] = new PointF(16 + (float)(Math.Cos(a) * r), 16.5f + (float)(Math.Sin(a) * r));
                }
                g.FillPolygon(Brushes.White, pts);
                // индикатор состояния
                using (var b = new SolidBrush(color)) g.FillEllipse(b, 19, 19, 12, 12);
                using (var p = new Pen(Color.White, 2)) g.DrawEllipse(p, 19, 19, 12, 12);
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        static void FillRounded(Graphics g, Brush b, float x, float y, float w, float h, float r)
        {
            using (var path = new GraphicsPath())
            {
                path.AddArc(x, y, r, r, 180, 90);
                path.AddArc(x + w - r, y, r, r, 270, 90);
                path.AddArc(x + w - r, y + h - r, r, r, 0, 90);
                path.AddArc(x, y + h - r, r, r, 90, 90);
                path.CloseFigure();
                g.FillPath(b, path);
            }
        }
    }
}
