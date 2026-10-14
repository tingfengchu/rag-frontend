# RAG backend (FastAPI) launcher for the public demo.
#
# Keep this window OPEN as well: the tunnel publishes the frontend (5173), and
# the frontend reaches this API through the Vite dev proxy. Stop it and the
# public page will load but every /api/* call will fail.
#
# --workers is deliberately left at its default of 1: each extra worker loads
# its own copy of the embedding / Cross-Encoder / Docling models (GB of RAM)
# and its own Chroma handle. Do not raise it on a personal machine or a small
# VPS (see the docstring at the top of api/main.py).
#
# --host 0.0.0.0 exposes this API on the LAN without TLS. The Quick Tunnel does
# NOT need it (cloudflared dials localhost), so switch to 127.0.0.1 whenever you
# only need the tunnel.
#
# NOTE: comments in this file are intentionally ASCII-only (PowerShell 5.1
# decodes .ps1 as GBK unless it has a UTF-8 BOM).

cd C:\projects\new_rag_project
.venv\Scripts\python.exe -m uvicorn api.main:app --host 0.0.0.0 --port 8000
