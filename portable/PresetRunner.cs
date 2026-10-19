// One-preset AL65 VIA lighting writer. Its protocol allowlist excludes keys, macros and firmware.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal sealed class LightingState {
    public int brightness;
    public int mode;
    public int speed;
    public int hue;
    public int saturation;
    public bool Same(LightingState other) {
        return brightness == other.brightness && mode == other.mode && speed == other.speed && hue == other.hue && saturation == other.saturation;
    }
    public bool MatchesReadback(LightingState other) {
        // VIA normalizes firmware-limited brightness through two integer conversions; allow at most 2/255 quantization.
        return Math.Abs(brightness-other.brightness)<=2 && mode==other.mode && speed==other.speed && hue==other.hue && saturation==other.saturation;
    }
    public void Validate() {
        foreach (int value in new int[]{brightness, mode, speed, hue, saturation})
            if (value < 0 || value > 255) throw new InvalidDataException("A lighting value is outside the byte range.");
        if (mode > 20) throw new InvalidDataException("Mode is outside the official AL65 definition.");
    }
}
internal sealed class PresetManifest {
    public int schemaVersion;
    public bool approximationAcknowledged;
    public Dictionary<string,object> target;
    public LightingState desired;
}
internal sealed class Backup {
    public int schemaVersion = 1;
    public string targetModel = "yunzii-al65";
    public string deviceFingerprint;
    public string capturedAt;
    public LightingState lighting;
}
internal interface IVia : IDisposable {
    byte[] Exchange(byte command, byte value, params byte[] data);
}

internal static class LightingTransaction {
    // Four documented fields are captured before any SET, so partial writes remain reversible.
    public static LightingState Read(IVia device) {
        byte[] color = device.Exchange(8,4);
        LightingState result = new LightingState {brightness=device.Exchange(8,1)[3],mode=device.Exchange(8,2)[3],
            speed=device.Exchange(8,3)[3],hue=color[3],saturation=color[4]};
        result.Validate();
        return result;
    }
    public static void Write(IVia device, LightingState state) {
        state.Validate();
        device.Exchange(7,1,(byte)state.brightness);
        device.Exchange(7,3,(byte)state.speed);
        device.Exchange(7,4,(byte)state.hue,(byte)state.saturation);
        device.Exchange(7,2,(byte)state.mode);
    }
    public static void Verify(IVia device, LightingState expected) {
        if (!Read(device).MatchesReadback(expected)) throw new IOException("Lighting readback did not match the requested mode/color/speed. No success is claimed.");
    }
    public static void Apply(IVia device, LightingState desired, Action<LightingState> persistBackup, Action<string> note) {
        desired.Validate();
        LightingState original = Read(device);
        persistBackup(original); // If this fails, the keyboard has not been changed.
        try {
            Write(device,desired);
            Verify(device,desired);
            device.Exchange(9,0);
            Verify(device,desired);
        } catch (Exception error) {
            note("Apply failed: " + error.Message);
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

internal sealed class Audit : IDisposable {
    private readonly StreamWriter output;
    internal readonly string DirectoryPath;
    internal readonly string RunId;
    internal Audit() {
        DirectoryPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"jeby Labs","Lighting Lab","portable");
        Directory.CreateDirectory(DirectoryPath);
        RunId = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0,8);
        output = new StreamWriter(new FileStream(Path.Combine(DirectoryPath,RunId + ".jsonl"),FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false));
        output.AutoFlush = true;
    }
    internal void Record(string kind, object detail) {
        output.WriteLine(new JavaScriptSerializer().Serialize(new {at=DateTime.UtcNow.ToString("o"),kind=kind,detail=detail}));
    }
    public void Dispose() { output.Dispose(); }
}

internal sealed class ViaHid : IVia {
    private FileStream stream;
    private readonly Audit audit;
    internal readonly string Fingerprint;
    internal readonly int Protocol;
    internal ViaHid(string path, SafeFileHandle handle, Audit auditLog) {
        audit = auditLog;
        stream = new FileStream(handle,FileAccess.ReadWrite,33,true);
        using (SHA256 sha = SHA256.Create()) Fingerprint = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(path.ToLowerInvariant()))).Replace("-","");
        byte[] version = Exchange(1,0);
        Protocol = (version[1] << 8) | version[2];
        try { ValidateProtocol(Protocol); } catch { Dispose(); throw; }
    }
    internal static void ValidateProtocol(int protocol) {
        // VIA 9/10 use older lighting value IDs. Channel 3 / values 1-4 belong to the reviewed v3 protocol family.
        if (protocol < 11 || protocol > 13) throw new IOException("VIA protocol " + protocol + " is outside the reviewed versions 11-13. No lighting was changed.");
    }
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
    public void Dispose() { if (stream != null) { stream.Dispose(); stream = null; } }
}

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

internal sealed class MemoryVia : IVia {
    internal LightingState state = new LightingState {brightness=100,mode=1,speed=120,hue=10,saturation=200};
    internal int writes;
    internal int saves;
    internal bool failOnce;
    internal bool corruptReadOnce;
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
    public void Dispose() {}
}

internal static class Program {
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer {MaxJsonLength=8*1024*1024};
    private static string manifestJson;
    private static void Assert(bool condition,string message) {if (!condition) throw new InvalidOperationException(message);}
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
    private static void ValidateManifest(PresetManifest manifest) {
        Assert(manifest.schemaVersion==1 && manifest.approximationAcknowledged,"Unsupported or unacknowledged preset manifest.");
        Assert(manifest.target != null && Convert.ToString(manifest.target["model"])=="yunzii-al65" && Convert.ToInt32(manifest.target["vendorId"])==0x4D4B && Convert.ToInt32(manifest.target["productId"])==0x3068,"This runner only supports the reviewed AL65 target.");
        manifest.desired.Validate();
    }
    public static int Main(string[] args) {
        bool quiet=args.Length>0;
        try {
            using (Stream resource=Assembly.GetExecutingAssembly().GetManifestResourceStream("preset.json"))
            using (StreamReader reader=new StreamReader(resource)) manifestJson=reader.ReadToEnd();
            if (args.Length==1 && args[0]=="--inspect") {Console.WriteLine(manifestJson);return 0;}
            if (args.Length==1 && args[0]=="--self-test") return SelfTest(ChromaPreset.SelfTest(manifestJson));
            if(args.Length==1&&args[0]=="--help"){
                Console.WriteLine("Lighting Lab single-preset player. Run without arguments to apply.\nRazer requires installed Chroma and stays active while this window is open. --with-feedback enables memory-only reactions.\nAL65 uses only its acknowledged built-in firmware approximation.\n--inspect: embedded setup, no device access. --self-test: in-memory checks, no device access.\n--probe: read-only device discovery (AL65 also queries lighting). --restore <backup.json>: AL65 only.");return 0;
            }
            Dictionary<string,object> portableRoot=Json.Deserialize<Dictionary<string,object>>(manifestJson);
            if(Convert.ToInt32(portableRoot["schemaVersion"])==2){
                if(ChromaPreset.HasVendor(0x1532,0,true)){
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
