// =====================================================================================================
// NativeChromaDiagnostic.cs - OPTIONAL troubleshooting tool, not part of the normal app.
//
// Purpose: isolate WHICH Chroma path is broken on a machine. Lighting Lab normally talks to Razer's
// Chroma SDK over its local REST service (http://localhost:54235). If REST requests are acknowledged but
// the keyboard does not change, this tool calls the *native* SDK DLL (RzChromaSDK64.dll, installed with
// Synapse) directly and asks for one unmistakable effect: the whole keyboard SOLID LIME.
//   * Lime appears      -> the native SDK path owns the LEDs; suspect the REST service / app registration.
//   * Nothing changes   -> Chroma Apps ownership/priority in Synapse (or the device bridge) is the problem,
//                          not Lighting Lab's renderer. (This is exactly what docs/VALIDATION.md recorded.)
//
// Build (done by tests/build-native-diagnostic.cjs, output goes to the ignored .artifacts/lighting-lab/):
//     csc.exe /nologo /platform:x64 /target:exe /out:NativeChromaDiagnostic.exe tools\NativeChromaDiagnostic.cs
//
// Command-line flags:
//     --self-test                      Checks constants only. Makes ZERO native calls and ZERO RGB writes.
//     --run <10-300 seconds> [stop-file]
//                                      Really lights the keyboard lime for that many seconds (or until the
//                                      optional stop-file appears), then DeleteEffect + UnInit.
//                                      Keyboard only: mice, headsets, etc. are never addressed.
//
// What it writes: one JSON-lines audit file per run in
//     %LOCALAPPDATA%\jeby Labs\Lighting Lab\native-diagnostics\<UTC timestamp>-native.jsonl
// The intended request and cleanup plan are recorded BEFORE the first vendor call, so a crash mid-run still
// leaves evidence. An SDK "success" result is never treated as proof the LEDs changed; only the person
// looking at the keyboard can confirm that.
// =====================================================================================================
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/// <summary>Single-purpose native Chroma SDK probe (see file header).</summary>
internal static class NativeChromaDiagnostic {
    /// <summary>RZRESULT_SUCCESS in the Chroma SDK headers.</summary>
    private const int Success = 0;
    /// <summary>ChromaSDK::Keyboard::CHROMA_STATIC (4): one color for the whole keyboard.</summary>
    private const int StaticKeyboardEffect = 4;
    /// <summary>COLORREF is 0x00BBGGRR, so 0x0000ff00 is pure green ("lime"): easy to tell apart from any rainbow.</summary>
    private const int LimeColorRef = 0x0000ff00;

    // P/Invoke signatures for the 64-bit native SDK DLL that Synapse installs into System32.
    // All functions are C (cdecl) exports returning an RZRESULT integer.

    /// <summary>Start a native SDK session for this process.</summary>
    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int Init();

    /// <summary>End the native session; Synapse takes the keyboard back.</summary>
    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int UnInit();

    /// <summary>Create (but do not yet show) a keyboard effect; `parameter` points at the effect's struct (here one COLORREF).</summary>
    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int CreateKeyboardEffect(int effect, IntPtr parameter, out Guid effectId);

    /// <summary>Make a previously created effect the active one.</summary>
    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int SetEffect(Guid effectId);

    /// <summary>Free a created effect. Always called during cleanup if creation succeeded.</summary>
    [DllImport("RzChromaSDK64.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int DeleteEffect(Guid effectId);

    /// <summary>Minimal JSON string escaping for the hand-written audit lines (no serializer dependency).</summary>
    private static string Escape(string value) {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    /// <summary>Append one {"at","kind","detail"} JSON line and flush immediately (survives a crash).</summary>
    private static void Record(StreamWriter audit, string kind, string detail) {
        audit.WriteLine("{\"at\":\"" + DateTime.UtcNow.ToString("o") + "\",\"kind\":\"" +
            Escape(kind) + "\",\"detail\":\"" + Escape(detail) + "\"}");
        audit.Flush();
    }

    /// <summary>Turn any non-zero RZRESULT into an exception naming the failing call.</summary>
    private static void RequireSuccess(string operation, int result) {
        if (result != Success) throw new InvalidOperationException(operation + " returned Chroma result " + result + ".");
    }

    /// <summary>
    /// `--self-test`: proves the binary was built from the expected constants without loading the DLL.
    /// tests/build-native-diagnostic.cjs asserts on the exact JSON printed here.
    /// </summary>
    private static int SelfTest() {
        if (StaticKeyboardEffect != 4 || LimeColorRef != 0x0000ff00)
            throw new InvalidOperationException("Native diagnostic constants changed unexpectedly.");
        Console.WriteLine("{\"ok\":true,\"nativeCalls\":0,\"rgbWrites\":0,\"effect\":\"solid-lime-keyboard-only\"}");
        return 0;
    }

    /// <summary>
    /// `--run`: Init -> CreateKeyboardEffect(static lime) -> SetEffect -> wait -> DeleteEffect -> UnInit.
    /// Cleanup runs in `finally` for whatever stage was reached, and every result is audited.
    /// </summary>
    /// <param name="seconds">How long to hold the lime effect (validated 10-300 by Main).</param>
    /// <param name="stopFile">Optional absolute path; creating that file ends the run early.</param>
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
                // CHROMA_STATIC's parameter is a STATIC_EFFECT_TYPE struct holding one COLORREF (4 bytes).
                parameter = Marshal.AllocHGlobal(sizeof(int));
                Marshal.WriteInt32(parameter, LimeColorRef);
                RequireSuccess("CreateKeyboardEffect", CreateKeyboardEffect(StaticKeyboardEffect, parameter, out effectId));
                effectCreated = true;
                Record(audit, "keyboard-effect-created", effectId.ToString());
                RequireSuccess("SetEffect", SetEffect(effectId));
                Record(audit, "keyboard-effect-activated", "solid lime requested; SDK acknowledgement is not LED readback");
                Console.WriteLine("Native Chroma keyboard diagnostic is active: SOLID LIME for " + seconds + " seconds.");
                Console.WriteLine("Audit: " + auditPath);
                // Hold the effect while the owner looks at the keyboard; poll for the stop-file every 100 ms.
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
                // Release in reverse order of acquisition; each cleanup result is recorded, never assumed.
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

    /// <summary>
    /// Entry point. Exit codes: 0 success, 1 failure (message on stderr), 2 unrecognized arguments.
    /// </summary>
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
