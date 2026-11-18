# Opens a managed SIPGES install (install.ps1 -Release) as a desktop app. install.ps1 copies this
# script into the install root as start.ps1 and the shortcuts run that copy, so they keep
# working after updates. It reuses the local server when it answers; otherwise it starts the
# launcher of the install (which checks the releases folder for updates), opens Microsoft Edge in
# app mode and stays with the launcher: if an update cannot be rolled back (exit code 3) a message
# box names the copy to restore. Read deploy\desktop\README.md.
# Which launcher (go-rust-stack T72d3): the current version's Go launcher, go\sipges-desktop.exe
# --install <root> --releases <root>\releases with its bundled PostgreSQL 18 (postgresql\bin),
# when the version has them and the state folder install.json records is in pg18 (or holds no
# PGlite data yet, as a new install); it needs no Node. Otherwise, data still only in PGlite until
# the visit moves them, run-current.mjs (the TypeScript launcher, with Node). Both append their
# output to launcher.log and both serve 127.0.0.1:8000.
# SIPGES_DESKTOP_NO_UI=1 (the Windows drills, deploy\desktop\windows\drill.mjs, go-drill.mjs):
# every message goes to stdout instead of a message box and Edge is not opened; exit codes stay
# the same.
# -Go asks for the Go launcher only: it refuses, before starting anything, a version built without
# --go and a state folder whose data are still only in PGlite.
param([switch]$Go)
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
# How long a click waits for SIPGES while its launcher still runs: a start that recovers an
# interrupted update may retry each folder rename for 45 s while Windows reports it held.
$WaitSeconds = 300
# Outside the state folder: an update copies and may move that folder while SIPGES runs, and
# Windows cannot move a folder holding an open file.
$Log = Join-Path $Root 'launcher.log'
$HaltExitCode = 3
$HaltPrefix = 'SIPGES no se inició*'
# When the launcher left no notice: the copies beside the state folder install.json records ({0}
# its name, {1} the folder holding it, {2} its path), or a text true of any install.
$HaltNamed = 'SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. No borre nada. Restaure la copia de seguridad previa a la actualización (la carpeta {0}.pre-update-… que está en {1}, junto a su carpeta de datos {2}) o contacte con soporte.'
$HaltGeneric = 'SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. No borre nada. Restaure la copia de seguridad previa a la actualización (la carpeta terminada en .pre-update-… que está junto a su carpeta de datos de SIPGES) o contacte con soporte.'
$NoUi = $env:SIPGES_DESKTOP_NO_UI -eq '1'

function Show-Message([string]$Message) {
    if ($NoUi) { Write-Output $Message; return }
    [System.Windows.Forms.MessageBox]::Show($Message, 'SIPGES', 'OK', 'Error') | Out-Null
}

function Show-Failure([string]$Message) {
    Show-Message $Message
    exit 1
}

# The program serving port 8000: api (the Go API) or node (TypeScript); $null when unknown.
function Get-ServerImage {
    try {
        $owner = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess
        return (Get-Process -Id $owner -ErrorAction Stop).ProcessName
    } catch { return $null }
}

# A SIPGES that answers is opened only in the install's mode: the Go mode never reuses the
# TypeScript one (writes would go to PGlite) nor an unknown one, the TypeScript mode never the Go one.
function Assert-ServedMode {
    $image = Get-ServerImage
    if ($UseGo -and $image -ne 'api') { Show-Failure 'SIPGES ya está abierto sin el modo Go. Ciérrelo antes de abrirlo en modo Go.' }
    if (-not $UseGo -and $image -eq 'api') { Show-Failure 'SIPGES ya está abierto en modo Go. Ciérrelo antes de abrirlo sin el modo Go.' }
}

function Open-App {
    Assert-ServedMode
    if ($NoUi) { Write-Output "SIPGES: $Url"; return }
    Start-Process -FilePath 'msedge.exe' -ArgumentList "--app=$Url"
}

# The halt text naming the state folder recorded in install.json; the generic one when that file
# is missing, unreadable or records no absolute folder.
function Get-HaltFallback {
    try {
        $stateDir = (Get-Content -LiteralPath (Join-Path $Root 'install.json') -Raw -Encoding UTF8 | ConvertFrom-Json).stateDir
        if (($stateDir -is [string]) -and [System.IO.Path]::IsPathRooted($stateDir)) {
            return $HaltNamed -f (Split-Path -Leaf $stateDir), (Split-Path -Parent $stateDir), $stateDir
        }
    } catch { }
    return $HaltGeneric
}

