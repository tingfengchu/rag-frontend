import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp } from 'antd'
import './index.css'
import App from './App.tsx'

// 外层套一层 antd 的 <App>：message / notification / modal 通过 AntdApp.useApp()
// 获取——这是 v6 官方推荐用法。直接用静态 message.error 在 v6 已 deprecated
// （静态方法读不到 ConfigProvider 上下文，开启 layer 时还可能样式错乱）。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AntdApp>
      <App />
    </AntdApp>
  </StrictMode>,
)
