import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App as AntdApp, Button, Card, Form, Input } from 'antd'

import { api, extractErrorMessage, getAuthConfig } from '../api/client'
import type { ApiUser, LoginPayload } from '../api/client'
import RegisterModal from '../components/RegisterModal'

/**
 * 登录页。
 *
 * 成功后只做一件事：跳 /chat。
 * 不需要在前端存 token——后端把会话放在 HttpOnly Cookie 里，前端根本读不到，
 * 这正是设计意图（XSS 偷不走会话）。
 *
 * 注册入口（模块 2.2）由后端开关决定：`GET /auth/config` 的 `allow_register`。
 * 拿不到配置时**按关闭处理**——显示了一个必然 403 的入口比不显示更糟。
 */
export default function LoginPage() {
  const navigate = useNavigate()
  // antd v6：message 用 App.useApp() 取（静态 message.error 已 deprecated）
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm<LoginPayload>()
  const [loading, setLoading] = useState(false)
  const [allowRegister, setAllowRegister] = useState(false)
  const [registerOpen, setRegisterOpen] = useState(false)

  useEffect(() => {
    // 免登录接口：登录页自己就要调它（要求鉴权会变成死循环）
    let alive = true
    getAuthConfig()
      .then((cfg) => {
        if (alive) setAllowRegister(Boolean(cfg.allow_register))
      })
      .catch(() => {
        if (alive) setAllowRegister(false)
      })
    return () => {
      alive = false
    }
  }, [])

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

  /** 注册成功：确认停在 /login，并把用户名回填到登录表单（密码留空，由用户自己输）。 */
  const onRegistered = (username: string) => {
    form.setFieldsValue({ username, password: '' })
    if (window.location.pathname !== '/login') navigate('/login', { replace: true })
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
          form={form}
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

          <Form.Item style={{ marginBottom: allowRegister ? 8 : 0 }}>
            <Button type="primary" htmlType="submit" block size="large" loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>

        {allowRegister && (
          <div style={{ textAlign: 'center' }}>
            <Button type="link" style={{ padding: 0 }} onClick={() => setRegisterOpen(true)}>
              没有账号？立即注册
            </Button>
          </div>
        )}
      </Card>

      <RegisterModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onRegistered={onRegistered}
      />
    </div>
  )
}
