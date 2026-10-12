import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import ChatPage from './pages/ChatPage'
import LoginPage from './pages/LoginPage'

/**
 * 路由表。
 *
 * 用 BrowserRouter + Routes（而不是 createBrowserRouter）：结构最直白，
 * 后面加"登录守卫"（未登录访问 /chat 时跳 /login）只需再包一层组件。
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/" element={<Navigate to="/chat" replace />} />
        {/* 未知路径兜底，避免用户手打错地址看到空白页 */}
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
