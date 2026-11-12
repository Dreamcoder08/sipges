# Opens a managed SIPGES install (install.ps1 -Release) as a desktop app. install.ps1 copies this
# script into the install root as start.ps1 and the shortcuts run that copy, so they keep
# working after updates. It reuses the local server when it answers; otherwise it starts
# run-current.mjs (the launcher of the current version, which checks the releases folder for
# updates), opens Microsoft Edge in app mode and stays with the launcher: if an update cannot be
# rolled back (exit code 3) a message box names the copy to restore. Read deploy\desktop\README.md.
# SIPGES_DESKTOP_NO_UI=1 (the Windows drill, deploy\desktop\windows\drill.mjs): every message
# goes to stdout instead of a message box and Edge is not opened; exit codes stay the same.
$ErrorActionPreference = 'Stop'
# Accents as typed for whoever reads this output through a pipe (SIPGES_DESKTOP_NO_UI=1 under the
# drill): Windows PowerShell 5.1 would write it in the console's OEM code page. A console window
# shows the same either way; the previous encoding is put back when the script ends.
$PreviousOutputEncoding = $null
try {
    $PreviousOutputEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }
Add-Type -AssemblyName System.Windows.Forms

$Root = $PSScriptRoot
$Url = 'http://localhost:8000'
# The server binds 127.0.0.1; "localhost" may resolve to ::1 first, where nothing listens.
$Probe = 'http://127.0.0.1:8000/health'
$WaitSeconds = 90
# Outside the state folder: an update copies and may move that folder while SIPGES runs, and
# Windows cannot move a folder holding an open file.
$Log = Join-Path $Root 'launcher.log'
$HaltExitCode = 3
$HaltPrefix = 'SIPGES no se inició*'
$HaltFallback = 'SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. No borre nada. Restaure la copia de seguridad previa a la actualización (la carpeta SIPGES.pre-update-… junto a %LOCALAPPDATA%\SIPGES) o contacte con soporte.'
$NoUi = $env:SIPGES_DESKTOP_NO_UI -eq '1'

function Show-Message([string]$Message) {
    if ($NoUi) { Write-Output $Message; return }
    [System.Windows.Forms.MessageBox]::Show($Message, 'SIPGES', 'OK', 'Error') | Out-Null
}

function Show-Failure([string]$Message) {
    Show-Message $Message
    exit 1
}

function Open-App {
    if ($NoUi) { Write-Output "SIPGES: $Url"; return }
    Start-Process -FilePath 'msedge.exe' -ArgumentList "--app=$Url"
}

# The launcher's own notice (the last one in the log) names the pre-update copy to restore.
function Show-Halt {
    $notice = $null
    if (Test-Path -LiteralPath $Log) {
        $notice = Get-Content -LiteralPath $Log -Encoding UTF8 |
            Where-Object { $_ -like $HaltPrefix } | Select-Object -Last 1
    }
    if ([string]::IsNullOrWhiteSpace($notice)) { $notice = $HaltFallback }
    Show-Message $notice
    exit $HaltExitCode
}

function Test-Server {
    try {
        Invoke-WebRequest -Uri $Probe -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

# Appends to launcher.log (a plain redirect through cmd keeps earlier runs) and hides the window.
# cmd ends with node's exit code, so the launcher's code 3 reaches this script.
function Start-Launcher {
    $command = '"{0}" "{1}" --releases "{2}" >> "{3}" 2>&1' -f (Get-Command node).Source,
        (Join-Path $Root 'run-current.mjs'), (Join-Path $Root 'releases'), $Log
    Start-Process -FilePath $env:ComSpec -ArgumentList "/d /c `"$command`"" `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru
}

function Wait-Server([int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while (-not (Test-Server)) {
        if ((Get-Date) -gt $deadline) { Show-Failure "SIPGES no arrancó en $Seconds segundos. Revisa $Log." }
        Start-Sleep -Seconds 1
    }
}

try {
    if (Test-Server) {
        Open-App
        exit 0
    }
    # Held while this launcher runs: a click while it starts, or restarts for an update, only
    # waits for the same server instead of starting a second one.
    $created = $false
    $booting = New-Object System.Threading.Mutex($true, 'Local\SIPGES-start', [ref]$created)
    if (-not $created) {
        Wait-Server $WaitSeconds
        Open-App
        exit 0
    }
    $launcher = Start-Launcher
    # Without a handle taken right away, ExitCode stays empty after the process ends.
    $null = $launcher.Handle
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while (-not (Test-Server)) {
        # Release before the message box so later clicks are not held by an open dialog.
        if ($launcher.HasExited) {
            $booting.ReleaseMutex()
            if ($launcher.ExitCode -eq $HaltExitCode) { Show-Halt }
            Show-Failure "SIPGES se cerró al arrancar. Revisa $Log."
        }
        if ((Get-Date) -gt $deadline) {
            $booting.ReleaseMutex()
            Show-Failure "SIPGES no arrancó en $WaitSeconds segundos. Revisa $Log."
        }
        Start-Sleep -Seconds 1
    }
    Open-App
    # Stay with the launcher: an update after the click can still end in a halt.
    $launcher.WaitForExit()
    $booting.ReleaseMutex()
    if ($launcher.ExitCode -eq $HaltExitCode) { Show-Halt }
} catch {
    Show-Failure "SIPGES no pudo abrirse: $($_.Exception.Message)"
} finally {
    if ($PreviousOutputEncoding) { try { [Console]::OutputEncoding = $PreviousOutputEncoding } catch { } }
}
