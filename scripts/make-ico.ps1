# Converts assets/icon.png into a single-image assets/icon.ico
# (256x256 32-bit) so electron-packager can embed it as the .exe icon.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = Join-Path $PSScriptRoot '..\assets\icon.png'
$dst = Join-Path $PSScriptRoot '..\assets\icon.ico'
if (-not (Test-Path $src)) { Write-Error "missing $src"; exit 1 }
$bmp = [System.Drawing.Bitmap]::FromFile($src)
try {
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $fs = [System.IO.File]::Create($dst)
  try { $icon.Save($fs) } finally { $fs.Dispose() }
  Write-Host "wrote $dst"
} finally {
  $bmp.Dispose()
}
