# =====================================================================================================
# global-input.ps1 - opt-in "Global key feedback": lets the keyboard react to keys typed in ANY app.
#
# Who runs it
#   server.cjs enableInput() spawns it ONLY after the user ticks "Global key feedback" in the editor:
#       powershell.exe -NoProfile -ExecutionPolicy Bypass -File global-input.ps1
#   disableInput() (unticking, or server shutdown) kills the process. Nothing restarts it automatically,
#   so after a server restart global feedback is OFF until the user turns it on again.
#
# Output contract (stdout, one JSON object per line, flushed immediately)
#   {"key":"Q"}   {"key":"NUM_ENTER"}   {"key":"LSHIFT"}   {"key":"\\"}
#   Each value is a Lighting Lab PHYSICAL SWITCH ID (the same IDs as core.js chromaCoordinates), never a
#   character. server.cjs parses each line and calls sdk.keyPress(id) to draw the reaction.
#
# Privacy / safety rules
#   * Only key-DOWN switch identities are emitted. No text is assembled, no key history is kept, no window
#     titles are read, and nothing is written to disk (the server does not audit these lines either).
#   * Auto-repeat is ignored: a held key emits once (see the Down set below).
#   * The hook never blocks or changes input: every event is passed on with CallNextHookEx.
#   * If the hook cannot be installed, Run() throws and the process exits; the server notices the exit.
#
# Why scan codes matter
#   With Num Lock OFF, numpad keys send the SAME virtual-key codes as the navigation block (Numpad 7 ->
#   VK_HOME, Numpad . -> VK_DELETE). The hardware scan code plus the "extended" flag still tell them
#   apart: the dedicated Home key is extended (E0 prefix), numpad 7 is not. That is why numpad identity
#   is resolved from scan codes FIRST, before looking at the virtual-key code.
# =====================================================================================================
$ErrorActionPreference = 'Stop'

