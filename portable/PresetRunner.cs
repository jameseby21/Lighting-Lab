// =====================================================================================================
// PresetRunner.cs - entry point (Program.Main) of every "Download .exe" preset, plus the YUNZII AL65
// VIA lighting writer. Compiled together with ChromaPreset.cs and PhysicalInput.cs by export.cjs using
// the .NET Framework 4.x csc.exe that ships with Windows; the chosen setup is embedded as the managed
// resource "preset.json". The exe installs nothing and needs no Node, VIA, or Lighting Lab server.
//
// ---- Two manifest schemas --------------------------------------------------------------------------
//   schemaVersion 2 ("Auto"):  baked animation frames for a Razer keyboard through the installed Chroma
//                              runtime (ChromaPreset.Run). If no Razer keyboard is present but a wired AL65
//                              is, and the export included an acknowledged AL65 approximation (manifest.al65),
//                              the runner falls through to the AL65 path with that embedded v1 manifest.
//   schemaVersion 1 ("AL65"):  one whole-board BUILT-IN firmware effect for the YUNZII AL65 (VID 0x4D4B,
//                              PID 0x3068). This is an explicitly acknowledged APPROXIMATION of the editor's
//                              layered per-key setup (approximationAcknowledged must be true).
//
// ---- Command-line flags ----------------------------------------------------------------------------
//   (no argument)        Apply. Razer: play until Ctrl+C. AL65: back up, write, verify, save, verify, exit.
//   --inspect            Print the embedded preset.json. Never touches a device.
//   --self-test          In-memory protocol, rollback, compositor and key-identity checks. Prints
//                        {"passed":N,"realHidWrites":0}. Never touches a device.
//   --help               Usage text for the detected schema.
//   --probe              Read-only discovery. Razer: report presence only. AL65: open the VIA interface and
//                        READ the current lighting values (no writes).
//   --restore <file>     AL65 only: write back a backup JSON captured by an earlier apply. The backup's
//                        device fingerprint must match the connected keyboard.
//   --with-feedback      Razer only (handled in ChromaPreset.Run): enable reactions without the Y/N prompt.
//
// ---- The VIA protocol subset used (and NOTHING else) -----------------------------------------------
//   Transport: Windows HID, the AL65's vendor interface (usage page 0xFF60, usage 0x61), 33-byte reports:
//              byte 0 = HID report ID (always 0), bytes 1..32 = the 32-byte VIA payload.
//   Payload:   [command, channel, value id, data...]
//     command 1  id_get_protocol_version   (no channel) -> reply bytes 1..2 = version; only 11-13 accepted.
//     command 7  id_custom_set_value       channel 3 = backlight, value id + data
//     command 8  id_custom_get_value       channel 3, value id -> reply byte 3 (and 4 for color) = value
//     command 9  id_custom_save            channel 3 -> persist current backlight values in the keyboard
//   Value ids on channel 3 (from YUNZII's official AL65 VIA definition, portable/al65-definition.json):
//     1 brightness (0-255) · 2 effect/mode (0-20) · 3 effect speed (0-255) · 4 color (hue, saturation)
//   MakeReport() is a closed allowlist: any other command, value id, or payload length throws BEFORE a byte
//   is sent, so keymaps, macros, bootloader/firmware commands and the underglow channel are unreachable.
//
// ---- Transaction (LightingTransaction.Apply) -------------------------------------------------------
//   1. Read the four current values.  2. Write them to a backup file (CreateNew; never overwrites an older
//   backup) - if this fails, nothing has been changed.  3. Write the desired values.  4. Read back and
//   compare.  5. Save (command 9).  6. Read back again.  Any failure in 3-6 triggers an automatic restore of
//   the original values (write, verify, save, verify); if that also fails, the user is told to run
//   --restore with the printed backup path once USB is back.
//
// ---- Where it writes -------------------------------------------------------------------------------
//   %LOCALAPPDATA%\jeby Labs\Lighting Lab\portable\<runId>.jsonl          audit: every HID report sent and
//                                                                         received, SDK errors, outcome
//   %LOCALAPPDATA%\jeby Labs\Lighting Lab\portable\<runId>-backup.json    AL65 lighting before the write
//   Nothing else on disk is touched. Typed keys are never logged.
// =====================================================================================================
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

