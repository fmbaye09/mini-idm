using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MiniIDM
{
    public class SegmentInfo
    {
        public int index { get; set; }
        public long start { get; set; }
        public long end { get; set; }
        public long downloaded { get; set; }
        public long total { get; set; }
        public string status { get; set; }
    }

    public class JobInfo
    {
        public string id { get; set; }
        public string title { get; set; }
        public string filename { get; set; }
        public string filePath { get; set; }
        public string url { get; set; }
        public string mode { get; set; }
        public string status { get; set; }
        public string error { get; set; }
        public long totalBytes { get; set; }
        public long downloadedBytes { get; set; }
        public double progress { get; set; }
        public long speedBps { get; set; }
        public int? etaSec { get; set; }
        public List<SegmentInfo> segments { get; set; }
    }

    public class DownloadsResponse
    {
        public bool ok { get; set; }
        public string downloadDir { get; set; }
        public List<JobInfo> jobs { get; set; }
    }

    public class MainForm : Form
    {
        private const string ServerUrl = "http://127.0.0.1:10010";
        private const string RunRegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string AppRegistryName = "Mini-IDM";

        private Process serverProcess;
        private NotifyIcon trayIcon;
        private ContextMenuStrip trayMenu;
        private ToolStripMenuItem autoStartMenuItem;
        private System.Windows.Forms.Timer pollTimer;
        private bool allowClose = false;

        private Label statusLabel;
        private TextBox urlInput;
        private Panel jobsContainer;
        private string downloadDir;
        private List<JobInfo> currentJobs = new List<JobInfo>();
        private HashSet<string> notifiedStarted = new HashSet<string>();
        private HashSet<string> notifiedCompleted = new HashSet<string>();
        private bool firstPoll = true;
        private string lastRenderSignature = "";

        // Couleurs du thème sombre Mini-IDM
        private readonly Color BgDark = Color.FromArgb(15, 23, 42);
        private readonly Color PanelDark = Color.FromArgb(30, 41, 59);
        private readonly Color CardDark = Color.FromArgb(19, 28, 49);
        private readonly Color BorderColor = Color.FromArgb(51, 65, 85);
        private readonly Color AccentGreen = Color.FromArgb(16, 185, 129);
        private readonly Color AccentBlue = Color.FromArgb(56, 189, 248);
        private readonly Color TextLight = Color.FromArgb(248, 250, 252);
        private readonly Color TextMuted = Color.FromArgb(148, 163, 184);

        public MainForm()
        {
            downloadDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Downloads",
                "Mini-IDM"
            );
            Directory.CreateDirectory(downloadDir);

            InitializeWindow();
            InitializeTrayIcon();
            EnsureBackendServerRunning();

            pollTimer = new System.Windows.Forms.Timer();
            pollTimer.Interval = 700;
            pollTimer.Tick += (s, e) => PollServer();
            pollTimer.Start();
            PollServer();
        }

        private void InitializeWindow()
        {
            this.Text = "Mini-IDM — Gestionnaire de Téléchargement Vidéo";
            this.Size = new Size(920, 640);
            this.MinimumSize = new Size(760, 480);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = BgDark;
            this.ForeColor = TextLight;
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            this.DoubleBuffered = true;

            try
            {
                this.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch { }

            // 1. En-tête supérieur
            Panel headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 76,
                BackColor = PanelDark,
                Padding = new Padding(20, 14, 20, 14)
            };

            Label badgeLbl = new Label
            {
                Text = "IDM",
                Font = new Font("Segoe UI", 12f, FontStyle.Bold),
                ForeColor = Color.White,
                BackColor = AccentGreen,
                TextAlign = ContentAlignment.MiddleCenter,
                Size = new Size(46, 46),
                Location = new Point(20, 15)
            };

            Label titleLbl = new Label
            {
                Text = "Mini-IDM Video Downloader",
                Font = new Font("Segoe UI Semibold", 14f, FontStyle.Bold),
                ForeColor = TextLight,
                AutoSize = true,
                Location = new Point(78, 13)
            };

            statusLabel = new Label
            {
                Text = "🟢 Moteur multi-segments actif sur 127.0.0.1:10010 • En écoute de l'extension navigateur",
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                ForeColor = AccentGreen,
                AutoSize = true,
                Location = new Point(79, 41)
            };

            Button openFolderBtn = CreateStyledButton("📁 Ouvrir le dossier Mini-IDM", Color.FromArgb(51, 65, 85), 210, 38);
            openFolderBtn.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            openFolderBtn.Location = new Point(this.ClientSize.Width - 230, 19);
            openFolderBtn.Click += (s, e) => OpenFolderInExplorer(downloadDir);

            headerPanel.Controls.Add(badgeLbl);
            headerPanel.Controls.Add(titleLbl);
            headerPanel.Controls.Add(statusLabel);
            headerPanel.Controls.Add(openFolderBtn);

            // 2. Barre d'ajout manuel d'URL
            Panel inputPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 62,
                BackColor = BgDark,
                Padding = new Padding(20, 12, 20, 10)
            };

            urlInput = new TextBox
            {
                Font = new Font("Segoe UI", 10.5f),
                BackColor = PanelDark,
                ForeColor = TextLight,
                BorderStyle = BorderStyle.FixedSingle,
                Location = new Point(20, 16),
                Width = this.ClientSize.Width - 340,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            SendMessageCueBanner(urlInput, "Coller une URL vidéo directe (.mp4, .webm) ou un flux HLS (.m3u8)...");

            Button pasteBtn = CreateStyledButton("📋 Coller", Color.FromArgb(51, 65, 85), 90, 32);
            pasteBtn.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            pasteBtn.Location = new Point(this.ClientSize.Width - 310, 14);
            pasteBtn.Click += (s, e) =>
            {
                if (Clipboard.ContainsText())
                {
                    urlInput.Text = Clipboard.GetText().Trim();
                }
            };

            Button downloadBtn = CreateStyledButton("⬇ Télécharger (8x)", AccentGreen, 180, 32);
            downloadBtn.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            downloadBtn.Location = new Point(this.ClientSize.Width - 210, 14);
            downloadBtn.Click += (s, e) => StartManualDownload(urlInput.Text.Trim());

            inputPanel.Controls.Add(urlInput);
            inputPanel.Controls.Add(pasteBtn);
            inputPanel.Controls.Add(downloadBtn);

            // 3. Pied de page d'information
            Panel footerPanel = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 36,
                BackColor = PanelDark,
                Padding = new Padding(20, 8, 20, 8)
            };

            Label footerText = new Label
            {
                Text = "💡 Astuce : Fermer la fenêtre (X) réduit Mini-IDM dans la barre système (près de l'horloge) pour continuer à capturer les vidéos du navigateur.",
                ForeColor = TextMuted,
                Font = new Font("Segoe UI", 8.5f),
                AutoSize = true,
                Location = new Point(20, 9)
            };
            footerPanel.Controls.Add(footerText);

            // 4. Conteneur déroulant des téléchargements
            jobsContainer = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = BgDark,
                AutoScroll = true,
                Padding = new Padding(20, 8, 20, 16)
            };
            jobsContainer.Resize += (s, e) =>
            {
                lastRenderSignature = "";
                RenderJobsList();
            };

            this.Controls.Add(jobsContainer);
            this.Controls.Add(inputPanel);
            this.Controls.Add(headerPanel);
            this.Controls.Add(footerPanel);
        }

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
        private static extern Int32 SendMessage(IntPtr hWnd, int msg, int wParam, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string lParam);

        private void SendMessageCueBanner(TextBox box, string cue)
        {
            box.HandleCreated += (s, e) =>
            {
                SendMessage(box.Handle, 0x1501, 0, cue);
            };
        }

        private Button CreateStyledButton(string text, Color backColor, int width, int height)
        {
            Button btn = new Button
            {
                Text = text,
                Size = new Size(width, height),
                BackColor = backColor,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI Semibold", 9f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderSize = 0;
            return btn;
        }

        private void InitializeTrayIcon()
        {
            trayMenu = new ContextMenuStrip();

            ToolStripMenuItem openItem = new ToolStripMenuItem("Ouvrir Mini-IDM");
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Click += (s, e) => RestoreFromTray();

            ToolStripMenuItem pasteDlItem = new ToolStripMenuItem("⬇ Télécharger l'URL du presse-papiers");
            pasteDlItem.Click += (s, e) =>
            {
                if (Clipboard.ContainsText())
                {
                    StartManualDownload(Clipboard.GetText().Trim());
                    RestoreFromTray();
                }
            };

            ToolStripMenuItem folderItem = new ToolStripMenuItem("📁 Ouvrir le dossier Mini-IDM");
            folderItem.Click += (s, e) => OpenFolderInExplorer(downloadDir);

            autoStartMenuItem = new ToolStripMenuItem("Lancer automatiquement au démarrage de Windows");
            autoStartMenuItem.Checked = IsAutoStartEnabled();
            autoStartMenuItem.Click += (s, e) => ToggleAutoStart();

            ToolStripMenuItem exitItem = new ToolStripMenuItem("Quitter complètement Mini-IDM");
            exitItem.Click += (s, e) => ExitApplication();

            trayMenu.Items.Add(openItem);
            trayMenu.Items.Add(pasteDlItem);
            trayMenu.Items.Add(folderItem);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(autoStartMenuItem);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(exitItem);

            trayIcon = new NotifyIcon
            {
                Text = "Mini-IDM Video Downloader (Actif)",
                Icon = this.Icon ?? SystemIcons.Application,
                ContextMenuStrip = trayMenu,
                Visible = true
            };
            trayIcon.DoubleClick += (s, e) => RestoreFromTray();
            trayIcon.BalloonTipClicked += (s, e) => RestoreFromTray();
        }

        private bool IsAutoStartEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, false))
                {
                    return key != null && key.GetValue(AppRegistryName) != null;
                }
            }
            catch
            {
                return false;
            }
        }

        private void ToggleAutoStart()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, true))
                {
                    if (key == null) return;
                    if (IsAutoStartEnabled())
                    {
                        key.DeleteValue(AppRegistryName, false);
                        autoStartMenuItem.Checked = false;
                    }
                    else
                    {
                        key.SetValue(AppRegistryName, "\"" + Application.ExecutablePath + "\" --minimized");
                        autoStartMenuItem.Checked = true;
                    }
                }
            }
            catch { }
        }

        private void EnsureBackendServerRunning()
        {
            if (IsServerHealthy()) return;

            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string scriptPath = Path.Combine(baseDir, "server", "server.js");
                if (!File.Exists(scriptPath))
                {
                    scriptPath = Path.GetFullPath(Path.Combine(baseDir, "..", "server", "server.js"));
                }

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "node.exe",
                    Arguments = "\"" + scriptPath + "\"",
                    WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(scriptPath)),
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                serverProcess = Process.Start(psi);
            }
            catch (Exception ex)
            {
                statusLabel.Text = "❌ Erreur lancement Node.js : " + ex.Message;
                statusLabel.ForeColor = Color.FromArgb(248, 113, 113);
            }
        }

        private bool IsServerHealthy()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ServerUrl + "/api/status");
                req.Timeout = 600;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return res.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private void PollServer()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ServerUrl + "/api/downloads");
                    req.Timeout = 1000;
                    using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                    using (StreamReader reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    {
                        string json = reader.ReadToEnd();
                        JavaScriptSerializer ser = new JavaScriptSerializer();
                        DownloadsResponse data = ser.Deserialize<DownloadsResponse>(json);
                        if (data != null && data.ok)
                        {
                            this.BeginInvoke((MethodInvoker)delegate
                            {
                                OnServerDataReceived(data);
                            });
                        }
                    }
                }
                catch
                {
                    this.BeginInvoke((MethodInvoker)delegate
                    {
                        statusLabel.Text = "🔄 Reconnexion au moteur local Mini-IDM...";
                        statusLabel.ForeColor = Color.FromArgb(251, 191, 36);
                        EnsureBackendServerRunning();
                    });
                }
            });
        }

        private void OnServerDataReceived(DownloadsResponse data)
        {
            if (!string.IsNullOrEmpty(data.downloadDir))
            {
                downloadDir = data.downloadDir;
            }

            currentJobs = data.jobs ?? new List<JobInfo>();
            int activeCount = 0;

            foreach (var job in currentJobs)
            {
                if (job.status == "downloading" || job.status == "probing" || job.status == "merging" || job.status == "queued")
                {
                    activeCount++;
                    if (!firstPoll && !notifiedStarted.Contains(job.id))
                    {
                        notifiedStarted.Add(job.id);
                        trayIcon.ShowBalloonTip(
                            2500,
                            "⬇ Téléchargement Mini-IDM démarré",
                            job.filename + " (" + job.mode + ")",
                            ToolTipIcon.Info
                        );
                    }
                }
                else if (job.status == "completed")
                {
                    notifiedStarted.Add(job.id);
                    if (!firstPoll && !notifiedCompleted.Contains(job.id))
                    {
                        notifiedCompleted.Add(job.id);
                        trayIcon.ShowBalloonTip(
                            3500,
                            "✅ Téléchargement terminé !",
                            job.filename + " (" + FormatBytes(job.totalBytes) + ")",
                            ToolTipIcon.Info
                        );
                    }
                    else if (firstPoll)
                    {
                        notifiedCompleted.Add(job.id);
                    }
                }
            }

            firstPoll = false;

            statusLabel.Text = activeCount > 0
                ? string.Format("⚡ {0} téléchargement(s) en cours • Dossier : {1}", activeCount, downloadDir)
                : string.Format("🟢 Moteur actif sur 127.0.0.1:10010 • Dossier : {0}", downloadDir);
            statusLabel.ForeColor = AccentGreen;

            StringBuilder sig = new StringBuilder();
            foreach (var j in currentJobs)
            {
                sig.AppendFormat("{0}:{1}:{2:F1}:{3}:{4}|", j.id, j.status, j.progress, j.downloadedBytes, j.speedBps);
            }
            string newSig = sig.ToString();
            if (newSig != lastRenderSignature)
            {
                lastRenderSignature = newSig;
                RenderJobsList();
            }
        }

        private void RenderJobsList()
        {
            jobsContainer.SuspendLayout();
            int scrollPos = jobsContainer.VerticalScroll.Value;
            jobsContainer.Controls.Clear();

            int cardWidth = Math.Max(640, jobsContainer.ClientSize.Width - 46);
            int y = 8;

            if (currentJobs.Count == 0)
            {
                Label emptyLbl = new Label
                {
                    Text = "Aucun téléchargement pour le moment.\nSurvolez une vidéo dans Chrome / Edge / Brave et cliquez sur « ⬇ Télécharger cette vidéo » !",
                    ForeColor = TextMuted,
                    Font = new Font("Segoe UI", 10.5f),
                    TextAlign = ContentAlignment.MiddleCenter,
                    Size = new Size(cardWidth, 140),
                    Location = new Point(20, 40)
                };
                jobsContainer.Controls.Add(emptyLbl);
                jobsContainer.ResumeLayout();
                return;
            }

            foreach (var job in currentJobs)
            {
                Panel card = CreateJobCard(job, cardWidth);
                card.Location = new Point(20, y);
                jobsContainer.Controls.Add(card);
                y += card.Height + 12;
            }

            if (scrollPos <= jobsContainer.VerticalScroll.Maximum)
            {
                jobsContainer.VerticalScroll.Value = scrollPos;
            }
            jobsContainer.ResumeLayout();
        }

        private Panel CreateJobCard(JobInfo job, int width)
        {
            Panel card = new Panel
            {
                Size = new Size(width, 118),
                BackColor = CardDark
            };
            card.Paint += (s, e) =>
            {
                Graphics g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;

                using (Pen borderPen = new Pen(BorderColor, 1))
                {
                    g.DrawRectangle(borderPen, 0, 0, card.Width - 1, card.Height - 1);
                }

                // Barre de progression principale
                int barX = 16;
                int barY = 58;
                int barW = card.Width - 32;
                int barH = 8;

                using (Brush trackBrush = new SolidBrush(Color.FromArgb(30, 41, 59)))
                {
                    g.FillRectangle(trackBrush, barX, barY, barW, barH);
                }

                int fillW = (int)Math.Round(barW * Math.Max(0, Math.Min(100, job.progress)) / 100.0);
                if (fillW > 0)
                {
                    using (LinearGradientBrush grad = new LinearGradientBrush(
                        new Rectangle(barX, barY, Math.Max(2, fillW), barH),
                        AccentGreen,
                        AccentBlue,
                        LinearGradientMode.Horizontal))
                    {
                        g.FillRectangle(grad, barX, barY, fillW, barH);
                    }
                }

                // Sous-barres des 8 segments si présentes
                if (job.segments != null && job.segments.Count > 1)
                {
                    int segCount = job.segments.Count;
                    int gap = 4;
                    int segW = (barW - gap * (segCount - 1)) / segCount;
                    int segY = 70;
                    for (int i = 0; i < segCount; i++)
                    {
                        var seg = job.segments[i];
                        int sx = barX + i * (segW + gap);
                        using (Brush sb = new SolidBrush(Color.FromArgb(30, 41, 59)))
                        {
                            g.FillRectangle(sb, sx, segY, segW, 4);
                        }
                        double spct = seg.total > 0 ? Math.Min(1.0, (double)seg.downloaded / seg.total) : 0;
                        int sfw = (int)Math.Round(segW * spct);
                        if (sfw > 0)
                        {
                            using (Brush sf = new SolidBrush(AccentBlue))
                            {
                                g.FillRectangle(sf, sx, segY, sfw, 4);
                            }
                        }
                    }
                }
            };

            Label titleLbl = new Label
            {
                Text = job.filename,
                Font = new Font("Segoe UI Semibold", 10.5f, FontStyle.Bold),
                ForeColor = TextLight,
                AutoEllipsis = true,
                Size = new Size(width - 140, 22),
                Location = new Point(16, 12)
            };

            string statusText = (job.status ?? "queued").ToUpperInvariant();
            Color statusBg = job.status == "completed"
                ? Color.FromArgb(6, 78, 59)
                : job.status == "error"
                ? Color.FromArgb(127, 29, 29)
                : Color.FromArgb(30, 58, 138);

            Label badge = new Label
            {
                Text = statusText,
                Font = new Font("Segoe UI", 8f, FontStyle.Bold),
                ForeColor = Color.White,
                BackColor = statusBg,
                TextAlign = ContentAlignment.MiddleCenter,
                Size = new Size(100, 22),
                Location = new Point(width - 116, 12)
            };

            string metaStr = string.Format(
                "⚡ {0}   •   📦 {1}{2} ({3:F1}%){4}{5}",
                job.mode ?? "Direct",
                FormatBytes(job.downloadedBytes),
                job.totalBytes > 0 ? " / " + FormatBytes(job.totalBytes) : "",
                job.progress,
                job.speedBps > 0 ? "   •   🚀 " + FormatBytes(job.speedBps) + "/s" : "",
                job.etaSec.HasValue && job.status == "downloading" ? "   •   ⏱ ETA: " + job.etaSec.Value + "s" : ""
            );

            Label metaLbl = new Label
            {
                Text = metaStr,
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = TextMuted,
                Size = new Size(width - 32, 18),
                Location = new Point(16, 36)
            };

            int btnX = 16;
            int btnY = 82;

            if (job.status == "completed")
            {
                Button playBtn = CreateStyledButton("▶ Lire la vidéo", AccentGreen, 130, 26);
                playBtn.Location = new Point(btnX, btnY);
                playBtn.Click += (s, e) => PlayVideoFile(job.filePath);
                card.Controls.Add(playBtn);
                btnX += 138;

                Button revealBtn = CreateStyledButton("📂 Afficher dans le dossier", Color.FromArgb(51, 65, 85), 185, 26);
                revealBtn.Location = new Point(btnX, btnY);
                revealBtn.Click += (s, e) => SelectFileInExplorer(job.filePath);
                card.Controls.Add(revealBtn);
                btnX += 193;
            }
            else
            {
                Button cancelBtn = CreateStyledButton("⏹ Annuler", Color.FromArgb(127, 29, 29), 105, 26);
                cancelBtn.Location = new Point(btnX, btnY);
                cancelBtn.Click += (s, e) => CancelJob(job.id, false);
                card.Controls.Add(cancelBtn);
                btnX += 113;
            }

            Button removeBtn = CreateStyledButton("🗑 Retirer de la liste", Color.FromArgb(51, 65, 85), 150, 26);
            removeBtn.Location = new Point(btnX, btnY);
            removeBtn.Click += (s, e) => CancelJob(job.id, true);
            card.Controls.Add(removeBtn);

            card.Controls.Add(titleLbl);
            card.Controls.Add(badge);
            card.Controls.Add(metaLbl);

            return card;
        }

        private void OpenFolderInExplorer(string folderPath)
        {
            try
            {
                if (!Directory.Exists(folderPath)) Directory.CreateDirectory(folderPath);
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = "\"" + folderPath + "\"",
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show("Impossible d'ouvrir le dossier : " + ex.Message, "Mini-IDM", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void SelectFileInExplorer(string filePath)
        {
            try
            {
                if (!File.Exists(filePath))
                {
                    OpenFolderInExplorer(downloadDir);
                    return;
                }
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = "/select,\"" + filePath + "\"",
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show("Impossible d'afficher le fichier : " + ex.Message, "Mini-IDM", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void PlayVideoFile(string filePath)
        {
            try
            {
                if (!File.Exists(filePath))
                {
                    MessageBox.Show("Le fichier vidéo n'existe plus à cet emplacement :\n" + filePath, "Mini-IDM", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                Process.Start(new ProcessStartInfo
                {
                    FileName = filePath,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show("Impossible de lancer la lecture : " + ex.Message, "Mini-IDM", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void StartManualDownload(string url)
        {
            if (string.IsNullOrEmpty(url)) return;
            urlInput.Text = "";
            PostJsonAsync("/api/download", new { url = url });
        }

        private void CancelJob(string id, bool remove)
        {
            PostJsonAsync("/api/cancel", new { id = id, remove = remove });
        }

        private void PostJsonAsync(string path, object payload)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    byte[] body = Encoding.UTF8.GetBytes(ser.Serialize(payload));
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ServerUrl + path);
                    req.Method = "POST";
                    req.ContentType = "application/json; charset=utf-8";
                    req.ContentLength = body.Length;
                    using (Stream s = req.GetRequestStream())
                    {
                        s.Write(body, 0, body.Length);
                    }
                    using (req.GetResponse()) { }
                    this.BeginInvoke((MethodInvoker)delegate { PollServer(); });
                }
                catch { }
            });
        }

        private string FormatBytes(long bytes)
        {
            if (bytes <= 0) return "0 B";
            string[] units = { "B", "Ko", "Mo", "Go" };
            int i = (int)Math.Floor(Math.Log(bytes) / Math.Log(1024));
            i = Math.Max(0, Math.Min(units.Length - 1, i));
            double val = bytes / Math.Pow(1024, i);
            return string.Format(i > 1 ? "{0:F2} {1}" : "{0:F0} {1}", val, units[i]);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!allowClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                this.Hide();
                trayIcon.ShowBalloonTip(
                    2000,
                    "Mini-IDM reste actif en arrière-plan",
                    "Les vidéos détectées dans votre navigateur continueront d'être capturées. Double-cliquez sur l'icône pour rouvrir.",
                    ToolTipIcon.Info
                );
                return;
            }
            base.OnFormClosing(e);
        }

        public void RestoreFromTray()
        {
            this.Show();
            if (this.WindowState == FormWindowState.Minimized)
            {
                this.WindowState = FormWindowState.Normal;
            }
            this.Activate();
        }

        private void ExitApplication()
        {
            allowClose = true;
            pollTimer.Stop();
            trayIcon.Visible = false;
            try
            {
                if (serverProcess != null && !serverProcess.HasExited)
                {
                    serverProcess.Kill();
                }
            }
            catch { }
            Application.Exit();
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, @"Local\MiniIDM_SingleInstance_Mutex", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(
                        "Mini-IDM est déjà ouvert (vérifiez l'icône verte dans la barre des tâches près de l'horloge Windows).",
                        "Mini-IDM",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                MainForm form = new MainForm();
                if (args != null && args.Length > 0 && args[0] == "--minimized")
                {
                    form.WindowState = FormWindowState.Minimized;
                    form.ShowInTaskbar = false;
                }
                Application.Run(form);
            }
        }
    }
}

