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

/** 角色枚举（对应后端 ``utils/roles.py`` 与 ``schemas.RoleName``，三处必须一致）。 */
export type RoleName = 'user' | 'authorized_user' | 'admin'

/** GET /auth/me、POST /auth/login 的返回体（对应后端 api/schemas.py 的 UserOut）。 */
export interface ApiUser {
  user_uuid: string
  username: string
  role: RoleName
  /**
   * 能否写入公共库（= 能否上传/删除公共文档）。
   *
   * 由**后端**算好给前端（`UserOut.can_write_public`，与 `deps.resolve_scope` 同一个判断）：
   * 授权规则只留一份，前端据此决定上传目标里给不给"公共库"选项，
   * 不会出现"界面给了选项、点下去才 403"的错位。
   */
  can_write_public: boolean
}

/** POST /auth/login 的请求体（对应 LoginIn）。 */
export interface LoginPayload {
  username: string
  password: string
}

/* ==================== 账户：注册 / 改密码（模块 2） ==================== */

/** POST /auth/register 的请求体（对应 RegisterIn）。 */
export interface RegisterPayload {
  username: string
  password: string
}

/**
 * 改密码请求体（对应后端 ``PasswordChangeIn``）。
 *
 * ``old_password`` 是**必填**：只凭一个已登录的 Cookie 就能改密码，
 * 等于会话被劫持（共享电脑、被抓包）之后账号当场被夺走。
 */
export interface PasswordChangePayload {
  old_password: string
  new_password: string
  confirm_password: string
}

/** 登录页需要的公开开关（对应 AuthConfigOut）。 */
export interface AuthConfig {
  allow_register: boolean
}

/**
 * 取登录页开关。**免登录**接口——登录页自己就要调它。
 *
 * 失败时调用方应**按"关闭"处理**（安全默认）：接口挂了却显示注册入口，
 * 用户填完表单才吃 403，比一开始就不显示更糟。
 */
export async function getAuthConfig(): Promise<AuthConfig> {
  const { data } = await api.get<AuthConfig>('/auth/config')
  return data
}

/** 自助注册。后端默认关闭该通道，关闭时返回 403（文案：自助注册已关闭…）。 */
export async function registerAccount(payload: RegisterPayload): Promise<ApiUser> {
  const { data } = await api.post<ApiUser>('/auth/register', payload)
  return data
}

/**
 * 修改自己的密码。
 *
 * 后端成功后会把该用户的**全部会话**吊销并清掉当前 Cookie，
 * 所以调用方拿到成功响应后**必须**跳登录页——继续留在页面上，
 * 下一个请求就是 401（看起来像"改密码把系统搞坏了"）。
 */
