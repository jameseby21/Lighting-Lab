// Isolate the installed native Chroma keyboard path from Lighting Lab's REST transport.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class NativeChromaDiagnostic {
    private const int Success = 0;
    private const int StaticKeyboardEffect = 4;
    private const int LimeColorRef = 0x0000ff00;

    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int Init();

    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int UnInit();

    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int CreateKeyboardEffect(int effect, IntPtr parameter, out Guid effectId);

    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int SetEffect(Guid effectId);

    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int DeleteEffect(Guid effectId);

    private static string Escape(string value) {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private static void Record(StreamWriter audit, string kind, string detail) {
        audit.WriteLine("{\"at\":\"" + DateTime.UtcNow.ToString("o") + "\",\"kind\":\"" +
            Escape(kind) + "\",\"detail\":\"" + Escape(detail) + "\"}");
        audit.Flush();
    }

    private static void RequireSuccess(string operation, int result) {
        if (result != Success) throw new InvalidOperationException(operation + " returned Chroma result " + result + ".");
    }

    private static int SelfTest() {
        if (StaticKeyboardEffect != 4 || LimeColorRef != 0x0000ff00)
            throw new InvalidOperationException("Native diagnostic constants changed unexpectedly.");
        Console.WriteLine("{\"ok\":true,\"nativeCalls\":0,\"rgbWrites\":0,\"effect\":\"solid-lime-keyboard-only\"}");
        return 0;
    }

    private static int Run(int seconds, string stopFile) {
        string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "jeby Labs", "Lighting Lab", "native-diagnostics");
        Directory.CreateDirectory(directory);
        string auditPath = Path.Combine(directory, DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-native.jsonl");
        bool initialized = false;
        bool effectCreated = false;
        Guid effectId = Guid.Empty;
        IntPtr parameter = IntPtr.Zero;
        using (StreamWriter audit = new StreamWriter(new FileStream(auditPath, FileMode.CreateNew,
            FileAccess.Write, FileShare.Read), new UTF8Encoding(false))) {
            audit.AutoFlush = true;
            // The request and cleanup boundary exist on disk before the first vendor call.
            Record(audit, "diagnostic-requested", "solid-lime keyboard only; duration=" + seconds +
                "s; stop-file=" + (stopFile ?? "none") +
                "; cleanup=DeleteEffect+UnInit; physical result requires owner observation");
            try {
                RequireSuccess("Init", Init());
                initialized = true;
                Record(audit, "native-init-acknowledged", "physical lighting is not yet verified");
                parameter = Marshal.AllocHGlobal(sizeof(int));
                Marshal.WriteInt32(parameter, LimeColorRef);
                RequireSuccess("CreateKeyboardEffect", CreateKeyboardEffect(StaticKeyboardEffect, parameter, out effectId));
                effectCreated = true;
                Record(audit, "keyboard-effect-created", effectId.ToString());
                RequireSuccess("SetEffect", SetEffect(effectId));
                Record(audit, "keyboard-effect-activated", "solid lime requested; SDK acknowledgement is not LED readback");
                Console.WriteLine("Native Chroma keyboard diagnostic is active: SOLID LIME for " + seconds + " seconds.");
                Console.WriteLine("Audit: " + auditPath);
                Stopwatch clock = Stopwatch.StartNew();
                while (clock.Elapsed.TotalSeconds < seconds && (stopFile == null || !File.Exists(stopFile)))
                    Thread.Sleep(100);
                if (stopFile != null && File.Exists(stopFile)) Record(audit, "stop-file-observed", stopFile);
                return 0;
            } catch (Exception error) {
                Record(audit, "diagnostic-failed", error.GetType().Name + ": " + error.Message);
                Console.Error.WriteLine("Native Chroma diagnostic failed: " + error.Message);
                return 1;
            } finally {
                if (parameter != IntPtr.Zero) Marshal.FreeHGlobal(parameter);
                if (effectCreated) {
                    try { Record(audit, "delete-effect-result", DeleteEffect(effectId).ToString()); }
                    catch (Exception error) { Record(audit, "delete-effect-failed", error.Message); }
                }
                if (initialized) {
                    try { Record(audit, "uninit-result", UnInit().ToString()); }
                    catch (Exception error) { Record(audit, "uninit-failed", error.Message); }
                }
            }
        }
    }

    public static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            if ((args.Length == 2 || args.Length == 3) && args[0] == "--run") {
                int seconds;
                if (!Int32.TryParse(args[1], out seconds) || seconds < 10 || seconds > 300)
                    throw new ArgumentException("Duration must be 10-300 seconds.");
                return Run(seconds, args.Length == 3 ? Path.GetFullPath(args[2]) : null);
            }
            Console.Error.WriteLine("Use --self-test (zero writes) or --run <10-300 seconds> [stop-file] (keyboard-only solid lime diagnostic).");
            return 2;
        } catch (Exception error) {
            Console.Error.WriteLine("Native Chroma diagnostic stopped: " + error.Message);
            return 1;
        }
    }
}
