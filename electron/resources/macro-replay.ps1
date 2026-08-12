# Windows macro replay. Reads a JSON array of recorded actions (the format
# emitted by macro-record.ps1, plus each action carries the absolute ms
# offset `t`) and injects them via SendInput at the recorded speed. The
# actions file is passed as argv[1]. Exit 0 on success, 1 with {"error":...}
# on failure.
param([string]$File = "")

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit([hashtable]$obj) {
  $json = $obj | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

try {
  if (-not $File -or -not (Test-Path $File)) { throw "no actions file: $File" }
  $actions = Get-Content $File -Raw | ConvertFrom-Json
  if (-not $actions -or $actions.Count -eq 0) { throw "empty macro" }

  $src = @'
using System;
using System.Runtime.InteropServices;

public static class MacroReplay
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION U; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [DllImport("user32.dll")] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);

    public const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;
    public const int INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    public const int MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    public const int MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    public const int MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    public const int MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const int MOUSEEVENTF_WHEEL = 0x0800;
    public const int KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_SCANCODE = 0x0008;

    public static void Mouse(uint flags, int dx, int dy) {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.U.mi.dwFlags = flags;
        i.U.mi.dx = dx; i.U.mi.dy = dy;
        SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
    }
    public static void MoveAbs(int x, int y) {
        int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
        int dx = (int)((x * 65535.0) / (sw - 1));
        int dy = (int)((y * 65535.0) / (sh - 1));
        Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dx, dy);
    }
    public static void Wheel(int delta) {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.U.mi.dwFlags = MOUSEEVENTF_WHEEL;
        i.U.mi.mouseData = (uint)delta;
        SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
    }
    public static void Key(ushort vk, bool down, bool extended) {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk;
        i.U.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
        if (extended) i.U.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
        SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@
  Add-Type -TypeDefinition $src -Language CSharp

  $prevT = [double]($actions[0].t)
  $started = Get-Date
  foreach ($a in $actions) {
    # wait out the recorded delay (clamped to a sane ceiling)
    $now = (Get-Date) - $started
    $target = [double]($a.t)
    $gap = ($target - $prevT) / 1000.0
    if ($gap -gt 0) { Start-Sleep -Milliseconds ([math]::Min([math]::Max([int]($gap * 1000), 0), 30000)) }
    $prevT = $target

    switch ($a.type) {
      "move" { [MacroReplay]::MoveAbs([int]$a.x, [int]$a.y) }
      "down" {
        $m = @{ left = 2; right = 8; middle = 32 }
        [MacroReplay]::Mouse([uint32]$m[$a.button], 0, 0)
      }
      "up" {
        $m = @{ left = 4; right = 16; middle = 64 }
        [MacroReplay]::Mouse([uint32]$m[$a.button], 0, 0)
      }
      "wheel" { [MacroReplay]::Wheel([int]$a.delta) }
      "key" {
        [MacroReplay]::Key([uint16]$a.vk, [bool]$a.down, [bool]$a.ext)
        Start-Sleep -Milliseconds 10
      }
    }
  }
  Emit @{ ok = $true; events = $actions.Count }
  exit 0
} catch {
  Emit @{ error = $_.Exception.Message }
  exit 1
}