export async function changePassword(
  payload: PasswordChangePayload,
): Promise<{ ok: boolean; message: string }> {
  const { data } = await api.post<{ ok: boolean; message: string }>('/auth/password', payload)
  return data
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

/**
 * **默认**重排模型（与后端 ``utils.rerank.DEFAULT_RERANK_MODEL`` 逐字一致）。
 *
 * 为什么默认 BGE 而不是 MiniLM（2026-10 实测，两个模型都在本机 HF 缓存里直接跑过）：
 *
 * * ``cross-encoder/ms-marco-MiniLM-L-6-v2`` 是**英文** MS MARCO 模型。中文问句实测
 *   raw 分数落在 [-2, +7.2]，且**不相关**的块（5.94）反而高于相关块（2.74）——
 *   "精排"对中文等于随机洗牌（后端有饱和闸门兜底，会退回 RRF 顺序，但白跑一轮精排）；
 * * ``BAAI/bge-reranker-base`` 中文实测区分度极好：相关 0.9993 vs 不相关 0.000037。
 *
 * 注意这里**只改默认值**，不删 MiniLM：英文语料上 MiniLM 又快又准，仍作为备选。
 * 用常量而不是 ``RERANK_MODELS[0]`` 表达默认值：后者会让"调整下拉顺序"这种纯 UI
 * 改动顺手改掉默认模型（默认值应该是一个显式决定，不是一个数组下标）。
 */
export const DEFAULT_RERANK_MODEL: RerankModelName = 'BAAI/bge-reranker-base'

export const RERANK_MODELS: { value: RerankModelName; label: string }[] = [
  { value: DEFAULT_RERANK_MODEL, label: 'bge-reranker-base（中文推荐 · 默认）' },
  {
    value: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
    label: 'ms-marco-MiniLM-L-6-v2（英文通用）',
  },
]

/**
 * 流式问答请求体，对应后端 ``schemas.ChatIn``。
 *
 * ⚠️ 字段名以**后端为准**：是 ``file_uuid``（不是 selected_file_uuid）。
 * ``scope`` 接受 ``"public"``、``"private:<自己的 user_uuid>"`` 或 **``"both"``**（模块 4）；
 * 其余取值会被 ``api/deps.resolve_scope_set`` 判为 400 / 403，前端不该靠猜。
 */
export interface ChatStreamPayload {
  question: string
  scope: string
  enable_rerank: boolean
  rerank_model: RerankModelName
  /** 限定检索单个文件；null / 省略 = 该库全部文件 */
  file_uuid?: string | null
}

/**
 * 引用来源（后端 ``Citation``）。
 *
 * ``scope`` 是模块 4 新增的**库归属**（``public`` / ``private:<uuid>``）：
 * both 模式下同一份文件可能同时存在于两个库，两条引用除了文件名+页码，
 * 还要靠它区分"证据来自哪个库"。老后端不返回该字段 → 可选。
 */
export interface Citation {
  source: string
  page: number
  scope?: string
  /**
   * 这条引用的精排分数（后端 ``_build_citations_and_debug`` 逐条带上）。
   *
   * 可选是因为**老缓存 / 老后端**的引用里没有它：那种情况按"置信度未知"处理，
   * 既不隐藏证据、也不编一个数字出来（与 ``max_score`` 的 ``null`` 同一条原则）。
   */
  rerank_score?: number
  /**
   * 溯源弹窗要用：命中内容来自**哪个文件**（下载原件只认它）。
   *
   * 同样是可选的：老缓存里的引用没有这个字段，那时弹窗如实说"无法定位原件"
   * 并把下载按钮禁用——不拿文件名去猜 uuid（猜错就是下到别人的文档）。
   */
  file_uuid?: string
  /**
   * 这次命中的那段原文（后端截断到 240 字）。
   *
   * 有它，用户点开引用就能看到"证据"本身，而不是只知道"第 12 页"再去翻。
   */
  excerpt?: string
}


/* ==================== 置信度与引用过滤 ==================== */

/**
 * 单条引用的最低可展示分数——与后端 ``api/routers/chat.py:CITATION_THRESHOLD``
 * 同值同义。
 *
 * 后端已经滤过一道（引用列表里不会再有低于它的块），前端这一道是**防御性**的：
 * 用户看到的是界面，界面自己也必须保证"低分块不出现在引用列表里"
 * （老缓存的引用、或别的后端版本漏过滤时，前端不该把噪声原样呈现）。
 */
export const CITATION_THRESHOLD = 0.5

/**
 * 过滤"确实打了分、但分数不够"的引用。
 *
 * 三条规则（顺序即优先级）：
 *   1. 没有分数（老缓存 / 老后端）→ **保留**：宁可显示"置信度未知"，也不藏证据；
 *   2. 分数 ≥ 阈值 → 保留；
 *   3. 分数 < 阈值 → 丢弃。用户实测（2026-10-13）：问"张嘉亮是谁？"时
 *      自动驾驶算法.pdf 与 SAGE AI 问答助手.pdf 的几页只有 0.00004 分，
 *      却因为当时没有任何引用级过滤而被列成了"引用来源"。
 */
export function visibleCitations(citations?: Citation[]): Citation[] {
  return (citations ?? []).filter(
    (c) => typeof c.rerank_score !== 'number' || c.rerank_score >= CITATION_THRESHOLD,
  )
}

/**
 * 置信度文案（两位小数）——**同一个数字曾经表示两种含义**的那次事故的修复。
 *
 * ``1.00`` 在本系统里是"这次没做分数门控"的**哨兵值**（关闭精排时后端给每个块写 1.0），
 * 不是"完美匹配"。真实打分已被后端 ``utils.rerank.MAX_RERANK_SCORE`` 封顶在 0.999，
 * 但 ``(0.999).toFixed(2) === '1.00'``——两位小数的四舍五入会把两者显示成同一个数字，
 * 所以这里再退一格：算出 1.00 时按 0.99 显示（后端拒答文案 ``_format_confidence`` 同口径）。
 *
 * 返回 ``undefined`` = 没有分数（老缓存 / 关闭精排）→ 调用方**不渲染**置信度。
 */
export function formatConfidence(value?: number | null): string | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined
  const shown = Math.min(value, 1).toFixed(2)
  return shown === '1.00' ? '0.99' : shown
}