# The launcher's own notice (the last one in the log) names the pre-update copy to restore.
function Show-Halt {
    $notice = $null
    if (Test-Path -LiteralPath $Log) {
        $notice = Get-Content -LiteralPath $Log -Encoding UTF8 |
            Where-Object { $_ -like $HaltPrefix } | Select-Object -Last 1
    }
    if ([string]::IsNullOrWhiteSpace($notice)) { $notice = Get-HaltFallback }
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

# The Go mode's files in the current version, or why it cannot run (Reason): an install that
# cannot be read, a version without the Go mode, and data not moved yet: something in pglite\
# and no cluster in pg18\ (a new cluster there would start SIPGES empty). Changes nothing.
function Get-GoServer {
    $release = $null
    $state = $null
    try {
        $pointer = (Get-Content -LiteralPath (Join-Path $Root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json).path
        if ($pointer -is [string]) {
            if ([System.IO.Path]::IsPathRooted($pointer)) { $release = $pointer }
            else { $release = Join-Path $Root ($pointer -replace '/', '\') }
        }
        $state = (Get-Content -LiteralPath (Join-Path $Root 'install.json') -Raw -Encoding UTF8 | ConvertFrom-Json).stateDir
    } catch { }
    if (-not $release -or -not ($state -is [string]) -or -not [System.IO.Path]::IsPathRooted($state)) {
        return @{ Reason = "SIPGES no está instalado correctamente en $Root. Vuelva a ejecutar el instalador." }
    }
    $server = @{
        Exe = Join-Path $release 'go\sipges-desktop.exe'
        PgBin = Join-Path $release 'postgresql\bin'
        Reason = $null
    }
    if (-not (Test-Path -LiteralPath $server.Exe) -or -not (Test-Path -LiteralPath (Join-Path $server.PgBin 'pg_ctl.exe'))) {
        return @{ Reason = 'Esta versión de SIPGES no incluye el modo Go. Abra SIPGES desde su acceso directo habitual.' }
    }
    $pglite = Get-ChildItem -LiteralPath (Join-Path $state 'pglite') -Force -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pglite -and -not (Test-Path -LiteralPath (Join-Path $state 'pg18\PG_VERSION'))) {
        return @{ Reason = 'SIPGES no se inició en modo Go: sus datos todavía no se movieron a PostgreSQL. No se tocó nada. Abra SIPGES desde su acceso directo habitual.' }
    }
    return $server
}

# The Go launcher of the install: recovery, first start, the update check of the releases folder
# and the update the person accepts in the app; exit code 3 is the same halt as the TypeScript
# one. Through cmd (its output appended to launcher.log), in a hidden console of its own, which
# it needs to stop the API with Ctrl+Break.
function Start-GoServer($Server) {
    $env:SIPGES_PG_BIN = $Server.PgBin
    $command = '"{0}" --install "{1}" --releases "{2}" >> "{3}" 2>&1' -f $Server.Exe, $Root,
        (Join-Path $Root 'releases'), $Log
    Start-Process -FilePath $env:ComSpec -ArgumentList "/d /c `"$command`"" `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru
}

# A second click while another start of this script holds the mutex: it waits for the same server
# as long as that start does, and never starts a second launcher.
function Wait-Other([System.Threading.Mutex]$Mutex) {
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while (-not (Test-Server)) {
        # Free: the other start ended without a server (it showed its own message). Abandoned
        # (that start was killed) counts as free and is now held here.
        $ended = $false
        try { $ended = $Mutex.WaitOne(0) } catch { $ended = $true }
        if ($ended) {
            $Mutex.ReleaseMutex()
            Show-Failure "SIPGES no arrancó. Revisa $Log."
        }
        if ((Get-Date) -gt $deadline) { Show-Failure "SIPGES no arrancó en $WaitSeconds segundos. Revisa $Log." }
        Start-Sleep -Seconds 1
    }
}

try {
    # The mode is chosen before any server is reused or started.
    $GoServer = Get-GoServer
    $UseGo = -not $GoServer.Reason
    if ($Go -and -not $UseGo) { Show-Failure $GoServer.Reason }
    if (Test-Server) {
        Open-App
        exit 0
    }
    # Held while this launcher runs: a click while it starts, or restarts for an update, only
    # waits for the same server instead of starting a second one.
    $created = $false
    $booting = New-Object System.Threading.Mutex($true, 'Local\SIPGES-start', [ref]$created)
    if (-not $created) {
        Wait-Other $booting
        Open-App
        exit 0
    }
    $launcher = if ($UseGo) { Start-GoServer $GoServer } else { Start-Launcher }
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
