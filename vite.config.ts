import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 公网演示（Cloudflare Quick Tunnel）：浏览器带的 Host 是
    // <随机名>.trycloudflare.com，而 Vite 6+ 默认**只放行 localhost 与 IP 字面量**，
    // 其它域名一律 403「Blocked request. This host ... is not allowed」。
    // 症状很有迷惑性：隧道起来了、URL 也能打开，但页面直接就是一行报错。
    // 这里只额外放行 trycloudflare 子域——**别写成 `true`**，那等于把这道
    // DNS rebinding 防护整个关掉；换 ngrok / localhost.run / 自备域名时，
    // 把对应域名加进这个数组即可（如 '.ngrok-free.app'）。
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      // 开发期：前端只请求相对路径 /api/*，由 Vite 转发到 FastAPI。
      // 浏览器视角下前后端**同源**，于是：
      //   1) 后端不需要配 CORS；
      //   2) 会话 Cookie（HttpOnly + SameSite=Lax）能正常收发——
      //      若走真跨域，SameSite 得改成 None，而 None 又强制要求 Secure(HTTPS)，
      //      在 localhost 上很别扭。
      // ⚠️ 不要加 rewrite 去掉 /api：后端路由本身带 /api 前缀
      //    （api/main.py 里 include_router(..., prefix="/api")），去掉就 404。
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
