// =====================================================================================================
// ChromaPreset.cs - the Razer half of the portable "Download .exe" preset player.
//
// What it is: a tiny console program (compiled on the user's PC by export.cjs with the .NET Framework
// csc.exe that ships with Windows) that plays ONE exported Lighting Lab setup on a Razer keyboard through
// the locally installed Chroma SDK REST service (http://localhost:54235). It needs no Node, no Lighting Lab
// server, and installs nothing. Closing the window releases the keyboard back to Synapse.
//
// How it works:
//   * export.cjs pre-renders 128 background frames with the SAME renderer the browser preview uses
//     (effects.js) and embeds them, plus the physical key list, in a JSON resource ("preset.json").
//   * This player loops those frames at the exported frame rate (~22 fps) and, if the user opts in,
//     composites key-press reactions on top in real time (PhysicalInput.cs supplies key identities).
//   * Reactions are re-implemented here in C# because the frames are baked; Fade() below mirrors
//     reactionSample() in effects.js. Keep the two in sync when adding a reaction.
//
// Privacy: key identities live only in memory for ~2.4 s; nothing typed is logged or assembled.
// Audit lines (Audit class in PresetRunner.cs) record SDK results, never keys.
// =====================================================================================================
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class ChromaPreset {
    private const string SdkRoot = "http://localhost:54235/razer/chromasdk";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };

    // JavaScriptSerializer returns loosely typed trees; these helpers keep the casts readable.
    private static Dictionary<string, object> Map(object value) { return (Dictionary<string, object>)value; }
    private static object[] Items(object value) { return (object[])value; }
    private static int Number(object value) { return Convert.ToInt32(value); }

    // ---------------------------------------------------------------------------------------------
    // Chroma REST transport
    // ---------------------------------------------------------------------------------------------

    /// <summary>
    /// One SDK call with a narrow retry: a freshly registered session's port can briefly refuse
    /// connections, so ConnectFailure is retried up to 5 times (100 ms apart). Registration itself is
    /// never retried - if the SDK root refuses, Chroma is simply not installed/running.
    /// </summary>
    private static Dictionary<string, object> Request(string url, string method, object value) {
        for (int attempt = 0; ; attempt++) {
            try { return RequestOnce(url, method, value); }
            catch (WebException error) {
                if (attempt >= 5 || error.Status != WebExceptionStatus.ConnectFailure || url == SdkRoot) throw;
                Thread.Sleep(100);
            }
        }
    }

    /// <summary>Send JSON, parse JSON, and surface any non-zero SDK "result" code as an error.</summary>
    private static Dictionary<string, object> RequestOnce(string url, string method, object value) {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = method;
        request.Proxy = null;              // Loopback only; a system proxy must never see lighting traffic.
        request.Timeout = 3000;
        request.ReadWriteTimeout = 3000;
        request.KeepAlive = true;
        if (value != null) {
            byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(value));
            request.ContentType = "application/json";
            request.ContentLength = bytes.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        }
        using (WebResponse response = request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream())) {
            string text = reader.ReadToEnd();
            Dictionary<string, object> result = text.Length == 0 ? new Dictionary<string, object>() : Map(Json.DeserializeObject(text));
            if (result.ContainsKey("result") && Number(result["result"]) != 0)
                throw new IOException("Chroma rejected the request: SDK result " + result["result"] + ".");
            return result;
        }
    }

    /// <summary>
    /// Register this player as a Chroma app and return its session URI. The returned URI must be a
    /// plain http loopback address - anything else is refused rather than trusted.
    /// </summary>
    private static string Register() {
        var result = Request(SdkRoot, "POST", new {
            title = "Lighting Lab Portable Preset",
            description = "A single exported keyboard preset",
            author = new { name = "jeby Labs", contact = "local" },
            device_supported = new string[] { "keyboard", "mouse" },
            category = "application"
        });
        Uri uri;
        if (!result.ContainsKey("uri") || !Uri.TryCreate(Convert.ToString(result["uri"]), UriKind.Absolute, out uri)
            || !uri.IsLoopback || uri.Scheme != "http" || uri.UserInfo.Length != 0)
            throw new IOException("Chroma returned an invalid local session address.");
        return uri.ToString().TrimEnd('/');
    }

    // ---------------------------------------------------------------------------------------------
    // Reaction compositor (mirror of reactionSample() in effects.js)
    // ---------------------------------------------------------------------------------------------

    /// <summary>Small deterministic string hash (FNV-1a) for flicker/sparkle; same idea as hash() in effects.js.</summary>
    private static uint Hash(string value) {
        uint n = 2166136261;
        foreach (char c in value) { n ^= c; n = unchecked(n * 16777619); }
        return n;
    }

    /// <summary>
    /// Brightness (0..1) a reaction contributes to a key that is (dr rows, dc columns) away from the
    /// pressed key, `age` ms after the press. 0 means "no effect on this key right now".
    /// Every mode the editor offers is covered; before October 2026 only reactive/ripple/waterfall were,
    /// so the other eight silently did nothing in exported players (ISSUES-LOG LL-021).
    /// </summary>
    internal static double Fade(string mode, double dr, double dc, double age, string pressId, string keyId) {
        if (age < 0 || age > 2400) return 0;
        bool local = dr == 0 && dc == 0;   // The pressed key itself.
        switch (mode) {
            case "reactive": return local ? Math.Max(0, 1 - age / 1300) : 0;   // Slow white-style fade.
            case "flash": return local ? Math.Max(0, 1 - age / 320) : 0;       // Quick blink.
            case "pulse": return local ? Math.Max(0, 1 - age / 700) : 0;       // Medium fade.
            case "flame": {
                // Key-local flare with a 70 ms flicker so it reads as fire, not a plain fade.
                if (!local || age >= 950) return 0;
                double flicker = .72 + (Hash(pressId + ":" + Math.Floor(age / 70)) % 29) / 100.0;
                return Math.Max(0, (1 - age / 950) * flicker);
            }
            case "ripple":
            case "rainbow-ripple": {
                // An expanding ring: each key lights 110 ms per unit of distance after the press, for 450 ms.
                double distance = Math.Sqrt(dr * dr + dc * dc), elapsed = age - distance * 110;
                return elapsed >= 0 && elapsed < 450 ? (1 - elapsed / 450) * Math.Max(.35, 1 - distance / 18) : 0;
            }
            case "waterfall": {
                // Falls straight down the pressed key's column, one row per 150 ms.
                double elapsed = age - dr * 150;
                return dr >= 0 && Math.Abs(dc) <= .8 && elapsed >= 0 && elapsed < 420 ? 1 - elapsed / 420 : 0;
            }
            case "fading-trail": {
                // Runs right along the row, 100 ms per key.
                double elapsed = age - dc * 100;
                return Math.Abs(dr) <= .5 && dc >= 0 && elapsed >= 0 && elapsed < 700 ? 1 - elapsed / 700 : 0;
            }
            case "comet": {
                // Like fading-trail but slower with a longer tail.
                double elapsed = age - dc * 120;
                return Math.Abs(dr) <= .5 && dc >= 0 && elapsed >= 0 && elapsed < 900 ? 1 - elapsed / 900 : 0;
            }
            case "sparkle": {
                // Random keys twinkle for 700 ms; about one key in nine per 100 ms tick.
                if (age >= 700) return 0;
                return Hash(pressId + ":" + keyId + ":" + Math.Floor(age / 100)) % 9 == 0 ? 1 - age / 700 : 0;
            }
            default: return 0;   // "none" or a future mode this player does not know.
        }
    }

    /// <summary>Hue/saturation/value to a BGR int (Chroma's color order), used for rainbow-ripple.</summary>
    private static int Hsv(double h, double s, double v) {
        h = ((h % 360) + 360) % 360;
        double c = v * s, x = c * (1 - Math.Abs((h / 60) % 2 - 1)), m = v - c, r, g, b;
        if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
        return Bgr((int)Math.Round((r + m) * 255), (int)Math.Round((g + m) * 255), (int)Math.Round((b + m) * 255));
    }
    private static int Bgr(int red, int green, int blue) { return red | (green << 8) | (blue << 16); }

    /// <summary>"#rrggbb" to BGR; anything malformed falls back to white (the editor's default reaction color).</summary>
    internal static int HexToBgr(object value) {
        string text = Convert.ToString(value);
        if (text == null || text.Length != 7 || text[0] != '#') return Bgr(255, 255, 255);
        try {
            return Bgr(Convert.ToInt32(text.Substring(1, 2), 16), Convert.ToInt32(text.Substring(3, 2), 16), Convert.ToInt32(text.Substring(5, 2), 16));
        } catch (FormatException) { return Bgr(255, 255, 255); }
    }

    /// <summary>Blend BGR `from` toward BGR `to` by alpha (0..1), channel by channel.</summary>
    internal static int Blend(int from, int to, double alpha) {
        int next = 0;
        for (int channel = 0; channel < 3; channel++) {
            int a = (from >> (channel * 8)) & 255, b = (to >> (channel * 8)) & 255;
            next |= ((int)Math.Floor(a + (b - a) * alpha + .5)) << (channel * 8);
        }
        return next;
    }

    /// <summary>One remembered key press (identity + time only; never the character typed).</summary>
    private sealed class Press { internal string id; internal string mode; internal double time; }

    /// <summary>
    /// Reaction settings for one key group (anchor / background / orientation) from a "groups" setup.
    /// </summary>
    // name/strength/protect mirror the editor redesign (LL-062): strength scales the reaction, and a protected
    // group ignores presses that started in a different group.
    private sealed class GroupReaction { internal string name = "background"; internal string mode = "none"; internal int color = Bgr(255, 255, 255); internal double strength = 1; internal bool protect = false; }

    // ---------------------------------------------------------------------------------------------
    // Player
    // ---------------------------------------------------------------------------------------------

    /// <summary>
    /// Play the embedded preset until Ctrl+C. Arguments: none (asks about reactions), or
    /// --with-feedback (reactions on without asking). Returns 0 on a clean stop.
    /// </summary>
    internal static int Run(string manifestJson, string[] args) {
        var manifest = Map(Json.DeserializeObject(manifestJson));
        var settings = Map(manifest["requested"]);
        var playback = Map(manifest["playback"]);
        object[] frames = Items(playback["frames"]), keys = Items(playback["keys"]);
        int frameMs = Number(playback["frameMs"]);
        if (frames.Length == 0 || frames.Length > 1000 || frameMs < 20 || frameMs > 200)
            throw new InvalidDataException("Invalid preset frame sequence.");

        // --- Which reaction applies where -----------------------------------------------------
        // Layered setups ("groups") pick the reaction by the LIT key's group, exactly like the editor.
        // Older setups without groups keep the original rule: the PRESSED key's group decides.
        var selected = new HashSet<string>();
        foreach (object id in Items(settings["anchors"])) selected.Add(Convert.ToString(id));
        var protectedKeys = new HashSet<string>();
        foreach (object id in Items(settings["protectedAnchors"])) protectedKeys.Add(Convert.ToString(id));
        bool protect = settings.ContainsKey("protectAnchors") && Convert.ToBoolean(settings["protectAnchors"]);
        string feedback = Convert.ToString(settings["feedback"]);
        string keywordFeedback = settings.ContainsKey("keywordFeedback") ? Convert.ToString(settings["keywordFeedback"]) : feedback;

        Dictionary<string, GroupReaction> groupReactions = null;
        if (settings.ContainsKey("groups") && settings["groups"] is Dictionary<string, object>) {
            groupReactions = new Dictionary<string, GroupReaction>();
            foreach (var entry in Map(settings["groups"])) {
                var group = entry.Value as Dictionary<string, object>;
                if (group == null) continue;
                double reactionStrength = 1;
                if (group.ContainsKey("reactionStrength") && group["reactionStrength"] != null)
                    reactionStrength = Math.Max(0, Math.Min(1, Convert.ToDouble(group["reactionStrength"])));
                groupReactions[entry.Key] = new GroupReaction {
                    name = entry.Key,
                    mode = group.ContainsKey("reaction") ? Convert.ToString(group["reaction"]) : "none",
                    color = HexToBgr(group.ContainsKey("reactionColor") ? group["reactionColor"] : null),
                    strength = reactionStrength,
                    protect = group.ContainsKey("protect") && group["protect"] is bool && (bool)group["protect"]
                };
            }
        }
        Func<string, GroupReaction> reactionFor = delegate(string keyId) {
            string name = protectedKeys.Contains(keyId) ? "orientation" : selected.Contains(keyId) ? "anchor" : "background";
            GroupReaction found;
            return groupReactions != null && groupReactions.TryGetValue(name, out found) ? found : new GroupReaction { name = name };
        };
        bool anyReaction = groupReactions != null
            ? new List<GroupReaction>(groupReactions.Values).Exists(g => g.mode != "none")
            : feedback != "none" || keywordFeedback != "none";

        // --- Opt-in keyboard reactions --------------------------------------------------------
        bool useInput = args.Length == 1 && args[0] == "--with-feedback";
        if (args.Length > 0 && !useInput)
            throw new ArgumentException("Use --with-feedback for memory-only keyboard reactions, or no argument for lighting only.");
        if (!useInput && !Console.IsInputRedirected && anyReaction) {
            Console.WriteLine("Enable keyboard reactions while this preset is open? Key identities stay in memory, without typed-text logging. [Y/N]");
            useInput = Console.ReadKey(true).Key == ConsoleKey.Y;
        }

        var aliases = settings.ContainsKey("inputAliases") ? Map(settings["inputAliases"]) : new Dictionary<string, object>();
        var keyMap = new Dictionary<string, Dictionary<string, object>>();
        foreach (object item in keys) { var key = Map(item); keyMap[Convert.ToString(key["id"])] = key; }

        var presses = new List<Press>();
        string session = null;
        bool stop = false;
        ConsoleCancelEventHandler cancel = delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; stop = true; };
        Console.CancelKeyPress += cancel;

        using (Audit audit = new Audit()) {
            audit.Record("portable-before-sdk", new { manifest = Json.DeserializeObject(manifestJson), inputEnabled = useInput });
            try {
                session = Register();
                Stopwatch clock = Stopwatch.StartNew();
                long heartbeat = 0;
                int failures = 0;
                bool activated = false, mouseEnabled = playback.ContainsKey("mouseFrames");

                if (useInput) {
                    // Windows virtual-key code -> Lighting Lab switch ID, from the exported key list.
                    var map = new Dictionary<int, string>();
                    foreach (object item in keys) {
                        var key = Map(item);
                        int vk = Number(key["vk"]);
                        if (vk != 0) map[vk] = Convert.ToString(key["id"]);
                    }
                    PhysicalInput.Start(map, delegate(string id) {
                        // A "lighting substitute" lets a working key trigger the reaction of a broken one.
                        if (aliases.ContainsKey(id)) id = Convert.ToString(aliases[id]);
                        string legacyMode = selected.Contains(id) ? keywordFeedback : feedback;
                        if (groupReactions != null || legacyMode != "none")
                            presses.Add(new Press { id = id, mode = legacyMode, time = clock.Elapsed.TotalMilliseconds });
                    });
                }

                Console.WriteLine("Razer keyboard detected. Playing the exported setup through Chroma. Keep this preset open; press Ctrl+C to release it.\n" +
                    "If lights stay unchanged, enable Chroma Apps and give Lighting Lab priority in Synapse. SDK acknowledgement alone cannot verify the LEDs.\n" +
                    "The background is a repeating exported animation; closing this window returns control to Synapse.");

                while (!stop) {
                    double now = clock.Elapsed.TotalMilliseconds;
                    if (useInput) PhysicalInput.Pump();   // The low-level hook only fires while messages are pumped.
                    presses.RemoveAll(p => now - p.time > 2400);
                    if (presses.Count > 128) presses.RemoveRange(0, presses.Count - 128);

                    // Copy the baked frame for this moment into a mutable 6x22 canvas (Chroma's keyboard grid).
                    object[] original = Items(frames[(int)(now / frameMs) % frames.Length]);
                    int[][] canvas = new int[6][];
                    for (int r = 0; r < 6; r++) {
                        var row = Items(original[r]);
                        canvas[r] = new int[22];
                        for (int c = 0; c < 22; c++) canvas[r][c] = Number(row[c]);
                    }

                    // Composite reactions per physical key, using physical geometry (x/y) for distances.
                    foreach (object item in keys) {
                        var key = Map(item);
                        string id = Convert.ToString(key["id"]);
                        GroupReaction target = groupReactions != null ? reactionFor(id) : null;
                        if (groupReactions == null && (protectedKeys.Contains(id) || (protect && selected.Contains(id)))) continue;
                        if (target != null && target.mode == "none") continue;
                        double alpha = 0, bestAge = 0, bestDistance = 0;
                        foreach (Press press in presses) {
                            Dictionary<string, object> origin;
                            if (!keyMap.TryGetValue(press.id, out origin)) continue;
                            double dr = Convert.ToDouble(key["y"]) - Convert.ToDouble(origin["y"]);
                            double dc = Convert.ToDouble(key["x"]) - Convert.ToDouble(origin["x"]);
                            // Protected target group: ignore presses that started in a different group.
                            if (target != null && target.protect && reactionFor(press.id).name != target.name) continue;
                            string mode = target != null ? target.mode : press.mode;
                            double value = Fade(mode, dr, dc, now - press.time, press.id, id);
                            if (value > alpha) { alpha = value; bestAge = now - press.time; bestDistance = Math.Sqrt(dr * dr + dc * dc); }
                        }
                        if (target != null) alpha *= target.strength;
                        if (alpha <= 0) continue;
                        int r0 = Number(key["row"]), c0 = Number(key["col"]);
                        int color = target == null ? Bgr(255, 255, 255)
                            : target.mode == "rainbow-ripple" ? Hsv((bestAge + bestDistance * 40) / 7, .9, 1)
                            : target.color;
                        canvas[r0][c0] = Blend(canvas[r0][c0], color, alpha);
                    }

                    try {
                        // Chroma drops idle sessions; a heartbeat every 1.5 s keeps ours alive.
                        if (clock.ElapsedMilliseconds - heartbeat >= 1500) {
                            Request(session + "/heartbeat", "PUT", null);
                            heartbeat = clock.ElapsedMilliseconds;
                        }
                        var frame = new { effect = "CHROMA_CUSTOM", param = canvas };
                        if (!activated) {
                            // First frame: documented create -> SetEffect path (makes this app the active owner).
                            var created = Request(session + "/keyboard", "POST", frame);
                            if (!created.ContainsKey("id")) throw new IOException("Chroma did not return an effect identifier.");
                            Request(session + "/effect", "PUT", new { id = Convert.ToString(created["id"]) });
                            activated = true;
                        } else Request(session + "/keyboard", "PUT", frame);
                        if (mouseEnabled) {
                            try {
                                var mouse = Items(playback["mouseFrames"]);
                                Request(session + "/mouse", "PUT", new { effect = "CHROMA_CUSTOM2", param = mouse[(int)(now / frameMs) % mouse.Length] });
                            } catch (Exception error) {
                                // No compatible mouse is not a failure of the keyboard preset.
                                mouseEnabled = false;
                                audit.Record("mouse-unavailable", new { error = error.Message });
                                Console.WriteLine("Keyboard continues; mouse sync unavailable: " + error.Message);
                            }
                        }
                        failures = 0;
                    } catch (Exception error) {
                        audit.Record("sdk-failed", new { error = error.Message });
                        if (++failures >= 2) throw;   // Two consecutive failures: stop and report instead of spinning.
                        Thread.Sleep(200);
                    }
                    Thread.Sleep(frameMs);
                }
            } finally {
                PhysicalInput.Stop();
                Console.CancelKeyPress -= cancel;
                if (session != null) {
                    try { Request(session, "DELETE", null); }   // Unregister so Synapse takes the keyboard back.
                    catch (Exception error) { audit.Record("release-failed", new { error = error.Message }); }
                }
            }
        }
        return 0;
    }

    internal static bool HasVendor(ushort vendor, ushort product, bool keyboard) { return HidDiscovery.HasDevice(vendor, product, keyboard); }

    /// <summary>
    /// In-memory checks run by `--self-test` (and by tests/build-portable.cjs). No SDK call, no HID access.
    /// Returns the number of assertions so the caller can require a minimum.
    /// </summary>
    internal static int SelfTest(string manifestJson) {
        if (Fade("reactive", 0, 0, 0, "Q", "Q") != 1 || Fade("reactive", 0, 0, 1300, "Q", "Q") != 0 || Fade("reactive", 0, 1, 0, "Q", "W") != 0
            || Fade("ripple", 0, 1, 110, "Q", "W") < .9 || Fade("waterfall", 1, .25, 150, "Q", "A") != 1)
            throw new Exception("Portable feedback compositor failed.");
        // Every editor reaction must light the pressed key (or its neighbor) at some point; "none" never does.
        string[] modes = { "reactive", "flash", "pulse", "flame", "ripple", "rainbow-ripple", "waterfall", "fading-trail", "comet", "sparkle" };
        int checks = 10;
        foreach (string mode in modes) {
            double peak = 0;
            for (int age = 0; age < 1000; age += 10) {
                peak = Math.Max(peak, Fade(mode, 0, 0, age, "Q", "Q"));
                peak = Math.Max(peak, Fade(mode, 0, 1, age, "Q", "W"));
                peak = Math.Max(peak, Fade(mode, 1, 0, age, "Q", "A"));
            }
            if (peak <= 0) throw new Exception("Portable reaction '" + mode + "' never lights a key.");
            checks++;
        }
        if (Fade("none", 0, 0, 0, "Q", "Q") != 0) throw new Exception("'none' must not light keys.");
        if (HexToBgr("#ff0000") != 0x0000ff || HexToBgr("bad") != 0xffffff || Blend(0, 0x0000ff, 1) != 0x0000ff || Blend(0x0000ff, 0, .5) != 0x000080)
            throw new Exception("Portable color blending failed.");
        checks += 2;

        var map = new Dictionary<int, string> { { 81, "Q" } };
        if (PhysicalInput.Identity(46, 0x53, false, map) != "NUM_DECIMAL" || PhysicalInput.Identity(13, 0x1c, true, map) != "NUM_ENTER"
            || PhysicalInput.Identity(13, 0x1c, false, map) != "ENTER" || PhysicalInput.Identity(45, 0x52, false, map) != "NUM_0"
            || PhysicalInput.Identity(81, 0x10, false, map) != "Q")
            throw new Exception("Portable physical key identity failed.");

        var manifest = Map(Json.DeserializeObject(manifestJson));
        if (Number(manifest["schemaVersion"]) == 2) {
            var playback = Map(manifest["playback"]);
            foreach (object item in Items(playback["frames"])) {
                var rows = Items(item);
                if (rows.Length != 6) throw new Exception("Invalid portable frame height.");
                foreach (object row in rows) {
                    if (Items(row).Length != 22) throw new Exception("Invalid portable frame width.");
                    checks++;
                }
            }
        }
        return checks;
    }
}