/**
 * 单条引用的置信度标签（挂在 Tag 的 ``title`` 上，hover 可见）。
 *
 * 哨兵值（``≥ 1``）单独说清楚：它**不是满分**，而是"这次没做分数门控"——
 * 把它显示成"置信度 1.00"会让用户以为是完美匹配（正是本次要消掉的歧义）。
 */
export function citationScoreLabel(score?: number | null): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return '置信度未知'
  if (score >= 1) return '本次未做分数门控'
  return `置信度 ${formatConfidence(score)}`
}

/* ==================== 检索范围（模块 4） ==================== */

/**
 * 检索范围模式。
 *
 * * ``public``  —— 只检公共库；
 * * ``private`` —— 只检自己的私人库（发给后端时展开成 ``private:<自己的 uuid>``）；
 * * ``both``    —— 两个库一起检（后端解析成 ``[public, private:<自己>]``）。
 *
 * 注意 ``both`` **只在只读接口**（问答 / 历史）成立：上传、删除、列文件
 * 必须落到具体库，前端在那些地方要把它展开成一个个具体 scope。
 */
export type ScopeMode = 'public' | 'private' | 'both'

/** 后端认的模式字面量（与 ``api/deps.py`` 的 ``SCOPE_MODE_BOTH`` 逐字一致）。 */
export const SCOPE_MODE_BOTH = 'both'

/** 侧栏三个选项的文案（顺序 = 展示顺序）。 */
export const SCOPE_MODE_LABELS: { value: ScopeMode; label: string }[] = [
  { value: 'public', label: '公共库' },
  { value: 'private', label: '我的私人库' },
  { value: 'both', label: '两者一起（公共库 + 我的私人库）' },
]

/**
 * 把 scope / 模式翻成界面文案（与后端 ``deps.describe_scope`` 同一份口径）。
 *
 * ``private:<uuid>`` 一律显示"我的文档"——**不把 uuid 甩到界面上**：
 * 用户不需要看见它，而一旦显示出来，截图/录屏就会带上别人的 user_uuid。
 */
export function scopeLabel(scope?: string, empty = '—'): string {
  if (!scope) return empty
  if (scope === 'public') return '公共库'
  if (scope === SCOPE_MODE_BOTH) return '公共库 + 我的文档'
  // 多库的**库 key**（缓存/历史用的那种）是 `public+private:<uuid>` 拼起来的：
  // 直接从 key 反推展示名，免得界面上冒出一长串 uuid。
  if (scope.includes('+')) return '公共库 + 我的文档'
  if (scope.startsWith('private:')) return '我的文档'
  return scope
}

/** 一段检索范围列表 → 界面文案（both 模式下后端回的是 ``['public', 'private:<uuid>']``）。 */
export function describeScopes(scopes?: string[]): string {
  if (!scopes || scopes.length === 0) return ''
  if (scopes.length === 1) return scopeLabel(scopes[0])
  return '公共库 + 我的文档'
}

