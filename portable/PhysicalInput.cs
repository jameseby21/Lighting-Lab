// =====================================================================================================
// PhysicalInput.cs - opt-in, memory-only physical key identities for the portable preset player.
//
// Used by ChromaPreset.Run() only when the person running the exported .exe answers "Y" to
// "Enable keyboard reactions?" (or passes --with-feedback). It turns each key press into a Lighting Lab
// switch ID such as "Q", "NUM_7" or "NUM_ENTER" so the player can draw a reaction on that key.
//
// How:
//   * A Windows low-level keyboard hook (SetWindowsHookEx with WH_KEYBOARD_LL = 13) sees every key-down /
//     key-up system-wide, including while another app is focused.
//   * Low-level hooks are delivered through the INSTALLING thread's message queue, so the player must call
//     Pump() regularly (it does, once per frame). Without pumping, Windows times the hook out and keyboard
//     input elsewhere can lag.
//   * Identity comes from the hardware SCAN CODE first, the virtual-key code second. Scan codes keep the
//     numpad's identity regardless of Num Lock (with Num Lock off, numpad 7 sends VK_HOME, but its scan code
//     is still 0x47), and the "extended" flag separates numpad Enter from the main Enter.
//
// Privacy & safety guarantees:
//   * Input is NEVER suppressed: every event is passed on with CallNextHookEx, so typing works normally.
//   * Only a switch ID is handed to the callback; characters, modifiers-as-text, and timing history are
//     never assembled, stored, or logged.
//   * Auto-repeat is ignored (a held key reacts once) by tracking which physical keys are currently down.
// =====================================================================================================
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
/// <summary>Process-wide low-level keyboard hook that reports physical switch IDs to one callback.</summary>
internal static class PhysicalInput {
    /// <summary>Signature Windows calls for WH_KEYBOARD_LL (LowLevelKeyboardProc).</summary>
    private delegate IntPtr HookProc(int code,IntPtr message,IntPtr data);
    // Kept in a static field so the garbage collector cannot free the delegate while Windows still calls it.
    private static readonly HookProc Callback=OnKey;
    /// <summary>Handle returned by SetWindowsHookEx; IntPtr.Zero when no hook is installed.</summary>
    private static IntPtr hook;
    /// <summary>Receiver of switch IDs (set by Start, cleared by Stop).</summary>
    private static Action<string> sink;
    /// <summary>Virtual-key code -> switch ID map built from the exported key list (fallback after scan codes).</summary>
    private static Dictionary<int,string> names;
    /// <summary>Physical keys currently held (scan code + 256 if extended); used to drop auto-repeat.</summary>
    private static readonly HashSet<int> down=new HashSet<int>();
    // KBDLLHOOKSTRUCT: virtual-key code, hardware scan code, flags (bit 0 = extended key), timestamp, extra info.
    [StructLayout(LayoutKind.Sequential)] private struct KeyData {internal uint vk,scan,flags,time;internal UIntPtr extra;}
    // MSG: the Win32 message record used by PeekMessage/TranslateMessage/DispatchMessage.
    [StructLayout(LayoutKind.Sequential)] private struct Message {internal IntPtr window;internal uint message;internal UIntPtr wParam;internal IntPtr lParam;internal uint time;internal int x,y;internal uint privateValue;}
    // user32/kernel32 imports. Hook type 13 = WH_KEYBOARD_LL; thread 0 = all threads on this desktop.
    [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int kind,HookProc callback,IntPtr module,uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr value,int code,IntPtr message,IntPtr data);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message,IntPtr window,uint min,uint max,uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("kernel32.dll",CharSet=CharSet.Auto)] private static extern IntPtr GetModuleHandle(string module);
    /// <summary>
    /// Translate one key event into a Lighting Lab switch ID, or null if the key is not on the exported layout.
    /// Order matters:
    ///   1. Non-extended numpad scan codes (0x47-0x53) -> NUM_0..NUM_9 / NUM_DECIMAL, independent of Num Lock.
    ///      The array is indexed by digit: scans[0]=0x52 is numpad 0, scans[7]=0x47 is numpad 7, and so on.
    ///   2. Keys whose virtual-key code is shared by a left/right or main/numpad pair, split by scan code or
    ///      the extended flag: Enter (13), Shift (16, right shift has scan 0x36), Ctrl (17), Alt (18).
    ///   3. Everything else through the virtual-key map supplied by the exported preset.
    /// Also exercised by ChromaPreset.SelfTest() so `--self-test` catches regressions without a keyboard.
    /// </summary>
    internal static string Identity(int vk,int scan,bool extended,Dictionary<int,string> map){
        if(!extended){int[] scans={0x52,0x4f,0x50,0x51,0x4b,0x4c,0x4d,0x47,0x48,0x49};for(int i=0;i<scans.Length;i++)if(scan==scans[i])return "NUM_"+i;if(scan==0x53)return "NUM_DECIMAL";}
        if(vk==13)return extended?"NUM_ENTER":"ENTER";
        if(vk==16)return scan==0x36?"RSHIFT":"LSHIFT";
        if(vk==17)return extended?"RCTRL":"LCTRL";
        if(vk==18)return extended?"RALT":"LALT";
        string id;return map.TryGetValue(vk,out id)?id:null;
    }
    /// <summary>
    /// Hook callback. Message kinds: 0x100 WM_KEYDOWN, 0x104 WM_SYSKEYDOWN (Alt held), 0x101 WM_KEYUP,
    /// 0x105 WM_SYSKEYUP. A key reports only on its first down (down.Add returns false for auto-repeat).
    /// A negative `code` means "pass it on without looking", per the Win32 contract.
    /// </summary>
    private static IntPtr OnKey(int code,IntPtr message,IntPtr data){
        if(code>=0){KeyData key=(KeyData)Marshal.PtrToStructure(data,typeof(KeyData));int identity=(int)key.scan+((key.flags&1)!=0?256:0),kind=message.ToInt32();
            if(kind==0x101||kind==0x105)down.Remove(identity);
            if((kind==0x100||kind==0x104)&&down.Add(identity)){string id=Identity((int)key.vk,(int)key.scan,(key.flags&1)!=0,names);if(id!=null)try{sink(id);}catch{/* A feedback sink cannot interrupt the owner's keyboard input. */}}
        }
        // Always forward: Lighting Lab observes keys, it never blocks or alters them.
        return CallNextHookEx(hook,code,message,data);
    }
    /// <summary>Install the hook. Throws Win32Exception if Windows refuses (e.g. restricted desktop).</summary>
    internal static void Start(Dictionary<int,string> map,Action<string> callback){names=map;sink=callback;hook=SetWindowsHookEx(13,Callback,GetModuleHandle(null),0);if(hook==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
    /// <summary>Drain this thread's message queue (PM_REMOVE = 1) so hook callbacks are delivered promptly.</summary>
    internal static void Pump(){Message message;while(PeekMessage(out message,IntPtr.Zero,0,0,1)){TranslateMessage(ref message);DispatchMessage(ref message);}}
    /// <summary>Remove the hook and forget all state. Safe to call when Start was never called.</summary>
    internal static void Stop(){if(hook!=IntPtr.Zero)UnhookWindowsHookEx(hook);hook=IntPtr.Zero;down.Clear();sink=null;}
}