# Compile a small C# class into this PowerShell session. Low-level keyboard hooks need a native callback
# delegate and a message loop, which is much clearer in C# than in PowerShell script.
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class LightingLabKeyboard {
  // Signature Windows calls for every keyboard event (LowLevelKeyboardProc).
  private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
  // Kept in a static field so the garbage collector can never free the delegate while Windows holds it.
  private static readonly HookProc Callback = OnKey;
  // Physical keys currently held down (scan code + 256 if extended). Used to drop auto-repeat events.
  private static readonly HashSet<int> Down = new HashSet<int>();
  private static IntPtr Hook;
  // KBDLLHOOKSTRUCT: what Windows passes for each key event.
  [StructLayout(LayoutKind.Sequential)] private struct KeyData { public uint vkCode, scanCode, flags, time; public UIntPtr extra; }
  // MSG: only needed so GetMessage has somewhere to write; this thread never handles messages itself.
  [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x,y; public uint privateValue; }
  [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int type, HookProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] private static extern IntPtr GetModuleHandle(string module);

  // Mapping reports switch identities rather than characters; no keyboard text is assembled or retained.
  // Returns the Lighting Lab switch ID for one key event, or null for keys Lighting Lab does not draw.
  private static string Id(KeyData key) {
    // flags bit 0 = LLKHF_EXTENDED (the key arrived with an E0 prefix: right Ctrl/Alt, nav block, numpad Enter...).
    int vk=(int)key.vkCode, scan=(int)key.scanCode; bool extended=(key.flags & 1)!=0;
    // 1) Numpad digits and decimal by scan code (non-extended), regardless of Num Lock state.
    if(!extended) {
      switch(scan) {
        case 0x47:return "NUM_7"; case 0x48:return "NUM_8"; case 0x49:return "NUM_9";
        case 0x4B:return "NUM_4"; case 0x4C:return "NUM_5"; case 0x4D:return "NUM_6";
        case 0x4F:return "NUM_1"; case 0x50:return "NUM_2"; case 0x51:return "NUM_3";
        case 0x52:return "NUM_0"; case 0x53:return "NUM_DECIMAL";
      }
    }
    // 2) Contiguous virtual-key ranges: top-row digits 0-9, letters A-Z, F1-F12.
    if(vk>=0x30&&vk<=0x39)return ((char)vk).ToString();
    if(vk>=0x41&&vk<=0x5A)return ((char)vk).ToString();
    if(vk>=0x70&&vk<=0x7B)return "F"+(vk-0x6F);
    // 3) Everything else by virtual-key code. Generic Shift/Ctrl/Alt codes are split into left/right using
    //    the scan code (right Shift = 0x36) or the extended flag (right Ctrl/Alt). Enter + extended = numpad Enter.
    switch(vk) {
      case 0x1B:return "ESC"; case 0x08:return "BACKSPACE"; case 0x09:return "TAB"; case 0x14:return "CAPS";
      case 0x0D:return extended?"NUM_ENTER":"ENTER"; case 0x20:return "SPACE";
      case 0xA0:return "LSHIFT"; case 0xA1:return "RSHIFT"; case 0x10:return scan==0x36?"RSHIFT":"LSHIFT";
      case 0xA2:return "LCTRL"; case 0xA3:return "RCTRL"; case 0x11:return extended?"RCTRL":"LCTRL";
      case 0xA4:return "LALT"; case 0xA5:return "RALT"; case 0x12:return extended?"RALT":"LALT";
      case 0x5B:return "LWIN"; case 0x5C:return "RWIN"; case 0x5D:return "MENU";
      case 0x2C:return "PRINT"; case 0x91:return "SCROLL"; case 0x13:return "PAUSE";
      case 0x2D:return "INSERT"; case 0x2E:return "DEL"; case 0x24:return "HOME"; case 0x23:return "END";
      case 0x21:return "PGUP"; case 0x22:return "PGDN"; case 0x26:return "UP"; case 0x28:return "DOWN"; case 0x25:return "LEFT"; case 0x27:return "RIGHT";
      case 0x90:return "NUM_LOCK"; case 0x6F:return "NUM_DIVIDE"; case 0x6A:return "NUM_MULTIPLY"; case 0x6D:return "NUM_SUBTRACT"; case 0x6B:return "NUM_ADD"; case 0x6E:return "NUM_DECIMAL";
      // US-layout punctuation (OEM codes). 0xE2 is the extra ISO key between left Shift and Z.
      case 0xC0:return "`"; case 0xBD:return "-"; case 0xBB:return "="; case 0xDB:return "["; case 0xDD:return "]"; case 0xDC:return "\\";
      case 0xBA:return ";"; case 0xDE:return "'"; case 0xBC:return ","; case 0xBE:return "."; case 0xBF:return "/"; case 0xE2:return "ISO_BACKSLASH";
      default:return null;
    }
  }
  // Called by Windows for every key event system-wide while the hook is installed.
  private static IntPtr OnKey(int code, IntPtr message, IntPtr data) {
    // code < 0 means "do not process, just pass it on" (documented hook contract).
    if(code>=0) {
      KeyData key=(KeyData)Marshal.PtrToStructure(data,typeof(KeyData));
      int identity=(int)key.scanCode+(((key.flags&1)!=0)?256:0),kind=message.ToInt32();
      // 0x101 WM_KEYUP / 0x105 WM_SYSKEYUP: the key was released, so its next press counts again.
      if(kind==0x101||kind==0x105)Down.Remove(identity);
      // 0x100 WM_KEYDOWN / 0x104 WM_SYSKEYDOWN (Alt combos). Down.Add is false for auto-repeat, so held keys emit once.
      if((kind==0x100||kind==0x104)&&Down.Add(identity)) {
        string id=Id(key);
        if(id!=null) {
          // Only a backslash switch needs JSON escaping; mapped IDs never contain quoted text.
          Console.WriteLine("{\"key\":\""+id.Replace("\\","\\\\")+"\"}"); Console.Out.Flush();
        }
      }
    }
    // Always forward the event: Lighting Lab observes input, it never swallows or alters it.
    return CallNextHookEx(Hook,code,message,data);
  }
  public static void Run() {
    // 13 = WH_KEYBOARD_LL, a low-level keyboard hook. It runs in THIS process (no DLL injection into other
    // apps) and requires this thread to pump messages, which the GetMessage loop below does forever.
    Hook=SetWindowsHookEx(13,Callback,GetModuleHandle(null),0);
    if(Hook==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    // Blocks until the process is killed (normal shutdown path) or the queue is closed; then unhooks.
    try { Message message; while(GetMessage(out message,IntPtr.Zero,0,0)>0){} }
    finally { UnhookWindowsHookEx(Hook); }
  }
}
'@
# Never returns while the listener is enabled; server.cjs stops it by killing this process.
[LightingLabKeyboard]::Run()
