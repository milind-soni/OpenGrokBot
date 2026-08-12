# Generates build/icon.ico (multi-size, PNG-compressed) from the 1024px PNG
# source so electron-builder can package the Windows app.
Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $PSScriptRoot "icon-1024.png"
$outPath = Join-Path $PSScriptRoot "icon.ico"

$src = [System.Drawing.Image]::FromFile($srcPath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)

$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)

# ICONDIR
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$sizes.Count)

$images = @()
$offset = 6 + (16 * $sizes.Count)

foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()

  $pngMs = New-Object System.IO.MemoryStream
  $bmp.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $images += , @{ size = $size; data = $pngMs.ToArray() }
  $pngMs.Dispose()
}

foreach ($img in $images) {
  # ICONDIRENTRY — width/height 0 means 256
  $w = if ($img.size -ge 256) { 0 } else { $img.size }
  $writer.Write([Byte]$w)
  $writer.Write([Byte]$w)
  $writer.Write([Byte]0) # palette
  $writer.Write([Byte]0) # reserved
  $writer.Write([UInt16]1) # planes
  $writer.Write([UInt16]32) # bpp
  $writer.Write([UInt32]$img.data.Length)
  $writer.Write([UInt32]$offset)
  $offset += $img.data.Length
}

foreach ($img in $images) {
  $writer.Write($img.data)
}

$writer.Flush()
[System.IO.File]::WriteAllBytes($outPath, $stream.ToArray())
$writer.Dispose()
$stream.Dispose()
$src.Dispose()

Write-Output "Wrote $outPath ($($images.Count) sizes)"