/**
 * "这次因为还是空库被跳过的库" → 界面文案（完整化"检索范围"标注）。
 *
 * 背景（用户实测）：左侧选「两者一起」，气泡上方只显示「检索范围：公共库」——
 * 看起来像"我的文档根本没被检索"的 bug。其实后端 ``meta.skipped_scopes``
 * 已经说明白了（私人库还是空的，被自动跳过），只是前端没把这句话显示出来。
 * 于是把它翻成「（我的私人库为空，已跳过）」挂在检索范围后面：
 * 用户既知道"没查私人库"，也知道"是因为没文档，不是系统坏了"。
 *
 * 文案用"我的私人库"而不是 ``scopeLabel`` 的"我的文档"：这句话是在解释**哪个库没查**，
 * 必须与侧栏选项名（「我的私人库」）逐字对上，用户才能和刚才的选择对上号。
 */
export function describeSkippedScopes(skipped?: string[]): string {
  if (!skipped || skipped.length === 0) return ''
  const names = skipped.map((scope) =>
    scope.startsWith('private:') ? '我的私人库' : scopeLabel(scope),
  )
  return `${names.join('、')}为空，已跳过`
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
  /**
   * 本次**真正检索过**的库（模块 4）：空库已被后端剔除。
   * both 模式下是 ``['public', 'private:<uuid>']``，私人库还是空的时候就只剩 ``['public']``。
   */
  scopes?: string[]
  /** 因为还是空库被跳过的库（排障用）：有它就说明"不是没搜到，是那个库还没有文档"。 */
  skipped_scopes?: string[]
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
  /** 本次真正检索过的库（模块 4）；老后端不返回 → 可选，前端回落用 ``scopeLabel(scope)``。 */
  scopes?: string[]
  cached: boolean
  /**
   * 检索最高分。命中缓存时是**首次回答**的原始分数（后端从缓存里回放）。
   * 老缓存（本次改造前写入）没存分数，后端发 ``null`` —— 此时不渲染置信度，
   * 绝不退化成"命中缓存 = 1.00"。
   */
  max_score: number | null
  refused: boolean
  /**
   * 问题归一化后的 SHA-1（模块 6）——👍/👎 的**幂等键**。
   *
   * 由后端算（与 ``POST /feedback`` 判重用的是同一个哈希），前端只负责拿它当 key：
   * 在浏览器里自己实现一套"归一化 + SHA-1"的话，两份实现漂移的表现是
   * "反馈过了按钮还能点，点了又插一行"。老后端不返回 → 可选，退回用消息 id 兜底。
   */
  q_hash?: string
}

/**
 * fetch 型请求（流式问答、文件上传）的失败：HTTP 非 2xx。
 *
 * 为什么这两个接口不用上面那个 axios 实例：流式要增量响应、上传要 multipart，
 * 在浏览器端都更适合 fetch。代价是拿不到全局 401 拦截器，
 * 所以错误对象自带 ``status``，由调用方显式判断"是不是会话过期了"。
 */
export class FetchHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'FetchHttpError'
    this.status = status
  }
}

/** 流式接口的失败（继承自 FetchHttpError，401 的处理与上传共用一套）。 */
export class ChatStreamError extends FetchHttpError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'ChatStreamError'
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

/* ==================== 文件管理 + 下载（模块：文件管理） ==================== */

/** 文件管理面板的一项（后端 ``LibraryFileOut``）。 */
export interface ApiLibraryFile {
  file_uuid: string
  file_name: string
  /** 所在库：``public`` / ``private:<uuid>`` */
  scope: string
  /** 库的中文名（公共库 / 我的文档）——由后端给，前端不重写一份映射 */
  scope_label: string
  owner_uuid: string
  /** 上传人用户名；账号已被清理时是空串（界面显示"—"） */
  owner_username: string
  /**
   * 同名文件的第几个版本（1 基，``file_dedup.version``，模块 5）。
   * 是**库里记着的**事实，不是前端按列表顺序数出来的。
   */
  version: number
  /**
   * 是否历史版本（已被同名新版取代）。
   *
   * 默认列表（``include_archived=false``）里恒为 ``false``——打开「显示历史版本」
   * 才会出现 ``true`` 的行，界面据此把它标灰并挂「历史版本」标签。
   */
  archived: boolean
  updated_at: string | null
  /** 原件大小；``null`` = 原件不在（改造前上传的文件） */
  size_bytes: number | null
  /** 原件是否还在磁盘上：``false`` 时禁用下载按钮并说明原因 */
  downloadable: boolean
  /**
   * 能不能删这一行（2026-10-13 验收新增）。**后端按会话算好的布尔值**：
   * 公共库看角色（admin / authorized_user 可删），私人库只看是不是自己的库。
   *
   * 前端只读它、不自己判角色——授权规则只留一份，否则会出现"界面给了删除按钮、
   * 点下去才 403"（或反过来：有权限却没入口）。它只决定**给不给按钮**，
   * 删除接口自己还会再判一次，所以拿到 true 也不代表绕过服务端校验。
   */
  can_delete: boolean
}

