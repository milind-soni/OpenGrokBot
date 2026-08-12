# Windows input recorder (macro capture). Emits one NDJSON line per input
# event on stdout with a relative timestamp so the replay helper can
# reproduce timing. Spawned by electron/main.mjs; killed to stop.
# Protocol:
#   {"t":123,"type":"move","x":42,"y":100}              mouse moved
#   {"t":123,"type":"down","button":"left"}              button press
#   {"t":124,"type":"up","button":"left"}                button release
#   {"t":200,"type":"key","vk":65,"ext":false,"down":true}   key down/up
#   {"t":300,"type":"wheel","delta":120}                 mouse wheel
#   {"error":"..."}                                      fatal, exit 1
$ErrorActionPreference = "Stop"

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using System.Diagnostics;

public static class MacroHook
{
    public delegate IntPtr LowLevelHookProc(int nCode, IntPtr wParam, IntPtr lParam);

    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
    private const int WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208;
    private const int WM_MOUSEWHEEL = 0x020A;

    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelHookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string lpModuleName);
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int pt_x; public int pt_y; }

    private static LowLevelHookProc _kbProc, _mouseProc;
    private static IntPtr _kbHook, _mouseHook;
    private static Stopwatch _clock;

    public static ConcurrentQueue<string> Events = new ConcurrentQueue<string>();
    public static int LastError;

    private static string Button(uint message) {
        if (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP) return "left";
        if (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP) return "right";
        if (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP) return "middle";
        return "unknown";
    }
    private static bool IsDown(uint message) {
        return message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN;
    }

    private static IntPtr KeyboardHook(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            uint msg = (uint)wParam;
            if (msg == WM_KEYDOWN || msg == WM_KEYUP || msg == WM_SYSKEYDOWN || msg == WM_SYSKEYUP) {
                KBDLLHOOKSTRUCT kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                bool down = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
                bool ext = (kb.flags & 0x1) != 0;
                Events.Enqueue(string.Format("{{\"t\":{0},\"type\":\"key\",\"vk\":{1},\"ext\":{2},\"down\":{3}}}",
                    _clock.ElapsedMilliseconds, kb.vkCode, ext ? "true" : "false", down ? "true" : "false"));
            }
        }
        return CallNextHookEx(_kbHook, nCode, wParam, lParam);
    }

    private static IntPtr MouseHook(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            uint msg = (uint)wParam;
            MSLLHOOKSTRUCT ms = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if (msg == WM_MOUSEMOVE) {
                Events.Enqueue(string.Format("{{\"t\":{0},\"type\":\"move\",\"x\":{1},\"y\":{2}}}",
                    _clock.ElapsedMilliseconds, ms.pt.x, ms.pt.y));
            } else if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP || msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP || msg == WM_MBUTTONDOWN || msg == WM_MBUTTONUP) {
                Events.Enqueue(string.Format("{{\"t\":{0},\"type\":\"{1}\",\"button\":\"{2}\"}}",
                    _clock.ElapsedMilliseconds, IsDown(msg) ? "down" : "up", Button(msg)));
            } else if (msg == WM_MOUSEWHEEL) {
                int delta = (short)((ms.mouseData >> 16) & 0xFFFF);
                Events.Enqueue(string.Format("{{\"t\":{0},\"type\":\"wheel\",\"delta\":{1}}}",
                    _clock.ElapsedMilliseconds, delta));
            }
        }
        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    public static bool Start() {
        _clock = Stopwatch.StartNew();
        _kbProc = KeyboardHook;
        _mouseProc = MouseHook;
        IntPtr mod = GetModuleHandle(null);
        _kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, _kbProc, mod, 0);
        _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, mod, 0);
        if (_kbHook == IntPtr.Zero || _mouseHook == IntPtr.Zero) {
            LastError = Marshal.GetLastWin32Error();
            return false;
        }
        // The pump MUST live on a dedicated thread: low-level hooks only
        // deliver while a message loop runs on the thread that installed
        // them. PowerShell's main thread then drains the event queue.
        System.Threading.Thread t = new System.Threading.Thread(new System.Threading.ThreadStart(Pump));
        t.IsBackground = true;
        t.Start();
        return true;
    }

    private static void Pump() {
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0)) { }
    }
}
'@

Add-Type -TypeDefinition $src -Language CSharp

if (-not [MacroHook]::Start()) {
  $err = [System.ComponentModel.Win32Exception][MacroHook]::LastError
  $msg = ("could not install input hook: " + $err.Message) -replace '"', "'"
  [Console]::Out.WriteLine(('{"error":"' + $msg + '"}'))
  [Console]::Out.Flush()
  exit 1
}

# Drain captured events to stdout until killed. Also emits a tiny periodic
# progress line so a reader can tell we're alive without injecting input.
while ($true) {
  $line = $null
  while ([MacroHook]::Events.TryDequeue([ref]$line)) {
    [Console]::Out.WriteLine($line)
  }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 20
}
