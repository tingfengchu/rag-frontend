import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Form, Input, App as AntdApp } from 'antd'

import { api, extractErrorMessage } from '../api/client'
import type { ApiUser, LoginPayload } from '../api/client'

/**
 * 登录页。
 *
 * 成功后只做一件事：跳 /chat。
 * 不需要在前端存 token——后端把会话放在 HttpOnly Cookie 里，前端根本读不到，
 * 这正是设计意图（XSS 偷不走会话）。
 */
export default function LoginPage() {
  const navigate = useNavigate()
  // antd v6：message 用 App.useApp() 取（静态 message.error 已 deprecated）
  const { message } = AntdApp.useApp()
  const [loading, setLoading] = useState(false)

  const onFinish = async (values: LoginPayload) => {
    setLoading(true)
    try {
      await api.post<ApiUser>('/auth/login', values)
      message.success('登录成功')
      navigate('/chat', { replace: true })
    } catch (err) {
      message.error(extractErrorMessage(err, '登录失败，请检查用户名和密码'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        padding: 16,
      }}
    >
      <Card title="RAG 知识库问答 · 登录" style={{ width: 380 }}>
        <Form<LoginPayload>
          name="login"
          layout="vertical"
          onFinish={onFinish}
          autoComplete="off"
          requiredMark={false}
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="请输入用户名" autoComplete="username" size="large" />
          </Form.Item>

          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              placeholder="请输入密码"
              autoComplete="current-password"
              size="large"
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block size="large" loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
