import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
