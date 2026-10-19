# Stream physical key-down IDs only while the explicitly enabled listener process is alive.
# Scan codes preserve numpad identity with NumLock off and distinguish its Enter from the main Enter.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class LightingLabKeyboard {
  private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
  private static readonly HookProc Callback = OnKey;
  private static readonly HashSet<int> Down = new HashSet<int>();
  private static IntPtr Hook;
  [StructLayout(LayoutKind.Sequential)] private struct KeyData { public uint vkCode, scanCode, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x,y; public uint privateValue; }
  [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int type, HookProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] private static extern IntPtr GetModuleHandle(string module);

  // Mapping reports switch identities rather than characters; no keyboard text is assembled or retained.
  private static string Id(KeyData key) {
    int vk=(int)key.vkCode, scan=(int)key.scanCode; bool extended=(key.flags & 1)!=0;
    if(!extended) {
      switch(scan) {
        case 0x47:return "NUM_7"; case 0x48:return "NUM_8"; case 0x49:return "NUM_9";
        case 0x4B:return "NUM_4"; case 0x4C:return "NUM_5"; case 0x4D:return "NUM_6";
        case 0x4F:return "NUM_1"; case 0x50:return "NUM_2"; case 0x51:return "NUM_3";
        case 0x52:return "NUM_0"; case 0x53:return "NUM_DECIMAL";
      }
    }
    if(vk>=0x30&&vk<=0x39)return ((char)vk).ToString();
    if(vk>=0x41&&vk<=0x5A)return ((char)vk).ToString();
    if(vk>=0x70&&vk<=0x7B)return "F"+(vk-0x6F);
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
      case 0xC0:return "`"; case 0xBD:return "-"; case 0xBB:return "="; case 0xDB:return "["; case 0xDD:return "]"; case 0xDC:return "\\";
      case 0xBA:return ";"; case 0xDE:return "'"; case 0xBC:return ","; case 0xBE:return "."; case 0xBF:return "/"; case 0xE2:return "ISO_BACKSLASH";
      default:return null;
    }
  }
  private static IntPtr OnKey(int code, IntPtr message, IntPtr data) {
    if(code>=0) {
      KeyData key=(KeyData)Marshal.PtrToStructure(data,typeof(KeyData));
      int identity=(int)key.scanCode+(((key.flags&1)!=0)?256:0),kind=message.ToInt32();
      if(kind==0x101||kind==0x105)Down.Remove(identity);
      if((kind==0x100||kind==0x104)&&Down.Add(identity)) {
        string id=Id(key);
        if(id!=null) {
          // Only a backslash switch needs JSON escaping; mapped IDs never contain quoted text.
          Console.WriteLine("{\"key\":\""+id.Replace("\\","\\\\")+"\"}"); Console.Out.Flush();
        }
      }
    }
    return CallNextHookEx(Hook,code,message,data);
  }
  public static void Run() {
    Hook=SetWindowsHookEx(13,Callback,GetModuleHandle(null),0);
    if(Hook==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try { Message message; while(GetMessage(out message,IntPtr.Zero,0,0)>0){} }
    finally { UnhookWindowsHookEx(Hook); }
  }
}
'@
[LightingLabKeyboard]::Run()