/**
 * 列出"我能看到的原件"：公共库 + **我自己的**私人库。
 *
 * 为什么不传 scope：查哪两个库由后端按会话决定（``private_scope(user)`` 永远只拼当前用户），
 * 前端传什么都改不了这个事实。这样"别人的私人库"不是靠界面不显示，而是后端根本没查。
 *
 * ``includeArchived``（模块 5）：面板的「显示历史版本」开关。历史版本的权限与最新版本
 * **完全一致**（后端同一套规则），所以它只是一个"要不要看"的开关，不是权限开关。
 */
export async function listLibraryFiles(includeArchived = false): Promise<ApiLibraryFile[]> {
  const { data } = await api.get<ApiLibraryFile[]>('/files/library', {
    params: { include_archived: includeArchived },
  })
  return data
}

/**
 * 从 ``Content-Disposition`` 里取回原始文件名。
 *
 * 中文名走后端的 RFC 5987 形式（``filename*=UTF-8''%E6%89%8B%E5%86%8C.pdf``），
 * 纯 ASCII 名是 ``filename="a.pdf"`` —— 两种都要认，否则中文文件会以"download"落盘。
 * 都取不到时回落到调用方已知的 ``file_name``（我们自己本来就记着原名）。
 */
export function filenameFromContentDisposition(
  header: string | null,
  fallback: string,
): string {
  if (!header) return fallback
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim())
    } catch {
      // 编码异常 → 落到下面的普通形式/兜底
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  return plain?.[1]?.trim() || fallback
}

/* ==================== 删除文件（文件管理） ==================== */

/**
 * 删除一个文件：MySQL 记录 + ES 父子块 + Chroma 向量 + 留存原件，服务端一次清干净。
 *
 * ``scope`` 必须是**这一行所在的库**（``ApiLibraryFile.scope``）：删除接口按
 * ``(库, file_uuid)`` 定位记录，传错库只会得到 404 —— 那不是"删掉了"，是"没找到"。
 *
 * 权限由后端判（普通用户删公共库文件 → 403），前端只管调用与提示：拿到 ``can_delete``
 * 才渲染按钮，但**按钮存在不等于绕过校验**（直接构造请求仍会被拒）。
 */
export async function deleteFile(file: {
  file_uuid: string
  scope: string
}): Promise<{ ok: boolean; message: string }> {
  const { data } = await api.delete<{ ok: boolean; message: string }>(
    `/files/${file.file_uuid}`,
    { params: { scope: file.scope } },
  )
  return data
}

/**
 * 删除失败的文案（验收清单要求逐字给：403 / 404 / 500 三档）。
 *
 * 为什么不直接用 ``extractErrorMessage``（它会原样回后端的中文 ``detail``）：
 * 删除公共库的 403 文案来自 ``resolve_scope``，那句是**上传**口径（"…可以写入公共库…
 * 如需上传到公共库请联系管理员授权"），删除场景下让人看不懂。
 * 其余状态（网络断了 / 其它 4xx）仍然落回 ``extractErrorMessage``，不吞掉后端的解释。
 */
export function deleteFileErrorMessage(err: unknown): string {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined
  if (status === 403) return '无权限删除该文件'
  if (status === 404) return '文件不存在，可能已被删除'
  if (status === 500) return '删除失败，请稍后重试'
  return extractErrorMessage(err, '删除失败，请稍后重试')
}

