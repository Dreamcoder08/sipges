# A console of its own for sipges-desktop.exe on Windows, for go-drill.mjs: a real Ctrl+C, the
# way a person stops it in a console window, so the drill can prove the clean stop (the API, then
# PostgreSQL). Node cannot send one (child.kill() ends a Windows process outright). The same steps
# as tables-interrupt.ps1, in Windows PowerShell 5.1:
#   1. takes a console of its own (FreeConsole, AllocConsole), so the Ctrl+C below reaches only
#      this helper and what it starts there: never the runner or the drill. The bundled
#      PostgreSQL has no console (sipges-desktop starts it with CREATE_NO_WINDOW);
#   2. turns Ctrl+C processing on, which the child inherits, and survives its own Ctrl+C;
#   3. starts GC_EXE with GC_ARGS_JSON in that console, stdout and stderr read apart;
#   4. once the file GC_STOP exists, sends CTRL_C_EVENT with GenerateConsoleCtrlEvent;
#   5. waits for the child to end and writes a JSON report to GC_REPORT.
# Input through the environment: GC_EXE, GC_ARGS_JSON (a JSON array), GC_STOP, GC_REPORT,
# GC_TIMEOUT_MS (how long to wait for GC_STOP, and then for the exit). Every other variable passes
# on to the child. Exit 0: the report was written (the drill judges it). Synthetic data only.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SipgesGoConsole {
  public delegate bool Handler(uint ctrlType);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AllocConsole();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint GetConsoleProcessList(uint[] list, uint count);
  // Kept in a static field so the collector never frees the delegate the console calls.
  static Handler swallow = delegate (uint ctrlType) { return true; };
  static void Check(bool ok, string what) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), what);
  }
  public static void OwnConsole() {
    FreeConsole();
    Check(AllocConsole(), "AllocConsole");
  }
  public static void ProcessCtrlC() {
    Check(SetConsoleCtrlHandler(null, false), "SetConsoleCtrlHandler(NULL, FALSE)");
    Check(SetConsoleCtrlHandler(swallow, true), "SetConsoleCtrlHandler(handler, TRUE)");
  }
  public static uint[] Attached() {
    uint[] list = new uint[64];
    uint n = GetConsoleProcessList(list, (uint)list.Length);
    if (n == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetConsoleProcessList");
    uint[] found = new uint[Math.Min(n, (uint)list.Length)];
    Array.Copy(list, found, found.Length);
    return found;
  }
  public static void SendCtrlC() {
    Check(GenerateConsoleCtrlEvent(0, 0), "GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)");
  }
}
'@

# One argument quoted for CreateProcess (the rules of CommandLineToArgvW).
function Quote-Argument([string] $value) {
  if ($value -and $value -notmatch '[\s"]') { return $value }
  $out = '"'
  $slashes = 0
  foreach ($ch in $value.ToCharArray()) {
    if ($ch -eq '\') { $slashes += 1; continue }
    if ($ch -eq '"') { $out += ('\' * (2 * $slashes + 1)) + '"' }
    else { $out += ('\' * $slashes) + $ch }
    $slashes = 0
  }
  return $out + ('\' * (2 * $slashes)) + '"'
}

foreach ($name in 'GC_EXE', 'GC_ARGS_JSON', 'GC_STOP', 'GC_REPORT', 'GC_TIMEOUT_MS') {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is not set" }
}
$timeout = [int] $env:GC_TIMEOUT_MS
$report = [ordered] @{
  helperPid = $PID; childPid = $null; sent = $false; exitCode = $null; stdout = ''; stderr = ''; error = $null
}
$child = $null
try {
  [SipgesGoConsole]::OwnConsole()
  [SipgesGoConsole]::ProcessCtrlC()

  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $env:GC_EXE
  $arguments = ConvertFrom-Json $env:GC_ARGS_JSON
  $info.Arguments = (@(foreach ($item in $arguments) { Quote-Argument ([string] $item) })) -join ' '
  $info.UseShellExecute = $false
  # Not CreateNoWindow: the child must share this console for the Ctrl+C to reach it.
  $info.CreateNoWindow = $false
  $info.RedirectStandardInput = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
  $info.StandardErrorEncoding = New-Object System.Text.UTF8Encoding $false
  $child = [System.Diagnostics.Process]::Start($info)
  $report.childPid = $child.Id
  $stdout = $child.StandardOutput.ReadToEndAsync()
  $stderr = $child.StandardError.ReadToEndAsync()

  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeout)
  while (-not (Test-Path -LiteralPath $env:GC_STOP) -and -not $child.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  if (-not $child.HasExited) {
    [SipgesGoConsole]::SendCtrlC()
    $report.sent = $true
  }
  if (-not $child.WaitForExit($timeout)) {
    $report.error = "the child still ran $timeout ms after the Ctrl+C: ended by the helper"
    $child.Kill()
    $child.WaitForExit()
  }
  $child.WaitForExit()
  $report.exitCode = $child.ExitCode
  $report.stdout = $stdout.Result
  $report.stderr = $stderr.Result
} catch {
  $report.error = "$($_.Exception.Message)"
  if ($child -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
}
[System.IO.File]::WriteAllText($env:GC_REPORT, (New-Object PSObject -Property $report | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
exit 0