/// <summary>
/// The four AL65 backlight values on VIA channel 3, each a firmware byte (0-255).
/// Public fields so JavaScriptSerializer can read/write them in manifests and backup files.
/// </summary>
internal sealed class LightingState {
    /// <summary>Value id 1. The exporter defaults to 204 (80%).</summary>
    public int brightness;
    /// <summary>Value id 2. Built-in effect index from the AL65 definition (e.g. 1 Solid Color, 7 Rainbow Moving Chevron, 15 Digital Rain).</summary>
    public int mode;
    /// <summary>Value id 3. Firmware animation speed.</summary>
    public int speed;
    /// <summary>Value id 4, first byte. Hue scaled to 0-255 (not degrees).</summary>
    public int hue;
    /// <summary>Value id 4, second byte. Saturation 0-255.</summary>
    public int saturation;
    /// <summary>Exact equality of all five values (used by self-tests).</summary>
    public bool Same(LightingState other) {
        return brightness == other.brightness && mode == other.mode && speed == other.speed && hue == other.hue && saturation == other.saturation;
    }
    /// <summary>Equality used after a write: exact for mode/speed/color, +/-2 tolerance for brightness quantization.</summary>
    public bool MatchesReadback(LightingState other) {
        // VIA normalizes firmware-limited brightness through two integer conversions; allow at most 2/255 quantization.
        return Math.Abs(brightness-other.brightness)<=2 && mode==other.mode && speed==other.speed && hue==other.hue && saturation==other.saturation;
    }
    /// <summary>Reject anything that is not a byte, and any mode index beyond the official AL65 list (0-20).</summary>
    public void Validate() {
        foreach (int value in new int[]{brightness, mode, speed, hue, saturation})
            if (value < 0 || value > 255) throw new InvalidDataException("A lighting value is outside the byte range.");
        if (mode > 20) throw new InvalidDataException("Mode is outside the official AL65 definition.");
    }
}
/// <summary>The schemaVersion 1 (AL65) manifest fields this runner reads; the rest of preset.json is informational.</summary>
internal sealed class PresetManifest {
    public int schemaVersion;
    public bool approximationAcknowledged;
    public Dictionary<string,object> target;
    public LightingState desired;
}
/// <summary>
/// On-disk rollback point written before any AL65 write. deviceFingerprint is a SHA-256 of the HID device
/// path, so a backup cannot be restored onto a different keyboard/USB interface by mistake.
/// </summary>
internal sealed class Backup {
    public int schemaVersion = 1;
    public string targetModel = "yunzii-al65";
    public string deviceFingerprint;
    public string capturedAt;
    public LightingState lighting;
}
/// <summary>
/// One VIA request/response exchange. Implemented by ViaHid (real USB) and MemoryVia (self-test fake),
/// so the transaction logic is tested without hardware. Returns the 32-byte reply payload.
/// </summary>
internal interface IVia : IDisposable {
    byte[] Exchange(byte command, byte value, params byte[] data);
}

/// <summary>Backup -> write -> verify -> save -> verify, with automatic rollback (see file header).</summary>
internal static class LightingTransaction {
    // Four documented fields are captured before any SET, so partial writes remain reversible.
    /// <summary>
    /// Read all four values with command 8 (get value). Reply layout: [8, 3, valueId, value, (saturation)].
    /// Color (value id 4) is read first so its two bytes come from one consistent reply.
    /// </summary>
    public static LightingState Read(IVia device) {
        byte[] color = device.Exchange(8,4);
        LightingState result = new LightingState {brightness=device.Exchange(8,1)[3],mode=device.Exchange(8,2)[3],
            speed=device.Exchange(8,3)[3],hue=color[3],saturation=color[4]};
        result.Validate();
        return result;
    }
    /// <summary>
    /// Write all four values with command 7 (set value). The MODE is written last, so the keyboard switches
    /// effect only once brightness, speed and color are already in place (no flash of the old colors).
    /// </summary>
    public static void Write(IVia device, LightingState state) {
        state.Validate();
        device.Exchange(7,1,(byte)state.brightness);
        device.Exchange(7,3,(byte)state.speed);
        device.Exchange(7,4,(byte)state.hue,(byte)state.saturation);
        device.Exchange(7,2,(byte)state.mode);
    }
    /// <summary>Read back and throw if the keyboard did not accept exactly what was written. No success is ever assumed.</summary>
    public static void Verify(IVia device, LightingState expected) {
        if (!Read(device).MatchesReadback(expected)) throw new IOException("Lighting readback did not match the requested mode/color/speed. No success is claimed.");
    }
    /// <summary>
    /// The whole safe-write transaction.
    /// </summary>
    /// <param name="persistBackup">Must durably save the original values; if it throws, nothing is written.</param>
    /// <param name="note">Progress/rollback messages for the console and audit log.</param>
    public static void Apply(IVia device, LightingState desired, Action<LightingState> persistBackup, Action<string> note) {
        desired.Validate();
        LightingState original = Read(device);
        persistBackup(original); // If this fails, the keyboard has not been changed.
        try {
            Write(device,desired);
            Verify(device,desired);   // Live values match before asking the firmware to persist them.
            device.Exchange(9,0);     // Command 9: save channel 3 to the keyboard's own memory.
            Verify(device,desired);   // Saving must not have altered anything.
        } catch (Exception error) {
            note("Apply failed: " + error.Message);
            // Roll back to the captured original and persist that, so a failed apply never leaves a half-written state.
            try {
                Write(device,original);
                Verify(device,original);
                device.Exchange(9,0);
                Verify(device,original);
                note("Original lighting restored and save acknowledged.");
            } catch (Exception rollbackError) {
                note("Automatic restore could not complete: " + rollbackError.Message + ". Keep the backup and retry --restore when USB is available.");
            }
            throw;
        }
    }
}

