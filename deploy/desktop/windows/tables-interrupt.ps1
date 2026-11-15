# A real console Ctrl+C for deploy/desktop/migration/tables.mjs on Windows, for
# tables-interrupt.mjs. Node cannot send one (child.kill() ends a Windows process outright), so
# this helper, in Windows PowerShell 5.1:
#   1. takes a console of its own (FreeConsole, AllocConsole), so the Ctrl+C below can reach
#      nothing but this helper and the tables.mjs it starts: never the runner or the drill;
#   2. turns Ctrl+C processing on (SetConsoleCtrlHandler(NULL, FALSE)), which the child inherits,
#      and survives its own Ctrl+C with a handler that answers TRUE;
#   3. starts node tables.mjs in that console, stdout and stderr read apart;
#   4. waits until the run has begun copying (a sipges-tables-* folder under the scratch folder
#      that holds `before`), checks that the console holds exactly this helper and the child,
#      then sends CTRL_C_EVENT with GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
#   5. waits for the child to end and writes a JSON report (never to the console, which it gave
#      up in step 1) to $env:TI_REPORT.
# Input through the environment: TI_NODE (node.exe), TI_ARGS_JSON (the arguments, a JSON array:
# tables.mjs and its options), TI_SCRATCH, TI_REPORT, TI_TIMEOUT_MS. Exit 0: the report was
# written (the drill judges it); any other exit: the helper itself failed. Synthetic data only.
# Closing the console window (CTRL_CLOSE_EVENT) cannot be sent this way: GenerateConsoleCtrlEvent
# sends only CTRL_C_EVENT and CTRL_BREAK_EVENT.
$ErrorActionPreference = 'Stop'
# No progress bar: after step 1 this helper has no console of the caller's to draw on.
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SipgesConsole {
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

foreach ($name in 'TI_NODE', 'TI_ARGS_JSON', 'TI_SCRATCH', 'TI_REPORT', 'TI_TIMEOUT_MS') {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is not set" }
}
$timeout = [int] $env:TI_TIMEOUT_MS
$report = [ordered] @{
  helperPid = $PID; childPid = $null; attached = @(); copySeen = $null; sent = $false
  exitCode = $null; stdout = ''; stderr = ''; error = $null
}
$child = $null
try {
  [SipgesConsole]::OwnConsole()
  [SipgesConsole]::ProcessCtrlC()

  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $env:TI_NODE
  # Windows PowerShell 5.1 returns a JSON array as one object: `foreach` walks its items.
  $arguments = ConvertFrom-Json $env:TI_ARGS_JSON
  $info.Arguments = (@(foreach ($item in $arguments) { Quote-Argument ([string] $item) })) -join ' '
  $info.UseShellExecute = $false
  # Not CreateNoWindow: that would give the child a console of its own, out of reach of step 4.
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
  while (-not $report.copySeen -and -not $child.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    foreach ($dir in @(Get-ChildItem -LiteralPath $env:TI_SCRATCH -Directory -Filter 'sipges-tables-*' -ErrorAction SilentlyContinue)) {
      if (Test-Path -LiteralPath (Join-Path $dir.FullName 'before')) { $report.copySeen = $dir.FullName }
    }
    if (-not $report.copySeen) { Start-Sleep -Milliseconds 5 }
  }
  if ($report.copySeen -and -not $child.HasExited) {
    $report.attached = @([SipgesConsole]::Attached() | ForEach-Object { [int] $_ })
    $expected = @($PID, $child.Id) | Sort-Object
    $actual = @($report.attached | Sort-Object)
    if (($actual -join ',') -ne ($expected -join ',')) {
      throw "the console holds processes $($actual -join ', '), expected only this helper and tables.mjs ($($expected -join ', ')): no Ctrl+C sent"
    }
    [SipgesConsole]::SendCtrlC()
    $report.sent = $true
  }
  if (-not $child.WaitForExit($timeout)) {
    $report.error = "tables.mjs still running $timeout ms after the Ctrl+C: ended by the helper"
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
[System.IO.File]::WriteAllText($env:TI_REPORT, (New-Object PSObject -Property $report | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
exit 0