/**
 * 下载原件。
 *
 * 为什么不用 ``<a href="/api/files/<uuid>/download">`` 直接让浏览器去取：
 * 401/403/404 时后端回的是 JSON，浏览器会**导航到那串 JSON** ——
 * 用户看到满屏 ``{"detail":"无下载权限，请联系管理员"}``，而且回不去原页面。
 * 这里改成先 fetch：
 *   * 失败 → 抛 ``FetchHttpError``（带后端中文文案），调用方弹提示，页面不动；
 *   * 成功 → 用响应里的文件名生成 blob 下载。
 * 会话在 HttpOnly Cookie 里，所以 ``credentials: 'include'`` 不能少。
 *
 * 文件上限 20MB（后端 ``max_upload_mb``），整块读进内存完全可接受；
 * 换来的是"任何失败都能给出一句人话说清楚"。
 */
export async function downloadFile(file: {
  file_uuid: string
  file_name: string
}): Promise<void> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(file.file_uuid)}/download`,
    { credentials: 'include' },
  )
  if (!response.ok) {
    throw new FetchHttpError(response.status, await readErrorDetail(response))
  }

  const blob = await response.blob()
  const name = filenameFromContentDisposition(
    response.headers.get('content-disposition'),
    file.file_name,
  )
  saveBlobAsDownload(blob, name)
}

/**
 * 把一段内存里的内容存成本地文件（``<a download>`` + blob URL）。
 *
 * 抽出来是因为**下载**与**预览降级**的最后一步都要它：两条路径的落盘行为必须是同一个，
 * 否则会出现"预览降级下下来的文件名不对"这种只在某条路径上复现的问题。
 */
function saveBlobAsDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // 立刻回收：blob URL 在页面卸载前会一直占着这块内存
    URL.revokeObjectURL(url)
  }
}

/** ``Content-Disposition`` 是不是 ``inline``（浏览器内置查看器要的只有这一件事）。 */
function isInlineDisposition(header: string | null): boolean {
  return /^\s*inline\b/i.test(header ?? '')
}

/** 预览结果：``preview`` = 已在新标签页里打开；``download`` = 降级成下载了。 */
export type PreviewOutcome = 'preview' | 'download'

/**
 * 在线预览原件（新标签页打开；PDF 支持 ``#page=N``，直接跳到引用所在的那一页）。
 *
 * 为什么仍然走 ``fetch``，而不是 ``window.open('/api/files/<uuid>/preview')``：
 * 401/403/404 时后端回的是 JSON，直接导航过去用户会看到满屏 JSON 且回不去原页面
 * （与 ``downloadFile`` 同一个理由）。先拿字节，再决定"内嵌打开"还是"落盘"。
 *
 * **该不该内嵌由后端说了算**：响应的 ``Content-Disposition`` 是 ``inline`` 才开新标签页，
 * 是 ``attachment`` 就降级成下载。后端对 HTML/SVG 这类能被当页面渲染的类型只会给
 * ``attachment``（blob URL 继承本站 origin，内嵌它们等于让上传者在本站执行脚本）。
 * 前端**不**维护第二份类型名单——两边各判一份，迟早出现"前端放行、后端本意是下载"。
 *
 * 还有两种情况会自动降级成下载，都返回 ``'download'`` 让调用方给一句说明：
 *   * 浏览器拦了新标签页（``window.open`` 返回 null）——别让用户"点了没反应"；
 *   * 后端判定该文件不该内嵌（``attachment``，如 Word / Excel / HTML）。
 *
 * 探测不到的边界：浏览器自己的查看器打不开某些 PDF（损坏 / 加密）时会在那个标签页里报错，
 * 前端无从得知——所以调用方旁边始终保留「下载原文」作为兜底。
 */
export async function previewFile(
  file: { file_uuid: string; file_name: string },
  page?: number | null,
): Promise<PreviewOutcome> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(file.file_uuid)}/preview`,
    { credentials: 'include' },
  )
  if (!response.ok) {
    throw new FetchHttpError(response.status, await readErrorDetail(response))
  }

  const blob = await response.blob()
  const name = filenameFromContentDisposition(
    response.headers.get('content-disposition'),
    file.file_name,
  )

  if (!isInlineDisposition(response.headers.get('content-disposition'))) {
    saveBlobAsDownload(blob, name)
    return 'download'
  }

  const url = URL.createObjectURL(blob)
  // ``#page=N`` 是给浏览器 PDF 查看器的：页码由前端从引用里带过来，后端不需要多收参数。
  const target = page && page > 0 ? `${url}#page=${page}` : url
  const opened = window.open(target, '_blank')
  if (!opened) {
    // 弹窗被拦（或用户禁用了新窗口）→ 别让这次点击白费，直接落盘
    URL.revokeObjectURL(url)
    saveBlobAsDownload(blob, name)
    return 'download'
  }
  // **不能**立刻回收：新标签页还在读这个 blob，早回收就是一个白屏标签页。
  // 60s 足够加载完，之后释放（blob URL 在页面卸载前会一直占着这块内存）。
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'preview'
}

