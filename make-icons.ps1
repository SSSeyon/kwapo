param([string]$Out)
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference='Stop'
function P($x,$y){ New-Object System.Drawing.PointF([single]$x,[single]$y) }
function DrawMark($g,[single]$ox,[single]$oy,[single]$size){
  $s=$size/160.0
  $st=$g.Save()
  $g.TranslateTransform($ox,$oy); $g.ScaleTransform($s,$s)
  $grad=New-Object System.Drawing.Drawing2D.LinearGradientBrush((P 0 0),(P 160 160),[System.Drawing.Color]::FromArgb(0x2d,0xd4,0xbf),[System.Drawing.Color]::FromArgb(0x0d,0x80,0x76))
  $p=New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.StartFigure()
  $p.AddBezier((P 64 46),(P 56 32),(P 44 22),(P 50 12))
  $p.AddBezier((P 50 12),(P 60 20),(P 70 16),(P 80 10))
  $p.AddBezier((P 80 10),(P 90 16),(P 100 20),(P 110 12))
  $p.AddBezier((P 110 12),(P 116 22),(P 104 32),(P 96 46))
  $p.CloseFigure(); $p.StartFigure()
  $p.AddBezier((P 64 50),(P 30 66),(P 14 100),(P 20 128))
  $p.AddBezier((P 20 128),(P 24 148),(P 46 154),(P 80 154))
  $p.AddBezier((P 80 154),(P 114 154),(P 136 148),(P 140 128))
  $p.AddBezier((P 140 128),(P 146 100),(P 130 66),(P 96 50))
  $p.CloseFigure()
  $g.FillPath($grad,$p)
  $band=New-Object System.Drawing.Drawing2D.GraphicsPath
  $band.AddArc(56,40,13,13,90,180); $band.AddArc(91,40,13,13,270,180); $band.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0x0f,0x76,0x6e))),$band)
  $w=[System.Drawing.Brushes]::White
  $g.FillRectangle($w,56,82,11,56); $g.FillRectangle($w,93,82,11,56)
  $g.FillPolygon($w,[System.Drawing.PointF[]]@((P 56 82),(P 69.75 82),(P 104 138),(P 90.25 138)))
  $g.FillRectangle($w,46,101,68,6); $g.FillRectangle($w,46,115,68,6)
  $g.Restore($st)
}
function NewCanvas($w,$h,$bg){
  $b=New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g=[System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode='AntiAlias'; $g.InterpolationMode='HighQualityBicubic'; $g.PixelOffsetMode='HighQuality'; $g.TextRenderingHint='AntiAliasGridFit'
  if($bg){ $g.Clear($bg) } else { $g.Clear([System.Drawing.Color]::Transparent) }
  ,@($b,$g)
}
$dark=[System.Drawing.Color]::FromArgb(0x08,0x08,0x0e)

# Maskable 512: mark inside the central 60% (safe zone is the 80% circle)
$c=NewCanvas 512 512 $dark; DrawMark $c[1] 106 100 300; $c[0].Save("$Out\icon-maskable-512.png",[System.Drawing.Imaging.ImageFormat]::Png); $c[1].Dispose(); $c[0].Dispose()
# Apple touch 180
$c=NewCanvas 180 180 $dark; DrawMark $c[1] 25 22 130; $c[0].Save("$Out\apple-touch-icon.png",[System.Drawing.Imaging.ImageFormat]::Png); $c[1].Dispose(); $c[0].Dispose()
# Favicon 32 (transparent) -> wrapped as .ico
$c=NewCanvas 32 32 $null; DrawMark $c[1] 0 0 32
$ms=New-Object System.IO.MemoryStream; $c[0].Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); $png=$ms.ToArray(); $c[1].Dispose(); $c[0].Dispose()
$ico=New-Object System.IO.MemoryStream; $bw=New-Object System.IO.BinaryWriter($ico)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]1)
$bw.Write([byte]32); $bw.Write([byte]32); $bw.Write([byte]0); $bw.Write([byte]0)
$bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$png.Length); $bw.Write([uint32]22); $bw.Write($png); $bw.Flush()
[System.IO.File]::WriteAllBytes("$Out\favicon.ico",$ico.ToArray())
# Share image 1200x630
$c=NewCanvas 1200 630 $dark; $g=$c[1]
DrawMark $g 110 175 280
$f1=New-Object System.Drawing.Font('Segoe UI',118,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel)
$teal=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0x2d,0xd4,0xbf))
$fmt=[System.Drawing.StringFormat]::GenericTypographic
$g.DrawString([string][char]0xE0+'p'+[char]0xF2,$f1,[System.Drawing.Brushes]::White,450,170,$fmt)
$wA=$g.MeasureString([string][char]0xE0+'p'+[char]0xF2,$f1,2000,$fmt).Width
$g.DrawString('w'+[char]0xF3,$f1,$teal,450+$wA,170,$fmt)
$f2=New-Object System.Drawing.Font('Segoe UI',28,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('T R A C K .   P L A N .   G R O W .',$f2,(New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0x94,0xa3,0xb8))),456,330,$fmt)
$f3=New-Object System.Drawing.Font('Segoe UI',32,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('Private, encrypted money tracking',$f3,(New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0xcb,0xd5,0xe1))),456,390,$fmt)
$c[0].Save("$Out\og-image.png",[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $c[0].Dispose()
Get-ChildItem $Out -Include *.png,*.ico -Recurse | Select-Object Name,Length
