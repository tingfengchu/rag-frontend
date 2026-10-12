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

/* ============================ 流式问答（SSE） ============================ */

/**
 * 重排模型白名单，对应后端 ``schemas.RERANK_MODEL_CHOICES``。
 *
 * 后端刻意用 Literal 而不是自由字符串：模型名会被拿去 HF 加载（真实下载 + 常驻内存），
 * 放开就等于给了一个资源滥用入口。前端必须按同一份清单给选项，否则 422。
 */
export type RerankModelName =
  | 'cross-encoder/ms-marco-MiniLM-L-6-v2'
  | 'BAAI/bge-reranker-base'

export const RERANK_MODELS: { value: RerankModelName; label: string }[] = [
  {
    value: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
    label: 'ms-marco-MiniLM-L-6-v2（通用）',
  },
  { value: 'BAAI/bge-reranker-base', label: 'bge-reranker-base（中文推荐）' },
]

/**
 * 流式问答请求体，对应后端 ``schemas.ChatIn``。
 *
 * ⚠️ 字段名以**后端为准**：是 ``file_uuid``（不是 selected_file_uuid）。
 * ``scope`` 只接受 ``"public"`` 或 ``"private:<自己的 user_uuid>"``——
 * 其余取值会被 ``api/deps.resolve_scope`` 判为 400 / 403，前端不该靠猜。
 */
export interface ChatStreamPayload {
  question: string
  scope: string
  enable_rerank: boolean
  rerank_model: RerankModelName
  /** 限定检索单个文件；null / 省略 = 该库全部文件 */
  file_uuid?: string | null
}

/** 引用来源（后端 ``Citation``）。 */
export interface Citation {
  source: string
  page: number
}

/** 命中片段详情（后端 ``DebugChunk``）——留给后续"调试面板"，当前不渲染。 */
export interface DebugChunk {
  length: number
  is_parent: boolean
  preview: string
  rerank_score: number
}

/**
 * ``meta`` 事件载荷。
 *
 * 字段全部可选是**有意为之**：后端在不同时机各发一部分——
 * 流一开始发 ``{scope, question, rewritten_question, rewritten}``；
 * 命中缓存时补一帧 ``{cached: true}``；模型输出被判为拒答时补 ``{refused: true}``。
 * 所以前端必须按"增量补丁"处理，不能假设一次拿全。
 */
export interface ChatMeta {
  scope?: string
  question?: string
  rewritten_question?: string
  rewritten?: boolean
  cached?: boolean
  refused?: boolean
}

/** ``done`` 事件载荷：完整答案，前端可用它整段替换逐 token 拼出来的结果。 */
export interface ChatDoneResult {
  question: string
  rewritten_question: string
  answer: string
  citations: Citation[]
  scope: string
  cached: boolean
  max_score: number
  refused: boolean
}

/** 流式接口的失败（HTTP 非 2xx，或响应没有 body）。 */
export class ChatStreamError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ChatStreamError'
    this.status = status
  }
}

/** ``SSEChat`` 的返回值：调用方自己读 reader，并负责解析 SSE 帧。 */
export interface ChatStreamHandle {
  response: Response
  reader: ReadableStreamDefaultReader<Uint8Array>
}

/**
 * 发起流式问答，返回响应体的 reader（由调用方持续 read）。
 *
 * 为什么用 fetch 而不是本文件里那个 axios 实例：
 * 浏览器端 axios 底层是 XHR，**拿不到增量响应**——它必须等整个响应结束才 resolve，
 * 流式渲染就无从谈起。fetch + ReadableStream 才能一块一块地读。
 *
 * ``credentials: 'include'`` 必须有：会话在 HttpOnly Cookie 里，漏了这行必然 401。
 * 开发期（Vite 代理）与生产（nginx 同源）下浏览器本来就带 Cookie，显式写出来
 * 才能在真跨域（后端配了 CORS + allow_credentials）时同样正确。
 *
 * 另外**不加超时**：一次问答要跑检索 + LLM 生成，几十秒很正常；
 * 这里套用 axios 那 30s 超时只会把正常的长回答掐断。要中断请传 AbortSignal。
 */
export async function SSEChat(
  payload: ChatStreamPayload,
  options: { signal?: AbortSignal } = {},
): Promise<ChatStreamHandle> {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    credentials: 'include',
    signal: options.signal,
  })

  if (!response.ok) {
    throw new ChatStreamError(response.status, await readErrorDetail(response))
  }

  const body = response.body
  if (!body) {
    // 正常浏览器不会走到这里；被代理/插件改写响应时可能出现
    throw new ChatStreamError(response.status, '当前浏览器未提供流式响应体')
  }
  return { response, reader: body.getReader() }
}

/**
 * 取出失败响应里的中文 detail（后端统一格式 ``{"detail": "..."}``）。
 *
 * 流式接口是 fetch，``extractErrorMessage``（只认 axios 错误）在这里用不上，
 * 所以单独补一个。不是 JSON 时（例如 nginx 直接吐 502 HTML）回落一句按状态码的人话。
 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown }
    if (typeof data.detail === 'string' && data.detail) return data.detail
  } catch {
    // 非 JSON 响应 —— 落到下面的兜底文案
  }
  if (response.status === 401) return '登录状态已失效，请重新登录'
  return `请求失败（HTTP ${response.status}）`
}

/** 文件列表项（后端 ``FileOut``）。 */
export interface ApiFile {
  file_uuid: string
  file_name: string
  source: string
}

/** 列出某库中已成功入库的文件；用于侧栏的"文件级过滤"下拉。 */
export async function listFiles(scope: string): Promise<ApiFile[]> {
  // 走 axios：401 交给全局拦截器统一处理，前端不必到处写登录跳转
  const { data } = await api.get<ApiFile[]>('/files', { params: { scope } })
  return data
}

/** 清空后端对话历史（Redis，按 user + scope 隔离）。 */
export async function clearHistory(scope: string): Promise<void> {
  await api.delete('/history', { params: { scope } })
}
