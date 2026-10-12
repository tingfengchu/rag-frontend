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

/**
 * 401 免自动跳转名单（按 baseURL 之后的路径匹配）。
 *
 * * `/auth/me`    —— 守卫组件正是靠这个 401 判断"没登录"，跳转时机由 RequireAuth 决定；
 *                    拦截器若也跳一次，会和守卫自己的 loading / 重试逻辑抢方向盘。
 * * `/auth/login` —— 密码输错返回的 401 是**正常业务结果**，必须留给登录页弹中文提示。
 *                    这里若跳转（整页刷新），用户永远看不到"用户名或密码错误"，只会看到页面闪一下。
 */
const AUTH_401_EXEMPT = ['/auth/me', '/auth/login']

/** 判断某个请求是否在 401 免跳转名单里（忽略 query / hash）。 */
function is401Exempt(url: string | undefined): boolean {
  if (!url) return false
  const path = url.split(/[?#]/)[0]
  return AUTH_401_EXEMPT.some((p) => path === p || path.endsWith(p))
}

/**
 * 响应拦截器：任何接口返回 401（会话过期 / 被吊销 / Cookie 丢失）→ 统一踢回登录页。
 *
 * 为什么用 window.location.replace 而不是 react-router 的 navigate：
 * 本模块在 React 树之外，拿不到 Router 上下文。整页跳转顺带清掉内存里的旧用户数据，
 * 反而更干净（代价是丢掉未提交的页面状态，当前阶段可接受）。
 * 用 replace 而非 assign：避免用户按"后退"回到一个必然 401 的页面再被弹一次。
 */
api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      !is401Exempt(error.config?.url) &&
      // 已经在登录页就不要再跳：否则一个必然失败的探测请求会把页面无限重刷
      window.location.pathname !== '/login'
    ) {
      window.location.replace('/login')
    }
    // 原始错误继续抛出去：调用方仍要负责弹提示 / 改状态
    return Promise.reject(error)
  },
)
