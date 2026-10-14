import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { Button, Result, Spin } from 'antd'

import { api, extractErrorMessage } from '../api/client'
import type { ApiUser } from '../api/client'

/**
 * 当前登录用户（由守卫探测 /auth/me 得到）。
 *
 * 为什么用 Context 而不是让每个页面自己再调一次 /auth/me：
 * 守卫已经拿到用户了，页面再问一次是同一份数据问两遍；更麻烦的是两个请求
 * 各自处理 401，"谁先跳、跳几次"会变得难以推理。用户信息只留一个来源。
 */
const AuthUserContext = createContext<ApiUser | null>(null)

/** 读当前登录用户。必须在 <RequireAuth> 内部使用——守卫已保证这里非空。 */
export function useAuthUser(): ApiUser {
  const user = useContext(AuthUserContext)
  if (!user) throw new Error('useAuthUser 必须在 <RequireAuth> 内部使用')
  return user
}

/** 全屏居中的加载态：探测会话期间显示，避免先闪一帧空页面再跳走。 */
function FullscreenSpin() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <Spin size="large" />
        <div style={{ marginTop: 12, color: 'rgba(0, 0, 0, 0.45)' }}>正在校验登录状态…</div>
      </div>
    </div>
  )
}

type AuthState =
  | { status: 'checking' }
  | { status: 'ready'; user: ApiUser }
  | { status: 'error'; message: string }

/**
 * 登录守卫：包在需要登录的路由外层。
 *
 * 判定逻辑刻意保持"默认拒绝"：
 * * 200 → 渲染 children；
 * * 401 → 跳 /login（用 replace，不往历史里塞一条必然失败的记录）；
 * * 其它错误（后端没起、超时、5xx）→ **不跳登录页**。这时用户其实没掉登录态，
 *   把人踢到登录页会让他以为是自己密码错了、白输一遍——显示错误 + 重试更诚实。
 */
export default function RequireAuth({
  children,
  adminOnly = false,
}: {
  children: ReactNode
  /**
   * 只允许管理员（模块 6 的 ``/admin`` 运营看板）。
   *
   * 为什么前端也拦一道：后端 ``GET /api/admin/stats`` 本来就会 403（权限的唯一权威），
   * 但若把页面渲染出来、让它在加载统计时弹个红条，用户只会以为"看板坏了"。
   * 这里只负责**说清楚为什么进不去**，不承担任何安全职责。
   */
  adminOnly?: boolean
}) {
  const navigate = useNavigate()
  const [state, setState] = useState<AuthState>({ status: 'checking' })
  // 自增后触发 useEffect 重跑 = "重试"；比把探测逻辑抽成 useCallback 更直白
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    // StrictMode 开发环境会挂载两次 → 会发两次探测请求，这是预期行为（生产只发一次）。
    // 卸载时 abort：避免组件已经消失后还在 setState / 跳转。
    const controller = new AbortController()

    void (async () => {
      try {
        const { data } = await api.get<ApiUser>('/auth/me', { signal: controller.signal })
        if (controller.signal.aborted) return
        setState({ status: 'ready', user: data })
      } catch (err) {
        // 主动 abort 引发的拒绝不算失败（axios 报 ERR_CANCELED）
        if (controller.signal.aborted || axios.isCancel(err)) return

        if (axios.isAxiosError(err) && err.response?.status === 401) {
          // 拦截器已把 /auth/me 排除在自动跳转之外，跳转由这里负责
          navigate('/login', { replace: true })
          return
        }
        setState({ status: 'error', message: extractErrorMessage(err, '无法确认登录状态') })
      }
    })()

    return () => controller.abort()
  }, [navigate, reloadKey])

  if (state.status === 'checking') return <FullscreenSpin />

  if (state.status === 'error') {
    return (
      <Result
        status="warning"
        title="无法确认登录状态"
        subTitle={`${state.message}（这是网络或后端服务问题，不是登录过期）`}
        extra={
          <Button
            type="primary"
            onClick={() => {
              setState({ status: 'checking' })
              setReloadKey((k) => k + 1)
            }}
          >
            重试
          </Button>
        }
      />
    )
  }

  if (adminOnly && state.user.role !== 'admin') {
    return (
      <Result
        status="403"
        title="需要管理员权限"
        subTitle={`当前账号「${state.user.username}」不是管理员，运营看板只对管理员开放。`}
        extra={
          <Button type="primary" onClick={() => navigate('/chat')}>
            返回对话
          </Button>
        }
      />
    )
  }

  return <AuthUserContext.Provider value={state.user}>{children}</AuthUserContext.Provider>
}
