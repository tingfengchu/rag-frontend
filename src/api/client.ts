import axios from 'axios'

/**
 * 全局 axios 实例。
 *
 * baseURL 故意用相对路径 '/api'：开发期由 Vite 代理转发（vite.config.ts），
 * 生产由 nginx 同源反代——两种环境代码不用改，也完全不碰跨域。
 *
 * withCredentials: true 是必须的：会话靠 HttpOnly Cookie（rag_session）承载，
 * 浏览器默认不会带上它，漏了这行每个接口都会 401。
 */
export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
})

/** GET /auth/me、POST /auth/login 的返回体（对应后端 api/schemas.py 的 UserOut）。 */
export interface ApiUser {
  user_uuid: string
  username: string
  role: 'user' | 'admin'
}

/** POST /auth/login 的请求体（对应 LoginIn）。 */
export interface LoginPayload {
  username: string
  password: string
}

/**
 * 取出后端的中文错误文案。
 *
 * 后端约定：业务错误统一返回 `{"detail": "密码至少 8 位"}`（api/errors.py），
 * 文案本身就是可直接展示的中文，所以前端不需要再翻译一遍。
 * 网络层错误（后端没起、超时）单独给一句人话，否则用户只能看到 "Network Error"。
 */
export function extractErrorMessage(
  err: unknown,
  fallback = '请求失败，请稍后重试',
): string {
  if (!axios.isAxiosError(err)) return fallback

  const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail
  if (typeof detail === 'string' && detail) return detail

  if (err.response) return `请求失败（HTTP ${err.response.status}）`
  if (err.code === 'ECONNABORTED') return '请求超时，请稍后重试'
  return '无法连接服务器，请确认后端已启动'
}
