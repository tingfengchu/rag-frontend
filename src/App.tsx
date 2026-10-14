import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import RequireAuth from './components/RequireAuth'
import AdminDashboard from './pages/AdminDashboard'
import ChatPage from './pages/ChatPage'
import LoginPage from './pages/LoginPage'

/**
 * 路由表。
 *
 * 用 BrowserRouter + Routes（而不是 createBrowserRouter）：结构最直白。
 * 需要登录的页面统一交给 <RequireAuth> 包一层——守卫自己探测 /auth/me，
 * 所以路由这里不需要额外加载登录态，也不会出现"页面先渲染再被弹走"的闪烁。
 *
 * ``/admin``（模块 6 的运营看板）多一层 ``adminOnly``：非管理员看到的是
 * 「需要管理员权限」而不是一个加载失败的红条。真正的权限判定始终在后端。
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/chat"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth adminOnly>
              <AdminDashboard />
            </RequireAuth>
          }
        />
        <Route path="/" element={<Navigate to="/chat" replace />} />
        {/* 未知路径兜底，避免用户手打错地址看到空白页 */}
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
