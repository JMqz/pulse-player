<#
  Builds the native Pulse host -> C:\Riff\dist\Pulse.exe

  Toolchain (installed on demand, no Visual Studio needed):
    - Rust stable, x86_64-pc-windows-gnu host      (~/.cargo, ~/.rustup)
    - MinGW-w64 (WinLibs GCC, msvcrt)               %LOCALAPPDATA%\Pulse\toolchain\mingw64
      provides as/dlltool (import libs), windres + gcc (exe icon/version resource)
    - Node.js runtime for the media server          C:\Riff\runtime\node.exe (skipped with -SkipNode)

  Usage:  .\build.ps1            release build
          .\build.ps1 -Dev       debug build (faster compile, console logging)
          .\build.ps1 -SkipNode  don't fetch runtime\node.exe (falls back to node on PATH / Riff.exe)
#>
param(
    [switch]$Dev,
    [switch]$SkipNode
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$toolDir = Join-Path $env:LOCALAPPDATA 'Pulse\toolchain'
$mingwBin = Join-Path $toolDir 'mingw64\bin'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$winlibsUrl = 'https://github.com/brechtsanders/winlibs_mingw/releases/download/16.2.0posix-23.1.3-14.0.0-msvcrt-r3/winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64msvcrt-14.0.0-r3.zip'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function New-TempDir {
    $d = Join-Path ([IO.Path]::GetTempPath()) ("pulse-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $d | Out-Null
    return $d
}

# --- Rust (GNU host: links with MinGW instead of MSVC Build Tools) ---
if (-not (Test-Path (Join-Path $cargoBin 'cargo.exe'))) {
    Step 'Installing Rust (rustup, x86_64-pc-windows-gnu, minimal profile)'
    $tmp = New-TempDir
    $init = Join-Path $tmp 'rustup-init.exe'
    Invoke-WebRequest 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe' -OutFile $init
    & $init -y --default-host x86_64-pc-windows-gnu --default-toolchain stable --profile minimal --no-modify-path
    if ($LASTEXITCODE) { throw 'rustup-init failed' }
    Remove-Item -Recurse -Force $tmp
}

# --- MinGW-w64 ---
if (-not (Test-Path (Join-Path $mingwBin 'gcc.exe'))) {
    Step 'Installing MinGW-w64 (WinLibs, ~280 MB download)'
    $tmp = New-TempDir
    $zip = Join-Path $tmp 'winlibs.zip'
    Invoke-WebRequest $winlibsUrl -OutFile $zip
    New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
    & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $toolDir
    if ($LASTEXITCODE) { throw 'extracting MinGW failed' }
    Remove-Item -Recurse -Force $tmp
}
# GCC links MinGW's default-manifest.o when present, which collides with Tauri's manifest
# (Common Controls v6 + DPI awareness) and makes ld drop one of them. This toolchain is private
# to Pulse, so disable it.
$defaultManifest = Join-Path $toolDir 'mingw64\x86_64-w64-mingw32\lib\default-manifest.o'
if (Test-Path $defaultManifest) { Move-Item $defaultManifest "$defaultManifest.disabled" -Force }

# --- Node runtime for the media server ---
$nodeExe = Join-Path $root 'runtime\node.exe'
if (-not $SkipNode -and -not (Test-Path $nodeExe)) {
    Step 'Fetching portable Node.js (LTS) -> runtime\node.exe'
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $lts = $index | Where-Object { $_.lts -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
    $name = "node-$($lts.version)-win-x64"
    $tmp = New-TempDir
    $zip = Join-Path $tmp "$name.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$($lts.version)/$name.zip" -OutFile $zip
    & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $tmp "$name/node.exe"
    if ($LASTEXITCODE) { throw 'extracting node.exe failed' }
    New-Item -ItemType Directory -Force -Path (Split-Path $nodeExe) | Out-Null
    Move-Item (Join-Path $tmp "$name\node.exe") $nodeExe -Force
    Remove-Item -Recurse -Force $tmp
    Write-Host "    node $($lts.version)"
}

# --- Icons (regenerated only if missing) ---
if (-not (Test-Path (Join-Path $root 'assets\icon.ico'))) {
    Step 'Generating icons'
    & (Join-Path $root 'scripts\make-icons.ps1')
}
Copy-Item (Join-Path $root 'assets\icon.ico'), (Join-Path $root 'assets\icon.png') (Join-Path $root 'src-tauri\icons') -Force

# --- Build ---
$env:PATH = "$cargoBin;$mingwBin;$env:PATH"
$buildProfile = if ($Dev) { 'debug' } else { 'release' }
Step "cargo build ($buildProfile)"
$cargoArgs = @('build', '--manifest-path', (Join-Path $root 'src-tauri\Cargo.toml'))
if (-not $Dev) { $cargoArgs += '--release' }
& cargo @cargoArgs
if ($LASTEXITCODE) { throw "cargo build failed ($LASTEXITCODE)" }

$out = Join-Path $root "src-tauri\target\$buildProfile"
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item (Join-Path $out 'Pulse.exe') $dist -Force
# Older webview2-com versions need the loader DLL next to the exe on the GNU target.
if (Test-Path (Join-Path $out 'WebView2Loader.dll')) { Copy-Item (Join-Path $out 'WebView2Loader.dll') $dist -Force }

$exe = Get-Item (Join-Path $dist 'Pulse.exe')
Step ("dist\Pulse.exe  {0:N1} MB" -f ($exe.Length / 1MB))
