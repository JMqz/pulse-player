# Generates the Pulse app icons from code (no external tools):
#   assets\icon.png  256x256
#   assets\icon.ico  16,20,24,32,40,48,64,128,256 (PNG-compressed entries)
# Design: 5 rounded sound-wave bars (same geometry as assets\pulse.svg) on a dark gradient squircle.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'

function New-RoundedRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object Drawing.Drawing2D.GraphicsPath
    $d = [Math]::Min($r * 2, [Math]::Min($w, $h))
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-PulseBitmap([int]$s) {
    $bmp = New-Object Drawing.Bitmap $s, $s, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([Drawing.Color]::Transparent)

    # Background squircle with a deep violet -> near-black diagonal gradient.
    $bg = New-RoundedRect 0 0 $s $s ($s * 0.22)
    $rect = New-Object Drawing.RectangleF 0, 0, $s, $s
    $bgBrush = New-Object Drawing.Drawing2D.LinearGradientBrush $rect, ([Drawing.Color]::FromArgb(255, 44, 26, 84)), ([Drawing.Color]::FromArgb(255, 10, 10, 20)), 45.0
    $g.FillPath($bgBrush, $bg)

    # Bars: pulse.svg uses a 512 grid, bar width 64, x = 32 + 96*i, heights centred on y=256.
    # Map that grid into the inner 72% of the icon.
    $pad = $s * 0.14
    $k = ($s - 2 * $pad) / 448.0
    $bars = @(@(32, 200, 312), @(128, 128, 384), @(224, 64, 448), @(320, 152, 360), @(416, 216, 296))
    $barRect = New-Object Drawing.RectangleF 0, $pad, $s, ($s - 2 * $pad)
    $barBrush = New-Object Drawing.Drawing2D.LinearGradientBrush $barRect, ([Drawing.Color]::FromArgb(255, 125, 211, 252)), ([Drawing.Color]::FromArgb(255, 192, 132, 252)), 90.0
    foreach ($b in $bars) {
        # Each svg bar is a capsule whose arcs extend 32 units past its straight segment (y1..y2),
        # and the drawing's content box is 32..480 on both axes.
        $x = $pad + ($b[0] - 32) * $k
        $top = $pad + ($b[1] - 64) * $k
        $h = ($b[2] - $b[1] + 64) * $k
        $w = 64 * $k
        $p = New-RoundedRect $x $top $w $h ($w / 2)
        $g.FillPath($barBrush, $p)
        $p.Dispose()
    }
    $g.Dispose()
    return $bmp
}

function Get-PngBytes([Drawing.Bitmap]$bmp) {
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    return , $ms.ToArray()
}

$big = New-PulseBitmap 256
$big.Save((Join-Path $assets 'icon.png'), [Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$pngs = @(foreach ($s in $sizes) { $b = New-PulseBitmap $s; , (Get-PngBytes $b); $b.Dispose() })
$icoPath = Join-Path $assets 'icon.ico'
$w = New-Object IO.BinaryWriter ([IO.File]::Create($icoPath))
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $len = $pngs[$i].Length
    $dim = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset)
    $offset += $len
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Close()

Write-Host "icon.png + icon.ico ($($sizes -join ',')) written to $assets"
