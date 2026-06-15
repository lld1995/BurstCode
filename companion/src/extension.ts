import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type AlertSoundKind = 'taskDone' | 'askUser';

interface StartAlertPayload {
  kind?: AlertSoundKind;
  intervalMs?: number;
  message?: string;
}

interface StopAlertPayload {
  kind?: AlertSoundKind;
}

interface NotifyPayload {
  message?: string;
}

interface AlertHandle {
  stop(): void;
}

const activeAlerts = new Map<AlertSoundKind, AlertHandle>();

function normalizeKind(value: unknown): AlertSoundKind {
  return value === 'askUser' ? 'askUser' : 'taskDone';
}

function playAlertSoundOnce(kind: AlertSoundKind): void {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      const command =
        kind === 'taskDone'
          ? '[console]::beep(880,160); Start-Sleep -Milliseconds 70; [console]::beep(1175,220)'
          : '[console]::beep(659,140); Start-Sleep -Milliseconds 90; [console]::beep(659,140)';
      cp.execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command
      ], { windowsHide: true }, () => undefined);
      return;
    }
    if (platform === 'darwin') {
      const sound = kind === 'taskDone' ? '/System/Library/Sounds/Glass.aiff' : '/System/Library/Sounds/Ping.aiff';
      cp.execFile('afplay', [sound], () => undefined);
      return;
    }
    const bellCount = kind === 'taskDone' ? 2 : 1;
    cp.execFile('sh', ['-c', `for i in $(seq 1 ${bellCount}); do printf "\\a"; sleep 0.12; done`], () => undefined);
  } catch {
    // Best effort only.
  }
}

function startRepeatingAlertSound(kind: AlertSoundKind, intervalMs: number): AlertHandle {
  const ms = Math.max(250, Number.isFinite(intervalMs) ? intervalMs : kind === 'taskDone' ? 800 : 1200);
  playAlertSoundOnce(kind);
  const timer = setInterval(() => playAlertSoundOnce(kind), ms);
  return { stop: () => clearInterval(timer) };
}

function flashWindowsTaskbarUntilForeground(): void {
  if (process.platform !== 'win32' || vscode.window.state.focused) return;

  try {
    const scriptPath = path.join(os.tmpdir(), 'burstcode-local-alert-flash-taskbar.ps1');
    const script = `
param([int]$TargetPid)
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class BurstCodeTaskbarFlash {
    [StructLayout(LayoutKind.Sequential)]
    public struct FLASHWINFO {
        public UInt32 cbSize;
        public IntPtr hwnd;
        public UInt32 dwFlags;
        public UInt32 uCount;
        public UInt32 dwTimeout;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    public const UInt32 FLASHW_TRAY = 0x00000002;
    public const UInt32 FLASHW_TIMERNOFG = 0x0000000C;

    public static bool Flash(IntPtr hwnd) {
        FLASHWINFO info = new FLASHWINFO();
        info.cbSize = Convert.ToUInt32(System.Runtime.InteropServices.Marshal.SizeOf(typeof(FLASHWINFO)));
        info.hwnd = hwnd;
        info.dwFlags = FLASHW_TRAY | FLASHW_TIMERNOFG;
        info.uCount = UInt32.MaxValue;
        info.dwTimeout = 0;
        return FlashWindowEx(ref info);
    }
}
"@

function Get-ParentPid([int]$Pid) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $Pid" -ErrorAction Stop
    if ($null -eq $p) { return 0 }
    return [int]$p.ParentProcessId
  } catch { return 0 }
}

$handles = New-Object 'System.Collections.Generic.List[IntPtr]'
$pidCursor = $TargetPid
for ($i = 0; $i -lt 16 -and $pidCursor -gt 0; $i++) {
  try {
    $proc = Get-Process -Id $pidCursor -ErrorAction Stop
    if ($proc.MainWindowHandle -ne 0) { $handles.Add([IntPtr]$proc.MainWindowHandle) }
  } catch {}
  $pidCursor = Get-ParentPid $pidCursor
}

if ($handles.Count -eq 0) {
  Get-Process Code, 'Code - Insiders', VSCodium -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    ForEach-Object { $handles.Add([IntPtr]$_.MainWindowHandle) }
}

foreach ($hwnd in $handles) { [void][BurstCodeTaskbarFlash]::Flash($hwnd) }
`;
    fs.writeFileSync(scriptPath, script, 'utf8');
    cp.execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-TargetPid',
      String(process.pid)
    ], { windowsHide: true }, () => {
      fs.rm(scriptPath, { force: true }, () => undefined);
    });
  } catch {
    // Best effort only.
  }
}

function notifyLocally(message: string): void {
  if (!vscode.window.state.focused) flashWindowsTaskbarUntilForeground();
  void vscode.window.showInformationMessage(message || 'BurstCode needs your attention.');
}

function stopAlert(kind: AlertSoundKind): void {
  const existing = activeAlerts.get(kind);
  if (!existing) return;
  existing.stop();
  activeAlerts.delete(kind);
}

function startAlert(payload: StartAlertPayload | undefined): void {
  const kind = normalizeKind(payload?.kind);
  stopAlert(kind);
  const intervalMs = Math.max(250, payload?.intervalMs ?? (kind === 'taskDone' ? 800 : 1200));
  activeAlerts.set(kind, startRepeatingAlertSound(kind, intervalMs));
  // Notification is sent separately through burstcode.alert.notify so the user only sees one popup.
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('burstcode.alert.start', (payload?: StartAlertPayload) => startAlert(payload)),
    vscode.commands.registerCommand('burstcode.alert.stop', (payload?: StopAlertPayload) => stopAlert(normalizeKind(payload?.kind))),
    vscode.commands.registerCommand('burstcode.alert.notify', (payload?: NotifyPayload) => notifyLocally(payload?.message || 'BurstCode needs your attention.')),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      for (const kind of Array.from(activeAlerts.keys())) stopAlert(kind);
    })
  );
}

export function deactivate(): void {
  for (const kind of Array.from(activeAlerts.keys())) stopAlert(kind);
}
