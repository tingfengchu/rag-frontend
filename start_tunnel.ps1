# Public demo tunnel for the RAG frontend (Cloudflare Quick Tunnel).
#
# Keep this window OPEN for the whole demo. A Quick Tunnel lives inside this
# process: close it and the public URL is dead. The URL also changes on every
# start, so copy the printed https://<random>.trycloudflare.com into the
# README "Public demo" section each time.
#
# Prereqs (both must already be running BEFORE you start the tunnel):
#   1) backend  : .\start_backend.ps1        (FastAPI on :8000)
#   2) frontend : npm run dev                (Vite on :5173)
# The tunnel only publishes 5173; the frontend reaches the API through the
# Vite dev proxy, so the backend stays on localhost.
#
# NOTE: comments in this file are intentionally ASCII-only. Windows
# PowerShell 5.1 decodes .ps1 files as GBK unless they carry a UTF-8 BOM, so
# Chinese comments here can turn into mojibake or even break parsing.

$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
    $cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
    Write-Host '[i] cloudflared is not on PATH in THIS shell (PATH was updated after the window opened).'
    Write-Host "[i] Falling back to: $cf"
    Write-Host '[i] A brand new terminal would find it on PATH directly.'
}
if (-not (Test-Path $cf)) {
    Write-Host "[x] cloudflared not found ($cf). Install it with: winget install --id Cloudflare.cloudflared"
    exit 1
}

Write-Host '[i] A Quick Tunnel will be created in a few seconds.'
Write-Host '[i] Copy the printed https://<random>.trycloudflare.com - it changes every start.'
Write-Host '[i] Keep this window OPEN for the whole demo. Press Ctrl+C to stop.'
Write-Host ''

& $cf tunnel --url http://localhost:5173
