<#
  Opens Pulse. Builds dist\Pulse.exe first when it is missing (or with -Build).
  UI files (src\renderer, assets) and the Node server (src\server, src\host) are read from this
  folder at runtime, so editing them only needs a restart, not a rebuild.

  Usage:  .\run.ps1          start Pulse
          .\run.ps1 -Build   rebuild the native host, then start
          .\run.ps1 -Dev     debug host (console with logs)
#>
param(
    [switch]$Build,
    [switch]$Dev
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if ($Dev) {
    & (Join-Path $root 'build.ps1') -Dev
    $exe = Join-Path $root 'src-tauri\target\debug\Pulse.exe'
} else {
    $exe = Join-Path $root 'dist\Pulse.exe'
    if ($Build -or -not (Test-Path $exe)) { & (Join-Path $root 'build.ps1') }
}

$env:PULSE_ROOT = $root
if ($Dev) {
    & $exe
} else {
    Start-Process -FilePath $exe -WorkingDirectory $root
    Write-Host "Pulse started. Media server log: $env:APPDATA\Pulse\logs\server.log"
}
