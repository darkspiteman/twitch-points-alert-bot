# Сборка лаунчера TwitchAlertBot.exe штатным компилятором C# из .NET Framework 4.x
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Не найден компилятор C# (.NET Framework 4). Он входит в состав Windows 10/11.' }

# Иконка приложения: рисуем PNG 256x256 и упаковываем в .ico
Add-Type -AssemblyName System.Drawing
$ico = Join-Path $PSScriptRoot 'app.ico'
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 64
$path.AddArc(8, 8, $r, $r, 180, 90); $path.AddArc(248 - $r, 8, $r, $r, 270, 90)
$path.AddArc(248 - $r, 248 - $r, $r, $r, 0, 90); $path.AddArc(8, 248 - $r, $r, $r, 90, 90); $path.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(145, 71, 255))), $path)
$pts = for ($i = 0; $i -lt 10; $i++) {
  $a = -[Math]::PI / 2 + $i * [Math]::PI / 5
  $rr = if ($i % 2 -eq 0) { 92 } else { 38 }
  New-Object System.Drawing.PointF ([single](128 + [Math]::Cos($a) * $rr)), ([single](134 + [Math]::Sin($a) * $rr))
}
$g.FillPolygon([System.Drawing.Brushes]::White, [System.Drawing.PointF[]]$pts)
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$fs = [System.IO.File]::Create($ico)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)        # ICONDIR
$bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0)  # 256x256
$bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$png.Length); $bw.Write([UInt32]22)
$bw.Write($png); $bw.Close()

$out = Join-Path $root 'TwitchAlertBot.exe'
& $csc /nologo /target:winexe /codepage:65001 /optimize+ /win32icon:$ico /out:$out `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  (Join-Path $PSScriptRoot 'TrayLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw "Ошибка компиляции лаунчера (код $LASTEXITCODE)" }
Write-Host "Лаунчер собран: $out"