/// <summary>
/// Append-only JSON-lines log for one run, shared by the AL65 and Razer paths:
/// %LOCALAPPDATA%\jeby Labs\Lighting Lab\portable\{RunId}.jsonl. AutoFlush keeps evidence even on a crash.
/// </summary>
internal sealed class Audit : IDisposable {
    private readonly StreamWriter output;
    /// <summary>Folder holding audit logs and AL65 backups (printed to the console as "Diagnostics:").</summary>
    internal readonly string DirectoryPath;
    /// <summary>UTC timestamp + 8 random hex chars; names this run's audit and backup files.</summary>
    internal readonly string RunId;
    /// <summary>Create the folder and a NEW log file (CreateNew: two runs can never share or truncate a log).</summary>
    internal Audit() {
        DirectoryPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"jeby Labs","Lighting Lab","portable");
        Directory.CreateDirectory(DirectoryPath);
        RunId = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0,8);
        output = new StreamWriter(new FileStream(Path.Combine(DirectoryPath,RunId + ".jsonl"),FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false));
        output.AutoFlush = true;
    }
    /// <summary>Write one {"at","kind","detail"} line; `detail` is serialized as JSON.</summary>
    internal void Record(string kind, object detail) {
        output.WriteLine(new JavaScriptSerializer().Serialize(new {at=DateTime.UtcNow.ToString("o"),kind=kind,detail=detail}));
    }
    /// <summary>Close the log file.</summary>
    public void Dispose() { output.Dispose(); }
}

/// <summary>
/// Real USB transport to the AL65's VIA HID interface. One overlapped FileStream; every exchange is
/// audited before sending. After ANY error the stream is closed, so a late reply can never be mistaken for
/// the answer to a later command - the rest of the run then fails safe.
/// </summary>
internal sealed class ViaHid : IVia {
    private FileStream stream;
    private readonly Audit audit;
    /// <summary>SHA-256 of the lower-cased HID device path; ties backups to this exact interface.</summary>
    internal readonly string Fingerprint;
    /// <summary>VIA protocol version reported by the firmware (command 1); must be 11-13.</summary>
    internal readonly int Protocol;
    /// <summary>Wrap an opened handle, compute the fingerprint, and verify the protocol version before anything else.</summary>
    internal ViaHid(string path, SafeFileHandle handle, Audit auditLog) {
        audit = auditLog;
        stream = new FileStream(handle,FileAccess.ReadWrite,33,true);
        using (SHA256 sha = SHA256.Create()) Fingerprint = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(path.ToLowerInvariant()))).Replace("-","");
        byte[] version = Exchange(1,0);                 // Command 1: get protocol version (read-only).
        Protocol = (version[1] << 8) | version[2];      // Big-endian 16-bit version in payload bytes 1..2.
        try { ValidateProtocol(Protocol); } catch { Dispose(); throw; }
    }
    /// <summary>Only the reviewed VIA protocol versions (11-13) use channel 3 / value ids 1-4 as documented here.</summary>
    internal static void ValidateProtocol(int protocol) {
        // VIA 9/10 use older lighting value IDs. Channel 3 / values 1-4 belong to the reviewed v3 protocol family.
        if (protocol < 11 || protocol > 13) throw new IOException("VIA protocol " + protocol + " is outside the reviewed versions 11-13. No lighting was changed.");
    }
    /// <summary>
    /// Build a 33-byte HID output report, or throw if the request is outside the allowlist:
    /// commands 1/7/8/9 only; value ids 1-4 for get/set; exactly 1 data byte for set (2 for color);
    /// no data and value 0 for version/save. Layout: [0]=report ID 0, [1]=command, [2]=channel 3,
    /// [3]=value id, [4..]=data. Also used by MemoryVia so self-tests enforce the same allowlist.
    /// </summary>
    internal static byte[] MakeReport(byte command, byte value, params byte[] data) {
        // A closed command surface is more reliable than accepting arbitrary HID reports from JSON.
        if (command != 1 && command != 7 && command != 8 && command != 9) throw new InvalidOperationException("Command is not a lighting operation.");
        if ((command == 7 || command == 8) && (value < 1 || value > 4)) throw new InvalidOperationException("Unknown lighting value ID.");
        int expected = command == 7 ? (value == 4 ? 2 : 1) : 0;
        if (data.Length != expected || ((command == 1 || command == 9) && value != 0)) throw new InvalidOperationException("Invalid lighting command payload.");
        byte[] report = new byte[33];
        report[1] = command;
        if (command != 1) report[2] = 3;
        if (command == 7 || command == 8) report[3] = value;
        Buffer.BlockCopy(data,0,report,4,data.Length);
        return report;
    }
    /// <summary>
    /// Send one report and wait (max 1.8 s each way) for the reply. The reply must be 33 bytes, report ID 0,
    /// and echo the same command, channel 3 and value id; otherwise the session is closed and an error thrown.
    /// </summary>
    public byte[] Exchange(byte command, byte value, params byte[] data) {
        byte[] request = MakeReport(command,value,data);
        if (stream==null) throw new IOException("The USB session is closed after a communication failure. Reconnect in wired mode and use the saved backup to restore.");
        audit.Record("hid-command-before-send",new {report=BitConverter.ToString(request)});
        byte[] response = new byte[33];
        IAsyncResult reading = null;
        try {
            // Begin the bounded read first to catch fast VIA responses without a second writer racing us.
            reading = stream.BeginRead(response,0,response.Length,null,null);
            IAsyncResult writing = stream.BeginWrite(request,0,request.Length,null,null);
            using (writing.AsyncWaitHandle) {
                if (!writing.AsyncWaitHandle.WaitOne(1800)) throw new TimeoutException("The AL65 did not accept the HID write within 1.8 seconds.");
                stream.EndWrite(writing);
            }
            int count;
            using (reading.AsyncWaitHandle) {
                if (!reading.AsyncWaitHandle.WaitOne(1800)) throw new TimeoutException("The AL65 did not answer within 1.8 seconds. Close VIA and connect in wired mode.");
                count = stream.EndRead(reading);
            }
            if (count != 33 || response[0] != 0) throw new IOException("Unexpected AL65 report size or report ID.");
            byte[] payload = new byte[32];
            Buffer.BlockCopy(response,1,payload,0,32);
            if (payload[0] != command || (command != 1 && payload[1] != 3) || ((command == 7 || command == 8) && payload[2] != value))
                throw new IOException("VIA response did not match the lighting request. No further writes are allowed.");
            audit.Record("hid-response",new {report=BitConverter.ToString(response)});
            return payload;
        } catch {
            // Disposing cancels outstanding overlapped I/O and prevents a timed-out reply becoming a future command's result.
            Dispose();
            throw;
        }
    }
    /// <summary>Close the HID handle (cancels pending overlapped I/O). Idempotent.</summary>
    public void Dispose() { if (stream != null) { stream.Dispose(); stream = null; } }
}