/** 人类可读的文件大小（不知道就显示"—"，不显示 "NaN B"）。 */
export function formatFileSize(bytes?: number | null): string {
  if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}


/** 清空后端对话历史（Redis，按 user + scope 隔离）。 */
export async function clearHistory(scope: string): Promise<void> {
  await api.delete('/history', { params: { scope } })
}

/* ============================ 文件上传（模块 3） ============================ */

/** 上传结果（后端 ``UploadOut``）。 */
export interface UploadResult {
  ok: boolean
  message: string
  file_uuid?: string | null
  duplicate: boolean
  /** 本次入库的版本号（模块 5）：同名文件重传时是 旧版本 + 1 */
  version?: number | null
}

/**
 * 上传文档到指定库（multipart）。
 *
 * 权限（模块 3）：``scope="public"`` 需要 ``can_write_public``（admin / authorized_user），
 * 普通用户只能传 ``private:<自己>``，否则后端 403（文案里已写明"请联系管理员授权"）。
 *
 * 为什么用 fetch 而不是本文件那个 axios 实例：实例默认 `Content-Type: application/json`，
 * 而 axios 在"JSON 内容类型 + FormData"这条分支上会**把 FormData 转成 JSON**——
 * 后端于是收到一个没有 multipart boundary 的请求体，报"字段缺失"（极难排查）。
 * fetch 让浏览器自己带 boundary；另外解析入库可能几十秒，也不该受 30s 全局超时限制。
 */
export async function uploadFile(scope: string, file: File): Promise<UploadResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('scope', scope)

  const response = await fetch('/api/files/upload', {
    method: 'POST',
    body: form,
    credentials: 'include',
  })

  if (!response.ok) {
    throw new FetchHttpError(response.status, await readErrorDetail(response))
  }
  return (await response.json()) as UploadResult
}

/* ===================== 管理端：账号与角色授权（模块 3） ===================== */

/** 账号列表项（后端 ``AdminUserOut``，**不含**密码哈希）。 */
export interface ApiAdminUser {
  user_uuid: string
  username: string
  role: RoleName
  is_active: boolean
  created_at: string | null
}

/** 角色下拉文案：与后端能力一一对应，避免"授权"这个词在不同地方含义不同。 */
export const ROLE_LABELS: Record<RoleName, string> = {
  user: '普通用户（仅私人库可写）',
  authorized_user: '已授权用户（可写公共库）',
  admin: '管理员（全部权限）',
}

/** 列出全部账号（仅管理员；普通/已授权用户都会拿到 403）。 */
export async function listUsers(): Promise<ApiAdminUser[]> {
  const { data } = await api.get<ApiAdminUser[]>('/admin/users')
  return data
}

/**
 * 修改他人角色（仅管理员）。
 *
 * 后端改完会**吊销目标用户的全部会话**（会话里存的是登录那一刻的角色，
 * 不吊销的话"降级"要等对方重新登录才生效），所以对方下一次请求会 401 重新登录。
 * 返回值是目标账号的最终状态，调用方可以直接用它刷新列表里那一行。
 */
