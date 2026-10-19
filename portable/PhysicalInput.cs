// Opt-in, memory-only physical key identities. Never suppress input or assemble typed text.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
internal static class PhysicalInput {
    private delegate IntPtr HookProc(int code,IntPtr message,IntPtr data);
    private static readonly HookProc Callback=OnKey;
    private static IntPtr hook;
    private static Action<string> sink;
    private static Dictionary<int,string> names;
    private static readonly HashSet<int> down=new HashSet<int>();
    [StructLayout(LayoutKind.Sequential)] private struct KeyData {internal uint vk,scan,flags,time;internal UIntPtr extra;}
    [StructLayout(LayoutKind.Sequential)] private struct Message {internal IntPtr window;internal uint message;internal UIntPtr wParam;internal IntPtr lParam;internal uint time;internal int x,y;internal uint privateValue;}
    [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int kind,HookProc callback,IntPtr module,uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr value,int code,IntPtr message,IntPtr data);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message,IntPtr window,uint min,uint max,uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("kernel32.dll",CharSet=CharSet.Auto)] private static extern IntPtr GetModuleHandle(string module);
    internal static string Identity(int vk,int scan,bool extended,Dictionary<int,string> map){
        if(!extended){int[] scans={0x52,0x4f,0x50,0x51,0x4b,0x4c,0x4d,0x47,0x48,0x49};for(int i=0;i<scans.Length;i++)if(scan==scans[i])return "NUM_"+i;if(scan==0x53)return "NUM_DECIMAL";}
        if(vk==13)return extended?"NUM_ENTER":"ENTER";
        if(vk==16)return scan==0x36?"RSHIFT":"LSHIFT";
        if(vk==17)return extended?"RCTRL":"LCTRL";
        if(vk==18)return extended?"RALT":"LALT";
        string id;return map.TryGetValue(vk,out id)?id:null;
    }
    private static IntPtr OnKey(int code,IntPtr message,IntPtr data){
        if(code>=0){KeyData key=(KeyData)Marshal.PtrToStructure(data,typeof(KeyData));int identity=(int)key.scan+((key.flags&1)!=0?256:0),kind=message.ToInt32();
            if(kind==0x101||kind==0x105)down.Remove(identity);
            if((kind==0x100||kind==0x104)&&down.Add(identity)){string id=Identity((int)key.vk,(int)key.scan,(key.flags&1)!=0,names);if(id!=null)try{sink(id);}catch{/* A feedback sink cannot interrupt the owner's keyboard input. */}}
        }
        return CallNextHookEx(hook,code,message,data);
    }
    internal static void Start(Dictionary<int,string> map,Action<string> callback){names=map;sink=callback;hook=SetWindowsHookEx(13,Callback,GetModuleHandle(null),0);if(hook==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
    internal static void Pump(){Message message;while(PeekMessage(out message,IntPtr.Zero,0,0,1)){TranslateMessage(ref message);DispatchMessage(ref message);}}
    internal static void Stop(){if(hook!=IntPtr.Zero)UnhookWindowsHookEx(hook);hook=IntPtr.Zero;down.Clear();sink=null;}
}