/// <summary>
/// Present-device HID enumeration through SetupAPI (DIGCF_PRESENT | DIGCF_DEVICEINTERFACE = 0x12), so
/// unplugged devices remembered in the registry are never mistaken for connected ones.
/// </summary>
internal static class HidDiscovery {
    [StructLayout(LayoutKind.Sequential)] private struct InterfaceData { internal int cbSize; internal Guid guid; internal int flags; internal IntPtr reserved; }
    [StructLayout(LayoutKind.Sequential)] private struct Attributes { internal int Size; internal ushort VendorID; internal ushort ProductID; internal ushort VersionNumber; }
    [StructLayout(LayoutKind.Sequential)] private struct Caps {
        internal ushort Usage,UsagePage,InputReportByteLength,OutputReportByteLength,FeatureReportByteLength;
        [MarshalAs(UnmanagedType.ByValArray,SizeConst=17)] internal ushort[] Reserved;
        internal ushort NumberLinkCollectionNodes,NumberInputButtonCaps,NumberInputValueCaps,NumberInputDataIndices;
        internal ushort NumberOutputButtonCaps,NumberOutputValueCaps,NumberOutputDataIndices;
        internal ushort NumberFeatureButtonCaps,NumberFeatureValueCaps,NumberFeatureDataIndices;
    }
    [DllImport("hid.dll")] private static extern void HidD_GetHidGuid(out Guid guid);
    [DllImport("hid.dll")] [return:MarshalAs(UnmanagedType.U1)] private static extern bool HidD_GetAttributes(SafeFileHandle handle,ref Attributes attributes);
    [DllImport("hid.dll")] [return:MarshalAs(UnmanagedType.U1)] private static extern bool HidD_GetPreparsedData(SafeFileHandle handle,out IntPtr data);
    [DllImport("hid.dll")] [return:MarshalAs(UnmanagedType.U1)] private static extern bool HidD_FreePreparsedData(IntPtr data);
    [DllImport("hid.dll")] private static extern int HidP_GetCaps(IntPtr data,out Caps caps);
    [DllImport("setupapi.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr SetupDiGetClassDevs(ref Guid guid,IntPtr enumerator,IntPtr parent,uint flags);
    [DllImport("setupapi.dll",SetLastError=true)] private static extern bool SetupDiEnumDeviceInterfaces(IntPtr set,IntPtr info,ref Guid guid,uint index,ref InterfaceData data);
    [DllImport("setupapi.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set,ref InterfaceData data,IntPtr detail,uint size,out uint needed,IntPtr info);
    [DllImport("setupapi.dll",SetLastError=true)] private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);

    // Presence is queried from currently enumerated HID interfaces, never old registry entries.
    /// <summary>
    /// True if a present HID interface matches the vendor (and product, unless 0). With keyboard=true the
    /// interface must also be a generic-desktop keyboard collection (usage page 1, usage 6). Opened with
    /// zero access rights: this only queries attributes, it cannot send anything.
    /// Used by Main to pick the path: Razer (VID 0x1532, any keyboard) first, then AL65 (0x4D4B/0x3068).
    /// </summary>
    internal static bool HasDevice(ushort vendor,ushort product,bool keyboard) {
        Guid guid;HidD_GetHidGuid(out guid);IntPtr set=SetupDiGetClassDevs(ref guid,IntPtr.Zero,IntPtr.Zero,0x12);
        if(set==new IntPtr(-1))throw new IOException("Cannot enumerate present HID devices.");
        try{for(uint index=0;index<1024;index++){
            InterfaceData data=new InterfaceData{cbSize=Marshal.SizeOf(typeof(InterfaceData))};if(!SetupDiEnumDeviceInterfaces(set,IntPtr.Zero,ref guid,index,ref data))break;
            uint needed;SetupDiGetDeviceInterfaceDetail(set,ref data,IntPtr.Zero,0,out needed,IntPtr.Zero);if(needed<8||needed>65536)continue;
            IntPtr detail=Marshal.AllocHGlobal((int)needed);try{
                Marshal.WriteInt32(detail,IntPtr.Size==8?8:6);if(!SetupDiGetDeviceInterfaceDetail(set,ref data,detail,needed,out needed,IntPtr.Zero))continue;
                string devicePath=Marshal.PtrToStringUni(IntPtr.Add(detail,4));using(SafeFileHandle handle=CreateFile(devicePath,0,3,IntPtr.Zero,3,0,IntPtr.Zero)){
                    if(handle.IsInvalid)continue;Attributes a=new Attributes{Size=Marshal.SizeOf(typeof(Attributes))};if(!HidD_GetAttributes(handle,ref a)||a.VendorID!=vendor||(product!=0&&a.ProductID!=product))continue;
                    if(!keyboard)return true;IntPtr parsed;if(!HidD_GetPreparsedData(handle,out parsed))continue;try{Caps caps;if(HidP_GetCaps(parsed,out caps)==0x00110000&&caps.UsagePage==1&&caps.Usage==6)return true;}finally{HidD_FreePreparsedData(parsed);}
                }
            }finally{Marshal.FreeHGlobal(detail);}
        }}finally{SetupDiDestroyDeviceInfoList(set);}return false;
    }

    // VID/PID come from YUNZII's definition; usage and report lengths identify only its VIA collection.
    /// <summary>
    /// Find exactly one AL65 VIA interface (path contains vid_4d4b&pid_3068, attributes match, usage page
    /// 0xFF60 / usage 0x61, 33-byte input and output reports), then open it read/write + overlapped
    /// (0x40000000 = FILE_FLAG_OVERLAPPED). Zero matches or two AL65s both stop before any write.
    /// Win32 error 259 (ERROR_NO_MORE_ITEMS) is the normal end of enumeration.
    /// </summary>
    internal static ViaHid Open(Audit audit) {
        Guid guid; HidD_GetHidGuid(out guid);
        IntPtr set = SetupDiGetClassDevs(ref guid,IntPtr.Zero,IntPtr.Zero,0x12);
        if (set == new IntPtr(-1)) throw new IOException("Windows HID enumeration failed.");
        List<string> matches = new List<string>();
        try {
            for (uint index=0; index<1024; index++) {
                InterfaceData data = new InterfaceData {cbSize=Marshal.SizeOf(typeof(InterfaceData))};
                if (!SetupDiEnumDeviceInterfaces(set,IntPtr.Zero,ref guid,index,ref data)) {
                    if (Marshal.GetLastWin32Error() != 259) throw new IOException("Windows HID enumeration ended unexpectedly.");
                    break;
                }
                uint needed;
                SetupDiGetDeviceInterfaceDetail(set,ref data,IntPtr.Zero,0,out needed,IntPtr.Zero);
                if (needed < 8 || needed > 65536) continue;
                IntPtr detail = Marshal.AllocHGlobal((int)needed);
                try {
                    Marshal.WriteInt32(detail,IntPtr.Size == 8 ? 8 : 6);
                    if (!SetupDiGetDeviceInterfaceDetail(set,ref data,detail,needed,out needed,IntPtr.Zero)) continue;
                    string path = Marshal.PtrToStringUni(IntPtr.Add(detail,4));
                    if (path == null || path.IndexOf("vid_4d4b&pid_3068",StringComparison.OrdinalIgnoreCase)<0) continue;
                    using (SafeFileHandle handle = CreateFile(path,0,3,IntPtr.Zero,3,0,IntPtr.Zero)) {
                        if (handle.IsInvalid) continue;
                        Attributes attributes = new Attributes {Size=Marshal.SizeOf(typeof(Attributes))};
                        if (!HidD_GetAttributes(handle,ref attributes) || attributes.VendorID != 0x4D4B || attributes.ProductID != 0x3068) continue;
                        IntPtr parsed;
                        if (!HidD_GetPreparsedData(handle,out parsed)) continue;
                        try {
                            Caps caps;
                            if (HidP_GetCaps(parsed,out caps) == 0x00110000 && caps.UsagePage == 0xFF60 && caps.Usage == 0x61 && caps.InputReportByteLength == 33 && caps.OutputReportByteLength == 33) matches.Add(path);
                        } finally { HidD_FreePreparsedData(parsed); }
                    }
                } finally { Marshal.FreeHGlobal(detail); }
            }
        } finally { SetupDiDestroyDeviceInfoList(set); }
        if (matches.Count == 0) throw new IOException("No AL65 VIA interface found (VID 4D4B / PID 3068). Plug in the AL65 by USB, select wired mode, and close VIA. No keyboard was changed.");
        if (matches.Count != 1) throw new IOException("More than one matching AL65 was found. Disconnect the extra AL65 before applying.");
        SafeFileHandle opened = CreateFile(matches[0],0xC0000000,3,IntPtr.Zero,3,0x40000000,IntPtr.Zero);
        if (opened.IsInvalid) { opened.Dispose(); throw new IOException("The AL65 was found but Windows denied access. Close VIA or another controller and retry."); }
        return new ViaHid(matches[0],opened,audit);
    }
}

/// <summary>
/// In-memory fake keyboard for --self-test. Applies the same MakeReport allowlist, and can inject an
/// interrupted write (failOnce, on the 2nd SET) or a corrupt readback (corruptReadOnce) to prove rollback.
/// </summary>
internal sealed class MemoryVia : IVia {
    internal LightingState state = new LightingState {brightness=100,mode=1,speed=120,hue=10,saturation=200};
    internal int writes;
    internal int saves;
    internal bool failOnce;
    internal bool corruptReadOnce;
    /// <summary>Simulate one VIA exchange against `state`, echoing the request header like real firmware.</summary>
    public byte[] Exchange(byte command, byte value, params byte[] data) {
        ViaHid.MakeReport(command,value,data);
        byte[] result = new byte[32]; result[0]=command; result[1]=3; result[2]=value;
        if (command == 7) {
            writes++;
            if (failOnce && writes == 2) { failOnce=false; throw new IOException("Simulated interrupted write"); }
            if (value==1) state.brightness=data[0];
            if (value==2) state.mode=data[0];
            if (value==3) state.speed=data[0];
            if (value==4) {state.hue=data[0];state.saturation=data[1];}
        }
        if (command==8) {
            result[3]=(byte)(value==1?state.brightness:value==2?state.mode:value==3?state.speed:state.hue);
            if (value==4) result[4]=(byte)state.saturation;
            if (corruptReadOnce && writes==4 && value==1) {corruptReadOnce=false;result[3]=0;}
        }
        if (command==9) saves++;
        return result;
    }
    /// <summary>Nothing to release.</summary>
    public void Dispose() {}
}

/// <summary>Executable entry point: dispatches flags and chooses the Razer or AL65 path (see file header).</summary>
internal static class Program {
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer {MaxJsonLength=8*1024*1024};
    /// <summary>The embedded preset.json text (replaced by manifest.al65 when an Auto export falls through to AL65).</summary>
    private static string manifestJson;
    private static void Assert(bool condition,string message) {if (!condition) throw new InvalidOperationException(message);}
    /// <summary>
    /// AL65 protocol/transaction self-test, added on top of ChromaPreset.SelfTest's count:
    /// every non-lighting command byte is rejected; unreviewed protocol versions are rejected; packet offsets;
    /// happy-path apply saves once and backs up before writing; interrupted write and corrupt readback both
    /// restore the original; brightness tolerance boundary; a failed backup prevents ALL writes.
    /// </summary>
    private static int SelfTest(int portableChecks) {
        int assertions=portableChecks;
        for (int candidate=0;candidate<=255;candidate++) {
            if (candidate==1 || candidate==7 || candidate==8 || candidate==9) continue;
            bool rejected=false;
            try {ViaHid.MakeReport((byte)candidate,0);} catch (InvalidOperationException) {rejected=true;}
            Assert(rejected,"Non-lighting command was accepted"); assertions++;
        }
        foreach (int protocol in new int[]{9,10,14}) {
            bool rejected=false;
            try {ViaHid.ValidateProtocol(protocol);} catch (IOException) {rejected=true;}
            Assert(rejected,"An unreviewed VIA lighting protocol was accepted");assertions++;
        }
        foreach (int protocol in new int[]{11,12,13}) {ViaHid.ValidateProtocol(protocol);assertions++;}
        byte[] request=ViaHid.MakeReport(7,4,85,255);
        Assert(request.Length==33 && request[0]==0 && request[1]==7 && request[2]==3 && request[3]==4 && request[4]==85 && request[5]==255,"VIA packet offset regression"); assertions++;
        MemoryVia device=new MemoryVia();
        LightingState desired=new LightingState {brightness=204,mode=15,speed=255,hue=85,saturation=255};
        bool backup=false;
        LightingTransaction.Apply(device,desired,delegate(LightingState old) {Assert(device.writes==0,"Write happened before backup");backup=true;},delegate(string message) {});
        Assert(backup && device.state.Same(desired) && device.saves==1,"Apply/readback/save failed"); assertions++;
        device=new MemoryVia(); device.failOnce=true;
        LightingState original=LightingTransaction.Read(device);
        bool failed=false;
        try {LightingTransaction.Apply(device,desired,delegate(LightingState old) {},delegate(string message) {});} catch (IOException) {failed=true;}
        Assert(failed && device.state.Same(original) && device.saves==1,"Interrupted write was not restored"); assertions++;
        device=new MemoryVia();device.corruptReadOnce=true;
        original=LightingTransaction.Read(device);failed=false;
        try {LightingTransaction.Apply(device,desired,delegate(LightingState old) {},delegate(string message) {});} catch (IOException) {failed=true;}
        Assert(failed && device.state.Same(original) && device.saves==1,"Readback mismatch was silently saved or was not restored");assertions++;
        LightingState quantized=new LightingState {brightness=desired.brightness-2,mode=desired.mode,speed=desired.speed,hue=desired.hue,saturation=desired.saturation};
        Assert(quantized.MatchesReadback(desired),"Normal VIA brightness quantization was rejected");assertions++;
        quantized.brightness--;
        Assert(!quantized.MatchesReadback(desired),"Out-of-bound brightness readback was accepted");assertions++;
        device=new MemoryVia();
        try {LightingTransaction.Apply(device,desired,delegate(LightingState old) {throw new IOException("Backup denied");},delegate(string message) {});} catch (IOException) {}
        Assert(device.writes==0,"Backup failure permitted lighting changes"); assertions++;
        Console.WriteLine(Json.Serialize(new {passed=assertions,realHidWrites=0}));
        return 0;
    }
    /// <summary>A v1 manifest must be acknowledged and target exactly the reviewed AL65 identity.</summary>
    private static void ValidateManifest(PresetManifest manifest) {
        Assert(manifest.schemaVersion==1 && manifest.approximationAcknowledged,"Unsupported or unacknowledged preset manifest.");
        Assert(manifest.target != null && Convert.ToString(manifest.target["model"])=="yunzii-al65" && Convert.ToInt32(manifest.target["vendorId"])==0x4D4B && Convert.ToInt32(manifest.target["productId"])==0x3068,"This runner only supports the reviewed AL65 target.");
        manifest.desired.Validate();
    }
    /// <summary>
    /// Entry point. Exit code 0 on success, 1 on any error (message on stderr). When double-clicked (no
    /// arguments, interactive console) it waits for Enter before closing so the result stays readable.
    /// </summary>
    public static int Main(string[] args) {
        bool quiet=args.Length>0;   // Any flag means scripted use: skip the final "Press Enter" pause.
        try {
            using (Stream resource=Assembly.GetExecutingAssembly().GetManifestResourceStream("preset.json"))
            using (StreamReader reader=new StreamReader(resource)) manifestJson=reader.ReadToEnd();
            if (args.Length==1 && args[0]=="--inspect") {Console.WriteLine(manifestJson);return 0;}
            if (args.Length==1 && args[0]=="--self-test") return SelfTest(ChromaPreset.SelfTest(manifestJson));
            if(args.Length==1&&args[0]=="--help"){
                Console.WriteLine("Lighting Lab single-preset player. Run without arguments to apply.\nRazer requires installed Chroma and stays active while this window is open. --with-feedback enables memory-only reactions.\nAL65 uses only its acknowledged built-in firmware approximation.\n--inspect: embedded setup, no device access. --self-test: in-memory checks, no device access.\n--probe: read-only device discovery (AL65 also queries lighting). --restore <backup.json>: AL65 only.");return 0;
            }
            // Schema 2 (Auto): prefer a present Razer keyboard; otherwise fall through to an embedded AL65 approximation.
            Dictionary<string,object> portableRoot=Json.Deserialize<Dictionary<string,object>>(manifestJson);
            if(Convert.ToInt32(portableRoot["schemaVersion"])==2){
                // --restore only ever means "restore an AL65 firmware backup", so it skips the Razer branch even on
                // a PC that also has a Razer keyboard (previously it fell into ChromaPreset.Run and failed with a
                // misleading "--with-feedback" message).
                bool al65Restore=args.Length>0&&args[0]=="--restore";
                if(!al65Restore&&ChromaPreset.HasVendor(0x1532,0,true)){
                    if(args.Length==1&&args[0]=="--probe"){Console.WriteLine(Json.Serialize(new {detected="razer",controller="Chroma runtime required",rgbWrites=0,physicalLightingVerified=false}));return 0;}
                    return ChromaPreset.Run(manifestJson,args);
                }
                if(!ChromaPreset.HasVendor(0x4D4B,0x3068,false))throw new IOException("No supported keyboard detected. This preset supports Razer keyboards through Chroma, and the wired YUNZII AL65 when a firmware approximation was included. Other brands need a supported controller; no lights were changed.");
                if(!portableRoot.ContainsKey("al65"))throw new IOException("AL65 detected, but this preset has no acknowledged AL65 built-in equivalent. Export an AL65 firmware preset instead. No lights were changed.");
                manifestJson=Json.Serialize(portableRoot["al65"]);
            }
            if (args.Length>0 && args[0]=="--help") {
                Console.WriteLine("Lighting Lab AL65 built-in preset. Run without arguments to apply and save.\n--inspect: embedded setup, no HID access.\n--probe: read-only device lighting query.\n--restore <backup.json>: restore that device's lighting backup.\n--self-test: in-memory protocol/rollback checks, no HID access.");
                return 0;
            }
            // ---- From here on: schema 1, YUNZII AL65 built-in firmware preset ----
            bool restore=args.Length==2 && args[0]=="--restore";
            bool probe=args.Length==1 && args[0]=="--probe";
            if (args.Length>0 && !restore && !probe) throw new ArgumentException("Unknown option. Use --help.");
            PresetManifest manifest=Json.Deserialize<PresetManifest>(manifestJson);
            ValidateManifest(manifest);
            using (Audit audit=new Audit()) {
                audit.Record("run-before-device-access",new {operation=restore?"restore":probe?"probe":"apply",manifest=Json.DeserializeObject(manifestJson)});
                Console.WriteLine("Lighting Lab: YUNZII AL65 built-in preset (USB wired mode).\nThe built-in mode covers the whole keyboard; selected keys and layered reactions are not copied.");
                Console.WriteLine("Diagnostics: " + audit.DirectoryPath);
                try {
                    using (ViaHid device=HidDiscovery.Open(audit)) {
                        audit.Record("device-ready",new {fingerprint=device.Fingerprint,protocol=device.Protocol});
                        if (probe) {Console.WriteLine(Json.Serialize(LightingTransaction.Read(device)));return 0;}
                        LightingState desired=manifest.desired;
                        if (restore) {
                            // A restore is just an apply whose desired state comes from a matching backup file.
                            if (new FileInfo(args[1]).Length>65536) throw new IOException("Backup exceeds the size limit.");
                            Backup saved=Json.Deserialize<Backup>(File.ReadAllText(args[1]));
                            if (saved.schemaVersion!=1 || saved.targetModel!="yunzii-al65" || saved.deviceFingerprint!=device.Fingerprint) throw new IOException("Backup identity does not match this AL65 USB interface. No lighting was changed.");
                            desired=saved.lighting; desired.Validate();
                        }
                        string backupPath=Path.Combine(audit.DirectoryPath,audit.RunId + "-backup.json");
                        LightingTransaction.Apply(device,desired,delegate(LightingState original) {
                            string serialized=Json.Serialize(new Backup {deviceFingerprint=device.Fingerprint,capturedAt=DateTime.UtcNow.ToString("o"),lighting=original});
                            // CreateNew prevents a repeat apply or restore from destroying an earlier rollback point.
                            using (StreamWriter output=new StreamWriter(new FileStream(backupPath,FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false))) output.Write(serialized);
                            audit.Record("backup-before-write",new {path=backupPath,lighting=original});
                            Console.WriteLine("Backup: " + backupPath);
                        },delegate(string message) {audit.Record("transaction-note",message);Console.WriteLine(message);});
                        audit.Record("apply-success",new {lighting=desired,saveAcknowledged=true,powerCycleVerified=false});
                        Console.WriteLine("Applied, read back, and save acknowledged. You may close this runner.\nAfter a USB power cycle, verify the AL65 kept the mode (not yet hardware-validated).\nUndo command:\n\"" + Assembly.GetExecutingAssembly().Location + "\" --restore \"" + backupPath + "\"");
                    }
                } catch (Exception error) {audit.Record("run-failed",new {error=error.Message});throw;}
            }
            return 0;
        } catch (Exception error) {Console.Error.WriteLine("Lighting Lab stopped: " + error.Message);return 1;}
        finally {
            if (!quiet && !Console.IsInputRedirected) {Console.WriteLine("Press Enter to close.");Console.ReadLine();}
        }
    }
}