export async function setUserRole(
  userUuid: string,
  role: RoleName,
): Promise<ApiAdminUser> {
  const { data } = await api.put<ApiAdminUser>(`/admin/users/${userUuid}/role`, { role })
  return data
}

/* ==================== 反馈飞轮（模块 6） ==================== */

/** 评价方向（后端 ``FeedbackIn.rating``）。 */
export type FeedbackRating = 'up' | 'down'

/**
 * 一条反馈（后端 ``FeedbackIn``）。
 *
 * ``q_hash`` **不在请求体里**：哈希由服务端算（它才是判重的那一份），
 * 前端只回传 ``done`` 事件带回来的那个 key 用于本地标记「已反馈」。
 */
export interface FeedbackPayload {
  /** 当前检索模式（``public`` / ``private:<uuid>`` / ``both``）——后端会再校验一次 */
  scope: string
  question: string
  rewritten_question?: string | null
  answer?: string | null
  citations?: Citation[]
  rating: FeedbackRating
  /** 差评原因（如「资料缺失」+ 用户补充说明） */
  reason?: string | null
  file_uuid_filter?: string | null
}

/** ``POST /feedback`` 的返回：服务端算好的 ``q_hash`` + 这次是新建还是更新。 */
export interface ApiFeedbackResult {
  ok: boolean
  message: string
  q_hash: string
  updated: boolean
}

/**
 * 提交反馈（👍/👎、「资料缺失/建议反馈」共用这一个入口）。
 *
 * 幂等由后端保证（同一用户对同一问题在防重窗口内只留一条），所以前端**不需要**
 * 做"先查有没有提交过"的额外请求；拿到返回的 ``q_hash`` 标记本地状态即可。
 */
export async function submitFeedback(payload: FeedbackPayload): Promise<ApiFeedbackResult> {
  const { data } = await api.post<ApiFeedbackResult>('/feedback', payload)
  return data
}

/** 一次高频提问 / 无结果提问（后端 ``TopQuestionOut``）。 */
export interface ApiTopQuestion {
  question: string
  count: number
  last_at: string | null
}

/** 被检索最多的文档（后端 ``TopDocumentOut``）。``file_name`` 空串 = 文件已被删除。 */
export interface ApiTopDocument {
  file_uuid: string
  file_name: string
  hits: number
}

export interface ApiFeedbackScopeStat {
  scope: string
  up: number
  down: number
}

export interface ApiFeedbackSummary {
  total: number
  up: number
  down: number
  /** 好评率（0~1）；``null`` = 还没有任何反馈——**不是** 0% */
  up_rate: number | null
  by_scope: ApiFeedbackScopeStat[]
  top_reasons: { reason: string; count: number }[]
}

/** 运营看板（后端 ``AdminStatsOut``）。 */
export interface ApiAdminStats {
  generated_at: string
  window: number
  retrieval_total: number
  top_questions: ApiTopQuestion[]
  no_result_queries: ApiTopQuestion[]
  top_documents: ApiTopDocument[]
  feedback_summary: ApiFeedbackSummary
}

/**
 * 运营看板统计（仅管理员）。
 *
 * ``window`` 是"统计最近多少次检索"（后端默认 5000，且下限 50）：
 * 看板看的是最近的运营状况，不是全表历史——真要拉长窗口，接口会如实回它用的值。
 */
export async function getAdminStats(window?: number): Promise<ApiAdminStats> {
  const { data } = await api.get<ApiAdminStats>('/admin/stats', {
    params: window ? { window } : undefined,
  })
  return data
}

/** 差评样本（后端 ``BadCaseOut``；仅管理员）。 */
export interface ApiBadCase {
  id: number
  user_uuid: string
  scope: string
  question: string
  answer: string | null
  rating: string
  reason: string | null
  created_at: string | null
}

export async function listBadCases(limit = 20): Promise<ApiBadCase[]> {
  const { data } = await api.get<ApiBadCase[]>('/feedback/bad-cases', { params: { limit } })
  return data
}
