import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App as AntdApp, Button, Layout, Space, Typography } from 'antd'

import { api, extractErrorMessage } from '../api/client'
import { useAuthUser } from '../components/RequireAuth'

const { Header, Content } = Layout

/**
 * 聊天页。
 *
 * 用户名不自己发请求，直接读守卫已经探测好的 <RequireAuth> 上下文——
 * 页面一渲染就有值，顶栏不会先空白再跳出用户名。
 *
 * 正文还是占位：下一步接 POST /api/chat/stream（SSE）。
 */
export default function ChatPage() {
  const navigate = useNavigate()
  // antd v6：message 用 App.useApp() 取（静态 message.error 已 deprecated）
  const { message } = AntdApp.useApp()
  const user = useAuthUser()
  const [loggingOut, setLoggingOut] = useState(false)

  const onLogout = async () => {
    setLoggingOut(true)
    try {
      await api.post<{ message: string }>('/auth/logout')
    } catch (err) {
      // 登出失败也必须让用户离开页面：前端本来就没有会话可清（token 在 HttpOnly Cookie 里，
      // JS 读不到），而后端 /auth/logout 即使重复调用也会安静成功；
      // 真正兜底的是后端会话 TTL。把用户"按了退出却留在原地"钉死才是更糟的体验。
      message.warning(extractErrorMessage(err, '退出登录请求未能送达，已返回登录页'))
    } finally {
      setLoggingOut(false)
      // replace：不把"已登出的 /chat"留在历史里，避免后退又回来触发一次 401 探测
      navigate('/login', { replace: true })
    }
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* Header 默认深色底，antd 的 Typography 默认是深色文字 → 显式指定白色，避免看不见 */}
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: 24,
        }}
      >
        <Typography.Title level={5} style={{ color: '#fff', margin: 0 }}>
          RAG 知识库问答
        </Typography.Title>

        <Space size={12}>
          <Typography.Text style={{ color: 'rgba(255, 255, 255, 0.85)' }}>
            当前用户：{user.username}
          </Typography.Text>
          <Button danger ghost onClick={onLogout} loading={loggingOut}>
            退出登录
          </Button>
        </Space>
      </Header>

      <Content style={{ padding: 24 }}>
        <Typography.Title level={3}>聊天页面</Typography.Title>
        <Typography.Paragraph type="secondary">
          待接入：问答流式输出（POST /api/chat/stream，SSE）。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          会话信息（来自 GET /api/auth/me）：{user.username} · {user.role} · {user.user_uuid}
        </Typography.Paragraph>
      </Content>
    </Layout>
  )
}
