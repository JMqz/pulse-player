<#
  Packages Pulse for distribution (Windows 10/11 x64):
    release\Pulse-Portable-win64.zip   unzip anywhere and run Pulse.exe
    release\Pulse-Setup-win64.exe      per-user installer (%LOCALAPPDATA%\Programs\Pulse), Inno Setup

  Package layout (the app root Pulse.exe looks for):
    Pulse.exe, WebView2Loader.dll, package.json, LICENSE
    src\renderer, src\server, src\host, src\shared
    assets\
    runtime\node.exe                       media server runtime
    bin\yt-dlp.exe, ffmpeg.exe, ffprobe.exe

  The media server has no npm dependencies (Node built-ins only), so no node_modules is shipped.
  Tools are taken from bin\, %LOCALAPPDATA%\Pulse\bin or %LOCALAPPDATA%\Riff\bin, and downloaded
  from the official GitHub releases when none of those has them.

  Usage:  .\package.ps1              build dist\Pulse.exe, then package
          .\package.ps1 -SkipBuild   reuse the current dist\Pulse.exe
          .\package.ps1 -NoZip / -NoInstaller
#>
param(
    [switch]$SkipBuild,
    [switch]$NoZip,
    [switch]$NoInstaller
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$release = Join-Path $root 'release'
$stage = Join-Path $release 'stage\Pulse'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

$version = (Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version

# --- Native host + node runtime ---
if (-not $SkipBuild) { & (Join-Path $root 'build.ps1') }
foreach ($f in 'dist\Pulse.exe', 'dist\WebView2Loader.dll', 'runtime\node.exe') {
    if (-not (Test-Path (Join-Path $root $f))) { throw "missing $f (run .\build.ps1)" }
}

# --- Media tools ---
$toolDirs = @(
    (Join-Path $root 'bin'),
    (Join-Path $env:LOCALAPPDATA 'Pulse\bin'),
    (Join-Path $env:LOCALAPPDATA 'Riff\bin')
)
function Find-Tool($exe) {
    foreach ($d in $toolDirs) {
        $p = Join-Path $d $exe
        if (Test-Path $p) { return $p }
    }
    return $null
}
function Get-Sha256Line($sumsUrl, $name) {
    $sums = (Invoke-WebRequest $sumsUrl -UseBasicParsing).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    foreach ($line in $sums -split "`n") {
        if ($line -match "^([a-fA-F0-9]{64})\s+\*?(?:\./)?(.+?)\s*$" -and $Matches[2] -eq $name) { return $Matches[1].ToLower() }
    }
    throw "no checksum for $name"
}
$fetchDir = Join-Path $env:LOCALAPPDATA 'Pulse\bin'
if (-not (Find-Tool 'yt-dlp.exe')) {
    Step 'Downloading yt-dlp.exe (github.com/yt-dlp/yt-dlp)'
    New-Item -ItemType Directory -Force -Path $fetchDir | Out-Null
    $base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
    $want = Get-Sha256Line "$base/SHA2-256SUMS" 'yt-dlp.exe'
    $dest = Join-Path $fetchDir 'yt-dlp.exe'
    Invoke-WebRequest "$base/yt-dlp.exe" -OutFile "$dest.download"
    if ((Get-FileHash "$dest.download" -Algorithm SHA256).Hash.ToLower() -ne $want) { throw 'yt-dlp checksum mismatch' }
    Move-Item "$dest.download" $dest -Force
}
if (-not (Find-Tool 'ffmpeg.exe') -or -not (Find-Tool 'ffprobe.exe')) {
    Step 'Downloading ffmpeg/ffprobe (github.com/yt-dlp/FFmpeg-Builds)'
    New-Item -ItemType Directory -Force -Path $fetchDir | Out-Null
    $base = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download'
    $asset = 'ffmpeg-master-latest-win64-gpl.zip'
    $want = Get-Sha256Line "$base/checksums.sha256" $asset
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("pulse-ffmpeg-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp $asset
    Invoke-WebRequest "$base/$asset" -OutFile $zip
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $want) { throw 'ffmpeg checksum mismatch' }
    & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $tmp
    if ($LASTEXITCODE) { throw 'extracting ffmpeg failed' }
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
        $src = Get-ChildItem $tmp -Recurse -Filter $exe | Select-Object -First 1
        Copy-Item $src.FullName (Join-Path $fetchDir $exe) -Force
    }
    Remove-Item -Recurse -Force $tmp
}

# --- Stage ---
Step "Staging Pulse $version"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item (Join-Path $root 'dist\Pulse.exe'), (Join-Path $root 'dist\WebView2Loader.dll'), (Join-Path $root 'package.json'), (Join-Path $root 'LICENSE') $stage
foreach ($dir in 'renderer', 'server', 'host', 'shared') {
    $dest = Join-Path $stage "src\$dir"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $root "src\$dir\*") $dest -Recurse
}
# Onboarding page of the old Electron shell; Pulse never loads it.
Remove-Item (Join-Path $stage 'src\renderer\welcome.html') -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root 'assets') (Join-Path $stage 'assets') -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'runtime'), (Join-Path $stage 'bin') | Out-Null
Copy-Item (Join-Path $root 'runtime\node.exe') (Join-Path $stage 'runtime')
foreach ($exe in 'yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe') {
    Copy-Item (Find-Tool $exe) (Join-Path $stage 'bin')
}

$size = (Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("    {0:N0} MB staged" -f ($size / 1MB))

# --- Portable zip ---
if (-not $NoZip) {
    $zipPath = Join-Path $release 'Pulse-Portable-win64.zip'
    Step 'Creating Pulse-Portable-win64.zip'
    Remove-Item $zipPath -ErrorAction SilentlyContinue
    Push-Location (Split-Path $stage)
    try {
        & "$env:SystemRoot\System32\tar.exe" -a -cf $zipPath 'Pulse'
        if ($LASTEXITCODE) { throw 'zip failed' }
    } finally { Pop-Location }
    Write-Host ("    {0:N0} MB" -f ((Get-Item $zipPath).Length / 1MB))
}

# --- Installer ---
if (-not $NoInstaller) {
    $iscc = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $iscc) {
        Step 'Installing Inno Setup 6 (winget, per-user)'
        winget install --id JRSoftware.InnoSetup -e --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Null
        $iscc = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
        if (-not (Test-Path $iscc)) { throw 'Inno Setup not found; install it from https://jrsoftware.org/isdl.php' }
    }
    Step 'Compiling Pulse-Setup-win64.exe (Inno Setup)'
    & $iscc /Q "/DAppVersion=$version" "/DStageDir=$stage" "/DOutDir=$release" (Join-Path $root 'installer\Pulse.iss')
    if ($LASTEXITCODE) { throw "ISCC failed ($LASTEXITCODE)" }
    Write-Host ("    {0:N0} MB" -f ((Get-Item (Join-Path $release 'Pulse-Setup-win64.exe')).Length / 1MB))
}

Step "Done -> $release"
