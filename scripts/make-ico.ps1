# Builds the Quota Halo PNG and ICO assets from the master logo artwork.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$assetDir = Join-Path $PSScriptRoot '..\assets'
$sourcePath = Join-Path $assetDir 'logo-source.png'
$iconPngPath = Join-Path $assetDir 'icon.png'
$trayPngPath = Join-Path $assetDir 'tray.png'
$iconPath = Join-Path $assetDir 'icon.ico'

if (-not (Test-Path -LiteralPath $sourcePath)) {
  Write-Error "missing $sourcePath"
  exit 1
}

$source = [System.Drawing.Image]::FromFile($sourcePath)
$bitmap = New-Object System.Drawing.Bitmap 256, 256, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($source, 0, 0, 256, 256)
  } finally {
    $graphics.Dispose()
  }
  $bitmap.Save($iconPngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Save($trayPngPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $bitmap.Dispose()
  $source.Dispose()
}

# ICO container with a PNG-compressed 256px frame. Width and height bytes are
# zero by specification for 256px frames; Windows supplies smaller tray sizes.
$pngBytes = [System.IO.File]::ReadAllBytes($iconPngPath)
$header = New-Object byte[] 22
$header[2] = 1
$header[4] = 1
$header[10] = 1
$header[12] = 32
[System.BitConverter]::GetBytes([uint32]$pngBytes.Length).CopyTo($header, 14)
[System.BitConverter]::GetBytes([uint32]22).CopyTo($header, 18)
$icoBytes = New-Object byte[] (22 + $pngBytes.Length)
[System.Array]::Copy($header, 0, $icoBytes, 0, $header.Length)
[System.Array]::Copy($pngBytes, 0, $icoBytes, 22, $pngBytes.Length)
[System.IO.File]::WriteAllBytes($iconPath, $icoBytes)

Write-Host "wrote $iconPngPath"
Write-Host "wrote $trayPngPath"
Write-Host "wrote $iconPath"
