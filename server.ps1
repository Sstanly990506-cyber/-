param(
  [int]$Port = 4173,
  [string]$Root = (Get-Location).Path
)

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "[INFO] PowerShell 伺服器已啟動：$prefix"
Write-Host "[INFO] 根目錄：$Root"
Write-Host "[INFO] 按 Ctrl + C 可停止"

function Get-ContentType([string]$path) {
  switch ([System.IO.Path]::GetExtension($path).ToLowerInvariant()) {
    '.html' { 'text/html; charset=utf-8' }
    '.js'   { 'application/javascript; charset=utf-8' }
    '.css'  { 'text/css; charset=utf-8' }
    '.json' { 'application/json; charset=utf-8' }
    '.png'  { 'image/png' }
    '.jpg'  { 'image/jpeg' }
    '.jpeg' { 'image/jpeg' }
    '.svg'  { 'image/svg+xml' }
    '.ico'  { 'image/x-icon' }
    default { 'application/octet-stream' }
  }
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $requestPath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))

    if ([string]::IsNullOrWhiteSpace($requestPath)) {
      $requestPath = 'index.html'
    }

    $fullPath = Join-Path $Root $requestPath

    if ((Test-Path $fullPath) -and -not (Get-Item $fullPath).PSIsContainer) {
      $bytes = [System.IO.File]::ReadAllBytes($fullPath)
      $context.Response.ContentType = Get-ContentType $fullPath
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    else {
      $context.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
      $context.Response.OutputStream.Write($msg, 0, $msg.Length)
    }

    $context.Response.OutputStream.Close()
  }
}
finally {
  $listener.Stop()
  $listener.Close()
}
