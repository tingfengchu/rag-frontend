import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Input,
  Layout,
  Radio,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  Upload,
} from 'antd'

import {
  ChatStreamError,
  DEFAULT_RERANK_MODEL,
  FetchHttpError,
  RERANK_MODELS,
  ROLE_LABELS,
  SCOPE_MODE_BOTH,
  SCOPE_MODE_LABELS,
  SSEChat,
  api,
  citationScoreLabel,
  clearHistory,
  describeScopes,
  describeSkippedScopes,
  extractErrorMessage,
  formatConfidence,
  listFiles,
  listUsers,
  scopeLabel,
  setUserRole,
  submitFeedback,
  uploadFile,
  visibleCitations,
} from '../api/client'
import type {
  ApiAdminUser,
  ApiFile,
  ChatDoneResult,
  ChatMeta,
  Citation,
  FeedbackRating,
  RerankModelName,
  RoleName,
  ScopeMode,
} from '../api/client'
import ChangePasswordModal from '../components/ChangePasswordModal'
import FeedbackModal from '../components/FeedbackModal'
import FileManagerPanel from '../components/FileManagerPanel'
import SourceTraceModal from '../components/SourceTraceModal'
import { useAuthUser } from '../components/RequireAuth'

const { Header, Sider, Content } = Layout

/** 打字机的刷新间隔：16ms ≈ 60fps，看起来就是"一个字一个字蹦出来"。 */
const TYPE_TICK_MS = 16

/** 顶栏的角色徽标（短文案；下拉里的长文案见 client.ts 的 ROLE_LABELS）。 */
const ROLE_BADGE: Record<RoleName, string> = {
  user: '普通用户',
  authorized_user: '已授权用户',
  admin: '管理员',
}

/**
 * 一条消息。
 *
 * AI 消息把流里收到的所有元信息都挂在同一条记录上，渲染时不用再去别处查表。
 * 用 ``id`` 定位更新（而不是数组下标）是必须的：打字机以 60fps 追加文本，
 * 一旦中间发生插入/清空，下标就全错了。
 */
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 仍在收流 → 文本末尾显示闪烁光标 */
  streaming?: boolean
  /** 一个 token 都还没到 → 显示"AI 正在思考..." */
  thinking?: boolean
  /** 改写后的问题（仅当后端标记 rewritten=true 才展示） */
  rewritten?: string
  citations?: Citation[]
  cached?: boolean
  refused?: boolean
  /**
   * 本题实际检索过的库（模块 4，来自 meta / done 事件）。
   * both 模式下是 `['public', 'private:<uuid>']`；私人库还是空的时候就只剩 `['public']`。
   */
  scopes?: string[]
  /**
   * 因为还是空库、这次被后端跳过的库（同样来自 meta）——`['private:<uuid>']`。
   *
   * 有它就必须在"检索范围"后面补一句"（我的私人库为空，已跳过）"：
   * 否则用户看到"检索范围：公共库"会以为自己的文档根本没被检索（实测反馈的 UI 问题）。
   */
  skippedScopes?: string[]
  /** 库 key（`public` / `private:<uuid>` / `public+private:<uuid>`），仅用于兜底显示。 */
  scopeKey?: string
  /** 检索最高分；命中缓存时是**首次回答**的原始分数（老缓存没存 → undefined，不渲染） */
  maxScore?: number
  /** 流内 error 事件，或请求本身失败的原因 */
  error?: string
  /** 用户主动点了"停止" */
  stopped?: boolean
  /**
   * 这条回答对应的问题（模块 6，反馈要用）。
   *
   * 提问时就在本地记下（来自输入框），meta / done 事件到了再覆盖一次：
   * 流中途失败时 done 不会到，但反馈按钮不该因为"拿不到问题"就消失。
   */
  question?: string
  /**
   * 这条回答对应问题的 q_hash（模块 6，来自 ``done`` 事件）。
   *
   * 👍/👎 的**幂等键**：后端 ``POST /feedback`` 判重用的是同一个哈希，
   * 所以"标记已反馈"与"服务端判重"永远指的是同一条记录。
   * 老后端不返回 → 退回用消息 ``id`` 兜底（此时只保证同一次会话内不重复提交）。
   */
  qHash?: string
  /**
   * 提问时用的 scope **原串**（``public`` / ``private:<uuid>`` / ``both``）。
   *
   * 反馈回传要用它，而不是 ``scopeKey``（多库时后者是 ``public+private:<uuid>``
   * 这种内部 key）——后端的 ``resolve_scope_set`` 只认那三个字面量，
   * 把内部 key 传过去会 400（"scope 非法"）。
   */
  scopeRequest?: string
}

/** 把流式请求的异常翻成中文。fetch 的异常不是 axios 错误，extractErrorMessage 在 here 用不上。 */
function describeStreamError(err: unknown): string {
  if (err instanceof ChatStreamError) return err.message
  if (err instanceof TypeError) return '无法连接服务器，请确认后端已启动'
  return '流式问答失败，请稍后重试'
}

/**
 * 反馈的幂等键（模块 6）：优先用后端 ``done`` 事件给的 ``q_hash``。
 *
 * 为什么优先 q_hash 而不是消息 id：q_hash 与后端判重用的是**同一个哈希**，
 * 于是"界面标记已反馈"和"服务端只会留一条记录"指的是同一件事。
 * 消息 id 只是本地序号，老后端（不返回 q_hash）时用它兜底——
 * 那时只保证同一次会话里不重复提交。
 */
function feedbackKey(msg: ChatMessage): string {
  return msg.qHash ?? `msg:${msg.id}`
}

/** AI 气泡下方的状态标签 + 引用来源。 */
function MessageFooter({
  msg,
  onOpenSource,
  onRate,
  busyRating,
  ratedRating,
}: {
  msg: ChatMessage
  onOpenSource: (citation: Citation) => void
  /** 点 👍/👎（模块 6）——由 ChatPage 提交，弹窗/提示都在那一层 */
  onRate: (rating: FeedbackRating) => void
  /** 正在提交的评价方向（按钮转圈；同一时刻只会有一个） */
  busyRating: FeedbackRating | null
  /** 已提交的评价方向；有值就一直显示「已反馈」 */
  ratedRating?: FeedbackRating
}) {
  /**
   * 防御性过滤（P0）：**低于阈值的引用不上屏**。
   *
   * 后端 ``_build_citations_and_debug`` 已经滤过一道，这里再滤一次的理由是
   * "用户看到的是界面"：命中老缓存（引用里没分数）、或后端版本回退时，
   * 前端不该把 0.00004 分的陪跑块原样显示成"引用来源"——那正是用户报的现象。
   * 没有分数的引用**保留**（显示"置信度未知"），隐藏证据比显示噪声更糟。
   */
  const citations = visibleCitations(msg.citations)
  const hasMeta = Boolean(msg.cached) || Boolean(msg.refused) || typeof msg.maxScore === 'number'
  /**
   * 能不能评价（模块 6）：只有**已定稿的回答**才评。
   *
   * 打字期间（``streaming`` / ``thinking``）答案还没写完，此时提交等于给半截答案打分；
   * 出错时（``error``）这次问答本身失败了，用户该做的是重试而不是评价——
   * 那种 👎 会被统计成"答得不好"，而真因是服务出错，会污染运营判断。
   */
  const canRate = !msg.streaming && !msg.thinking && !msg.error
  if (!hasMeta && citations.length === 0 && !canRate) return null

  return (
    <div style={{ marginTop: 6 }}>
      {hasMeta && (
        <Space size={4} wrap>
          {msg.cached && <Tag color="gold">命中缓存</Tag>}
          {msg.refused && <Tag color="red">模型拒答</Tag>}
          {typeof msg.maxScore === 'number' && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {/* 走 formatConfidence：0.999 不许显示成 1.00（1.00 是"没做分数门控"的哨兵值） */}
              {msg.cached ? '缓存原始置信度' : '最高置信度'} {formatConfidence(msg.maxScore)}
            </Typography.Text>
          )}
        </Space>
      )}

      {citations.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            引用来源：
          </Typography.Text>
          <Space size={4} wrap>
            {citations.map((c) => (
              <Tag
                key={`${c.scope ?? ''}#${c.source}#${c.page}`}
                color="blue"
                data-testid="citation-tag"
                // 可点击 = 打开「引用出处」弹窗（文件名 / 页码 / 置信度 / 摘录 / 下载原文）。
                // 光标改成 pointer 是必须的：Tag 默认不是链接样式，不改的话没人知道它能点。
                style={{ cursor: 'pointer' }}
                // hover 显示这一条的分数 + 点击后能做什么（分数不够的已被过滤，看不到的就不是证据）；
                // 老缓存没有分数 → "置信度未知"，不编数字。
                title={`${citationScoreLabel(c.rerank_score)}；点击查看出处并下载原文`}
                onClick={() => onOpenSource(c)}
              >
                {c.source} · 第 {c.page} 页
                {/*
                  库标注（模块 4）：只在"这次确实查了不止一个库"或"这条引用的库与主库不同"时显示。
                  单选一个库时每条引用都挂"（公共库）"只是噪音；而 both 模式下不显示就分不清
                  两份同名文件里哪条来自我的私人库。
                */}
                {(msg.scopes?.length ?? 0) > 1 && c.scope ? `（${scopeLabel(c.scope)}）` : ''}
              </Tag>
            ))}
          </Space>
          {/* 点一下能做什么，得写出来：Tag 长得像标签，不像按钮 */}
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
            （可点击查看出处）
          </Typography.Text>
        </div>
      )}

      {/*
        👍/👎（模块 6）：反馈飞轮的入口。
        提交后这里换成「已反馈」——按钮留在原地但不可再点（用文字而不是禁用按钮：
        禁用的按钮既不能说清"已经评过了"，还会让人以为是页面卡住）。
      */}
      {canRate && (
        <div style={{ marginTop: 4 }} data-testid="answer-feedback">
          {ratedRating ? (
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12 }}
              data-testid="feedback-done"
            >
              已反馈 {ratedRating === 'up' ? '👍' : '👎'}（同一个问题只记一次，感谢反馈）
            </Typography.Text>
          ) : (
            <Space size={0}>
              <Button
                type="text"
                size="small"
                loading={busyRating === 'up'}
                disabled={busyRating !== null}
                onClick={() => onRate('up')}
                data-testid="feedback-up"
              >
                👍 有帮助
              </Button>
              <Button
                type="text"
                size="small"
                loading={busyRating === 'down'}
                disabled={busyRating !== null}
                onClick={() => onRate('down')}
                data-testid="feedback-down"
              >
                👎 没帮助
              </Button>
            </Space>
          )}
        </div>
      )}
    </div>
  )
}

/** 一个消息气泡：用户靠右（蓝底白字）、AI 靠左（白底带边框）。 */
function MessageBubble({
  msg,
  onOpenSource,
  onRate,
  busyRating,
  ratedRating,
}: {
  msg: ChatMessage
  onOpenSource: (citation: Citation) => void
  onRate: (rating: FeedbackRating) => void
  busyRating: FeedbackRating | null
  ratedRating?: FeedbackRating
}) {
  const isUser = msg.role === 'user'
  /**
   * 「检索范围：xxx」（模块 4）。
   *
   * 优先用后端给的**实际检索过的库列表**（`scopes`）——它会把"还是空库、这次没检"
   * 如实排除掉；老后端只回 `scope` 这个 key 时退回文案翻译。
   */
  const scopeText = msg.scopes?.length
    ? describeScopes(msg.scopes)
    : msg.scopeKey
      ? scopeLabel(msg.scopeKey)
      : ''
  /**
   * 空库提示（UI 修复）：`skipped_scopes` 非空 → 「检索范围：公共库（我的私人库为空，已跳过）」。
   * 文案拼装见 `client.describeSkippedScopes`（含"为什么用私人库这个词"的说明）。
   */
  const skippedText = describeSkippedScopes(msg.skippedScopes)

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 12,
      }}
    >
      <div style={{ maxWidth: '78%', minWidth: 0 }}>
        {msg.rewritten && (
          <Alert
            type="info"
            showIcon
            title={`已重写为：${msg.rewritten}`}
            style={{ marginBottom: 6 }}
          />
        )}

        {!isUser && scopeText && (
          <div style={{ marginBottom: 4 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              检索范围：{scopeText}
              {skippedText ? `（${skippedText}）` : ''}
            </Typography.Text>
          </div>
        )}

        <div
          style={{
            background: isUser ? '#1677ff' : '#ffffff',
            color: isUser ? '#ffffff' : 'rgba(0, 0, 0, 0.88)',
            border: isUser ? '1px solid transparent' : '1px solid #f0f0f0',
            borderRadius: 12,
            padding: '10px 14px',
            lineHeight: 1.7,
            // 回答里的换行/缩进要原样保留，长英文串要能断行（否则撑破气泡）
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {msg.thinking ? (
            <Space size={8}>
              <Spin size="small" />
              AI 正在思考...
            </Space>
          ) : (
            <>
              {msg.content}
              {msg.streaming && <span className="chat-cursor">▍</span>}
            </>
          )}
        </div>

        {msg.error && <Alert type="error" showIcon title={msg.error} style={{ marginTop: 6 }} />}
        {msg.stopped && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            （已停止生成）
          </Typography.Text>
        )}
        {!isUser && (
          <MessageFooter
            msg={msg}
            onOpenSource={onOpenSource}
            onRate={onRate}
            busyRating={busyRating}
            ratedRating={ratedRating}
          />
        )}
      </div>
    </div>
  )
}

/**
 * 聊天页：SSE 流式问答。
 *
 * 数据流：
 *   Input → ``SSEChat()``（fetch + credentials:include）→ ``reader.read()`` 逐块 decode
 *   → 按空行切 SSE 帧 → ``event:`` 名分流 → 文本进"打字机缓冲" → 定时器逐字吐到界面。
 *
 * 为什么要一层打字机缓冲（而不是直接把 token 写进 state）：
 * 网络分片是"一阵一阵"的（一次可能送来 200 个字符），直接写就是"一大块一大块"地闪，
 * 那不是打字机。缓冲把**到达节奏**（网络）与**展示节奏**（视觉）解耦；
 * 且积压越多一次吐越多，所以模型早早说完也不会让界面慢慢追半天。
 *
 * 用户名不自己再发一次请求，而是读守卫已经探测好的上下文——一个 /auth/me，
 * 没有重复的 401 竞争。
 */
export default function ChatPage() {
  const navigate = useNavigate()
  // antd v6：message 用 App.useApp() 取（静态 message.error 已 deprecated）
  const { message } = AntdApp.useApp()
  const user = useAuthUser()

  // ---------------- 顶栏 ----------------
  const [loggingOut, setLoggingOut] = useState(false)
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)

  // ---------------- 侧栏（检索设置） ----------------
  /**
   * 检索范围（模块 4）。
   *
   * 默认 **both**（公共库 + 我的私人库一起检）：新用户的私人库是空的，
   * 老默认"公共库"会让"我自己传的文档怎么搜不到"成为必踩的坑；
   * both 模式下空库会被后端自动跳过（`skipped_scopes`），所以对空私人库的用户来说
   * 等价于只查公共库，不会平白报错。
   */
  const [scopeKind, setScopeKind] = useState<ScopeMode>('both')
  const [files, setFiles] = useState<ApiFile[]>([])
  const [fileFilter, setFileFilter] = useState<string | null>(null)
  const [enableRerank, setEnableRerank] = useState(true)
  /**
   * 重排模型默认值：**BGE-reranker-base**（`DEFAULT_RERANK_MODEL`），MiniLM 保留为备选。
   *
   * 用常量而不是 `RERANK_MODELS[0].value`：默认模型是一个要解释的决定（中文语料上
   * MiniLM 实测无区分度，见 client.ts 的说明），不该由"下拉里谁排第一"这种 UI 细节决定。
   */
  const [rerankModel, setRerankModel] = useState<RerankModelName>(DEFAULT_RERANK_MODEL)
  /** 已经加载完成的 scope：用它推导 loading，避免"切库瞬间显示上一个库的文件列表" */
  const [loadedScope, setLoadedScope] = useState<string | null>(null)

  // ---------------- 侧栏（上传 / 用户授权，模块 3） ----------------
  /** 文件列表重拉计数：上传成功后 +1，列表 effect 依赖它 → 新文件立刻出现在下拉里。 */
  const [filesReloadKey, setFilesReloadKey] = useState(0)
  /**
   * 正在查看出处的引用（``null`` = 弹窗关闭）。
   *
   * 放在 ChatPage 而不是 MessageFooter：弹窗是**页面级**的浮层，
   * 若挂在气泡里，流式更新触发重渲染时弹窗会被连带重建（打字机阶段尤其明显）。
   */
  const [traceCitation, setTraceCitation] = useState<Citation | null>(null)
  /**
   * 已经反馈过的回答（模块 6）：key = ``q_hash``，value = 评价方向。
   *
   * 只放内存：它表示"这次会话里我评过没有"，刷新后重新开始是合理的
   * （真正的防重在后端——同一个用户对同一个问题在防重窗口内只会留一条记录）。
   */
  const [rated, setRated] = useState<Record<string, FeedbackRating>>({})
  /** 正在提交的反馈（key + 方向）：只让那一个按钮转圈，不锁整页 */
  const [busyFeedback, setBusyFeedback] = useState<{
    key: string
    rating: FeedbackRating
  } | null>(null)
  /** 「资料缺失/建议反馈」弹窗是否打开 */
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false)
  /**
   * 上传目标库。默认**私人库**（而不是公共库）：公共库是全站共享的，
   * 默认把它设为写入目标，"手一抖传错东西"的代价由所有人承担。
   */
  const [uploadTarget, setUploadTarget] = useState<'public' | 'private'>('private')
  const [uploading, setUploading] = useState(false)
  /** 管理端账号列表；非管理员恒为 null（一个请求都不会发出去）。 */
  const [adminUsers, setAdminUsers] = useState<ApiAdminUser[] | null>(null)

  // ---------------- 对话 ----------------
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)

  // ---------------- 流 / 打字机的可变状态：放 ref，避免每次 read 都触发重渲染 ----------------
  const abortRef = useRef<AbortController | null>(null)
  /** 已收到但还没"打"出来的文本 */
  const pendingRef = useRef('')
  const tickerRef = useRef<number | null>(null)
  /** 流已结束（done / error / 失败 / 用户停止）→ 缓冲排空后收尾 */
  const streamEndedRef = useRef(false)
  /** done 事件的完整答案：最后用来校准逐 token 拼接的结果 */
  const finalRef = useRef<ChatDoneResult | null>(null)
  const idSeqRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  /**
   * 实际发给后端的 scope（模块 4）。
   *
   * * `public`  → `public`
   * * `private` → `private:<自己的 uuid>`（uuid 来自守卫给的会话信息，前端不猜）
   * * `both`    → `both`：**只在只读接口成立**（问答 / 历史 / 反馈）。
   *   列文件、上传、删除这些必须落到"某个具体库"的地方要用 `scopeList` 展开。
   */
  const scopeValue =
    scopeKind === 'public'
      ? 'public'
      : scopeKind === 'private'
        ? `private:${user.user_uuid}`
        : SCOPE_MODE_BOTH

  /**
   * 需要"具体库"的接口用的列表（模块 4）：`both` 展开成两个库。
   *
   * 顺序与后端 `deps.resolve_scope_set` 一致（public 在前），
   * 这样下拉里的库标注与引用标注的顺序对得上。
   */
  const scopeList = useMemo(
    () => (scopeKind === 'both' ? ['public', `private:${user.user_uuid}`] : [scopeValue]),
    [scopeKind, scopeValue, user.user_uuid],
  )

  /**
   * 文件列表是否还在加载：由"想要的 scope"与"已加载的 scope"推导，
   * 而不是在 effect 里同步 setState。
   *
   * 这样写有两个好处：切库那一帧就是 loading（不会先闪出上一个库的文件名），
   * 也不用在 effect 体里同步写状态（那会多触发一轮渲染）。
   */
  const filesLoading = loadedScope !== scopeValue

  // 切库 / 上传成功后重拉文件列表。effect 里只做异步写状态，同步部分一律交给事件/推导。
  useEffect(() => {
    let alive = true
    // both 模式要拉两个库：`/api/files` 只接受具体库（both 会 400，见 deps.resolve_scope）。
    // 合并时给文件名带上库标——两个库里的同名文件 uuid 不同，不标就分不清点的是哪一个；
    // 单选一个库时不加后缀（"手册.pdf（公共库）"在只有公共库的场景里是纯噪音）。
    Promise.all(scopeList.map((s) => listFiles(s).then((list) => ({ scope: s, list }))))
      .then((parts) => {
        if (!alive) return
        const merged: ApiFile[] = parts.flatMap(({ scope, list }) =>
          list.map((f) => ({
            ...f,
            file_name: scopeList.length > 1 ? `${f.file_name}（${scopeLabel(scope)}）` : f.file_name,
          })),
        )
        setFiles(merged)
        setLoadedScope(scopeValue)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setFiles([])
        setLoadedScope(scopeValue) // 失败也要"结束加载"，否则转圈永不消失
        message.warning(extractErrorMessage(err, '文件列表加载失败'))
      })
    return () => {
      alive = false
    }
  }, [scopeValue, scopeList, message, filesReloadKey])

  /**
   * 上传文档（模块 3）。
   *
   * 权限在**后端**判定（`api/deps.resolve_scope(..., write=True)`）：普通用户
   * `can_write_public=false`，界面上连"公共库"选项都不给；即便有人绕过界面直接调接口，
   * 后端依然 403。前端这层只负责"别让用户白点一次、点了要知道为什么"。
   *
   * 401 自己处理：上传走的是 fetch（要 multipart + 不受 30s 超时限制），
   * 到不了 axios 的全局 401 拦截器。
   */
  const doUpload = async (file: File) => {
    const target = uploadTarget === 'public' ? 'public' : `private:${user.user_uuid}`
    setUploading(true)
    try {
      const result = await uploadFile(target, file)
      // 重复上传（同库已有相同 MD5）后端回的是 200 + duplicate，而且**没有**新建版本：
      // 用 warning 而不是 success，否则用户会以为"又存了一份新的"——那正是这句提示要澄清的事
      if (result.duplicate) message.warning(result.message)
      else message.success(result.message)
      // 只刷新"当前正在看的库"：传到另一个库时刷新它反而是无意义的抖动
      if (target === scopeValue) setFilesReloadKey((k) => k + 1)
    } catch (err) {
      if (err instanceof FetchHttpError && err.status === 401) {
        message.error('登录状态已失效，请重新登录')
        navigate('/login', { replace: true })
        return
      }
      message.error(
        err instanceof FetchHttpError
          ? err.message
          : extractErrorMessage(err, '上传失败，请稍后重试'),
      )
    } finally {
      setUploading(false)
    }
  }

  /**
   * 加载账号列表（仅管理员）。
   *
   * 为什么管理员一进页面就拉：看不到账号列表，"授权他人"这个功能就等于不存在；
   * 而普通用户连这个请求都不会发（后端也会 403，这里只是不做无意义的调用）。
   */
  useEffect(() => {
    if (user.role !== 'admin') return
    let alive = true
    listUsers()
      .then((list) => {
        if (alive) setAdminUsers(list)
      })
      .catch(() => {
        // 保持 null → 界面显示"加载失败"；401 已由 axios 全局拦截器统一跳登录页
        if (alive) setAdminUsers(null)
      })
    return () => {
      alive = false
    }
  }, [user.role])

  /**
   * 改他人角色（仅管理员，后端二次校验）。
   *
   * 后端改完会**吊销目标用户的全部会话**，所以这里要明确告诉管理员
   * "对方的登录已经失效"——否则对方来投诉"我怎么突然要重新登录"时没人知道原因。
   */
  const changeRole = async (target: ApiAdminUser, role: RoleName) => {
    try {
      const updated = await setUserRole(target.user_uuid, role)
      setAdminUsers((prev) =>
        prev ? prev.map((u) => (u.user_uuid === updated.user_uuid ? updated : u)) : prev,
      )
      message.success(
        `${updated.username} 已设为「${ROLE_LABELS[updated.role]}」；其现有登录会话已吊销，需重新登录`,
      )
    } catch (err) {
      message.error(extractErrorMessage(err, '修改角色失败，请稍后重试'))
    }
  }

  const stopTicker = useCallback(() => {
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current)
      tickerRef.current = null
    }
  }, [])

  /**
   * 上一次自动归零的 ``(scope, 文件过滤)`` 组合。
   *
   * 用 key 去重有两个原因：React 18 StrictMode 下挂载 effect 会连跑两次；
   * 切库时 setScopeKind 与 setFileFilter(null) 会在同一帧里同时改两个依赖，
   * 不去重就会连发两次 DELETE /api/history。
   */
  const clearedKeyRef = useRef<string | null>(null)

  /**
   * 会话上下文归零（前端消息 + 打字机 + 后端 Redis 历史）。
   *
   * 为什么必须连**后端**历史一起清（模块 1 的根因）：
   * 历史是按 ``(user_uuid, scope)`` 存在 Redis 里的（TTL 1 小时、最多 10 轮）。
   * 页面刷新只是把界面清空，服务端那份还在，于是下一次追问会被
   * ``query_rewrite_service`` 拿"用户看不见的上下文"去改写，
   * 界面上就会冒出"已重写为：xxx"（甚至把独立问题改错）。
   *
   * 返回是否成功：自动调用时静默失败即可；手动"清空对话"按钮要据此给提示。
   */
  const resetConversation = useCallback(async (): Promise<boolean> => {
    abortRef.current?.abort()
    stopTicker()
    pendingRef.current = ''
    finalRef.current = null
    streamEndedRef.current = true
    idSeqRef.current = 0
    setMessages([])
    setStreaming(false)
    try {
      await clearHistory(scopeValue)
      return true
    } catch {
      // 静默：清不掉也不拦着提问，meta.rewrite_skipped 仍会告诉我们实情
      return false
    }
  }, [scopeValue, stopTicker])

  /**
   * 刷新页面 / 切库 / 切文件级过滤 → 前后端一起归零（模块 1 的验收点）。
   *
   * 这三种情况都意味着"上一轮上下文不再适用"：刷新后用户看不到旧消息，
   * 切库/切文件后旧问题指向的对象也变了。只要两边不一致，追问就会被
   * 看不见的历史改写——这正是"刷新后还提示已重写为 xxx"的来源。
   */
  useEffect(() => {
    const key = `${scopeValue}|${fileFilter ?? ''}`
    if (clearedKeyRef.current === key) return
    clearedKeyRef.current = key
    void resetConversation()
  }, [scopeValue, fileFilter, resetConversation])

  /**
   * 收尾：用 done 的完整答案校准文本，并关掉"打字中"。
   *
   * done 载荷里的 answer 是权威版本：逐 token 拼接理论上与它一致，
   * 但万一丢过帧（网络中断/解析异常），以它为准做一次整段替换。
   */
  const finalizeMessage = useCallback(
    (id: string) => {
      stopTicker()
      const final = finalRef.current
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== id) return m
          const patch: Partial<ChatMessage> = { streaming: false, thinking: false }
          if (final) {
            if (final.answer && final.answer !== m.content) patch.content = final.answer
            // 与 citations 事件同一道防御性过滤（state 里也不留噪声，
            // 否则反馈回传/后续复用会把噪声带出去）。渲染那一层还有一次兜底。
            patch.citations = visibleCitations(final.citations)
            patch.cached = final.cached
            patch.refused = final.refused
            // 模块 4：done 是权威版本（含实际检索过的库），覆盖 meta 那次可能不完整的补丁
            if (final.scopes?.length) patch.scopes = final.scopes
            if (final.scope) patch.scopeKey = final.scope
            // 老缓存没存分数 → 后端发 null：保持 undefined（不渲染置信度），
            // 不能落成 0 或 1，否则又变回"命中缓存 = 满分"的失真。
            patch.maxScore = typeof final.max_score === 'number' ? final.max_score : undefined
            // 模块 6：反馈的幂等键（老后端不返回 → 保留原值，界面回落到消息 id）
            if (final.q_hash) patch.qHash = final.q_hash
          }
          return { ...m, ...patch }
        }),
      )
    },
    [stopTicker],
  )

  /** 定时器每帧调一次：从缓冲里吐一点字到界面；缓冲空了且流已结束 → 收尾。 */
  const flushFrame = useCallback(
    (id: string) => {
      const buf = pendingRef.current
      if (!buf) {
        if (streamEndedRef.current) finalizeMessage(id)
        return
      }
      // 自适应步长（积压越多一次吐越多）：模型 3 秒说完、界面要慢悠悠追 20 秒是最糟的观感。
      const step = buf.length > 240 ? 12 : buf.length > 80 ? 6 : 2
      const head = buf.slice(0, step)
      pendingRef.current = buf.slice(step)
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, content: m.content + head, thinking: false } : m)),
      )
    },
    [finalizeMessage],
  )

  const ensureTicker = useCallback(
    (id: string) => {
      if (tickerRef.current !== null) return
      tickerRef.current = window.setInterval(() => flushFrame(id), TYPE_TICK_MS)
    },
    [flushFrame],
  )

  // 卸载（退出登录跳走 / 路由切换）时中断流并停表：否则 fetch 会在后台继续读、
  // 定时器继续 setState 到已卸载的组件上。
  useEffect(
    () => () => {
      abortRef.current?.abort()
      stopTicker()
    },
    [stopTicker],
  )

  // 内容一变就滚到底。打字机以 60fps 触发，这里只是给 scrollTop 赋值，开销可忽略。
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  /** 生成消息 id：用递增序号而不是数组下标——打字机 60fps 更新，下标会漂。 */
  const nextId = useCallback(() => `m${++idSeqRef.current}`, [])

  /**
   * 提问并渲染流式回答。
   *
   * 全部状态都在这里收敛：新增用户/AI 两条消息 → 发起 SSE → 逐帧解析 → 打字机吐字。
   */
  const send = useCallback(async () => {
    const question = input.trim()
    if (!question || streaming) return

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: question }
    const aiId = nextId()
    setMessages((prev) => [
      ...prev,
      userMsg,
      {
        id: aiId,
        role: 'assistant',
        content: '',
        streaming: true,
        thinking: true,
        // 模块 6：把这一问的**问题**与 scope 原串挂在回答上——反馈要用它们。
        // 从 meta 事件也能拿到 question，但流中途失败时就没有它了，
        // 而在本地记一份的成本是零。
        question,
        scopeRequest: scopeValue,
      },
    ])
    setInput('')
    setStreaming(true)

    // 重置流 + 打字机状态（上一轮的残留绝不能带进这一轮）
    stopTicker()
    pendingRef.current = ''
    streamEndedRef.current = false
    finalRef.current = null

    const controller = new AbortController()
    abortRef.current = controller

    const patch = (id: string, p: Partial<ChatMessage>) =>
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...p } : m)))

    /**
     * 处理一帧 SSE（已按空行切开）。返回 true = 收到结束哨兵，调用方停止解析。
     *
     * 帧格式（api/routers/chat.py + api/streaming.py）::
     *     event: token
     *     data: {"text": "张"}
     */
    const handleFrame = (frame: string): boolean => {
      let eventName = 'message'
      const dataLines: string[] = []

      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim()
        } else if (line.startsWith('data:')) {
          // 规范里 "data:" 后的那一个空格是可选的，只去掉一个（不能 trim：正文首尾空格是内容）
          dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
        }
        // id: / retry: / 以 ':' 开头的注释行，本项目用不到，忽略
      }

      const raw = dataLines.join('\n')
      if (!raw) return false
      // OpenAI 风格的结束哨兵。当前后端发的是 event: done（带完整载荷），这里顺手兼容。
      if (raw === '[DONE]') return true

      let data: unknown
      try {
        data = JSON.parse(raw)
      } catch {
        console.warn('[chat] 跳过无法解析的 SSE 帧:', raw)
        return false
      }

      switch (eventName) {
        case 'meta': {
          // 增量补丁：后端分多次发（开头给 rewritten_*，命中缓存补 cached，拒答补 refused）
          const meta = data as ChatMeta
          const p: Partial<ChatMessage> = {}
          // 模块 6：问题原文（反馈要用）——流中途失败时 done 不会到，这里先记下来
          if (meta.question) p.question = meta.question
          if (meta.rewritten && meta.rewritten_question) p.rewritten = meta.rewritten_question
          if (meta.cached) p.cached = true
          if (meta.refused) p.refused = true
          // 模块 4：把"这次实际查了哪些库"落在消息上 → 气泡上方标出检索范围。
          // 用后端给的列表（空库已被剔除），而不是本地那个模式字符串：
          // both 模式下私人库还是空的时候，界面应该显示"公共库"，而不是撒个谎说查了两个库。
          if (meta.scopes?.length) p.scopes = meta.scopes
          if (meta.scope) p.scopeKey = meta.scope
          // 空库提示（UI 修复）：把"哪个库这次没查、为什么"一起落到消息上。
          // 只在非空时写：meta 是分多帧发的增量补丁（后面还可能补 cached/refused），
          // 后几帧里没有 `skipped_scopes` 这个键，不能用一个空值把它清掉。
          if (meta.skipped_scopes?.length) p.skippedScopes = meta.skipped_scopes
          if (Object.keys(p).length > 0) patch(aiId, p)
          break
        }
        case 'rewrite': {
          // 后端目前没有独立的 rewrite 事件（改写信息在 meta 里），顺手兼容一下
          const r = data as { rewritten_question?: string; question?: string }
          const rewritten = r.rewritten_question ?? r.question
          if (rewritten) patch(aiId, { rewritten })
          break
        }
        case 'token': {
          const { text } = data as { text?: string }
          if (text) pendingRef.current += text // 只入缓冲，由打字机按节奏出字
          break
        }
        case 'citations': {
          const { citations } = data as { citations?: Citation[] }
          // 落库前先滤（后端已滤一道，这里是防御性的；老缓存的引用没有分数 → 保留）
          if (citations) patch(aiId, { citations: visibleCitations(citations) })
          break
        }
        case 'debug': {
          // 命中片段详情（preview / rerank_score）：留给后续"调试面板"，现在不往正文里塞噪音
          break
        }
        case 'done': {
          finalRef.current = data as ChatDoneResult
          break
        }
        case 'error': {
          // 流已开始 → HTTP 状态码改不了，后端只能用事件报错
          const { message: reason } = data as { message?: string }
          patch(aiId, { error: reason ?? '处理失败，请稍后重试' })
          break
        }
        default:
          break
      }
      return false
    }

    try {
      const { reader } = await SSEChat(
        {
          question,
          scope: scopeValue,
          file_uuid: fileFilter,
          enable_rerank: enableRerank,
          rerank_model: rerankModel,
        },
        { signal: controller.signal },
      )

      ensureTicker(aiId)

      const decoder = new TextDecoder('utf-8')
      // 跨块的残留：一次 read 可能只拿到半行/半帧（TCP 分片是常态），必须自己缓冲，
      // 否则中文会被从中间劈开，拼接处出现乱码。
      let buffer = ''
      let stop = false
      while (!stop) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // 帧分隔符是空行（"event: x\ndata: y\n\n"）。一个块里通常有多个帧，要循环切。
        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          if (handleFrame(frame)) {
            stop = true
            break
          }
          sep = buffer.indexOf('\n\n')
        }
      }
      // 收尾：冲出解码器里残留的半个多字节字符，再处理最后一个没以空行结束的帧
      buffer += decoder.decode()
      if (!stop && buffer.trim()) handleFrame(buffer)
    } catch (err) {
      if (controller.signal.aborted) {
        patch(aiId, { stopped: true })
      } else if (err instanceof ChatStreamError && err.status === 401) {
        // 流式接口走的是 fetch，到不了 axios 的 401 拦截器 → 这里自己接管跳转
        message.error('登录状态已失效，请重新登录')
        navigate('/login', { replace: true })
        return
      } else {
        patch(aiId, { error: describeStreamError(err) })
      }
    } finally {
      streamEndedRef.current = true
      abortRef.current = null
      setStreaming(false)
      // 缓冲已空（一个 token 都没到就失败/停止）→ 直接收尾；
      // 否则交给打字机把已收到的内容吐完再收尾（硬切会吞掉最后几个字）
      if (pendingRef.current === '') finalizeMessage(aiId)
    }
  }, [
    input,
    streaming,
    scopeValue,
    fileFilter,
    enableRerank,
    rerankModel,
    navigate,
    message,
    nextId,
    stopTicker,
    ensureTicker,
    finalizeMessage,
  ])

  /** 停止生成：中断 fetch，已收到的内容保留（finally 里会把状态收干净）。 */
  const stop = () => abortRef.current?.abort()

  /* ---------------------------- 反馈飞轮（模块 6） ---------------------------- */

  /**
   * 提交一条反馈（👍/👎 与「资料缺失」弹窗共用）。
   *
   * 几个必须写下来的点：
   * * ``scope`` 用**提问时的原串**（``msg.scopeRequest``）：后端 ``resolve_scope_set``
   *   只认 ``public`` / ``private:<uuid>`` / ``both``，把 ``scopeKey``
   *   （多库时是 ``public+private:<uuid>``）传过去会 400「scope 非法」；
   * * 标记用的是**服务端返回的 q_hash**，不是本地算的：它与后端判重同源，
   *   不会出现"界面说已反馈、后端其实又插了一条"的错位；
   * * 失败只弹提示、不落标记（乐观标记会让用户以为提交成功了）。
   */
  const submitFor = async (
    msg: ChatMessage,
    rating: FeedbackRating,
    reason?: string,
  ): Promise<string | null> => {
    const key = feedbackKey(msg)
    setBusyFeedback({ key, rating })
    try {
      const result = await submitFeedback({
        scope: msg.scopeRequest ?? scopeValue,
        question: msg.question ?? '',
        answer: msg.content,
        citations: visibleCitations(msg.citations),
        rating,
        reason,
        file_uuid_filter: fileFilter,
      })
      setRated((prev) => ({ ...prev, [result.q_hash]: rating }))
      message.success(result.message)
      return result.q_hash
    } catch (err) {
      message.error(extractErrorMessage(err, '反馈提交失败，请稍后重试'))
      return null
    } finally {
      setBusyFeedback(null)
    }
  }

  /** 最近一条 AI 回答（「资料缺失」弹窗把它的答案/引用一起带上，bad case 才可复现）。 */
  const lastAnswer = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i]
    }
    return null
  }, [messages])

  /** 「资料缺失」弹窗的默认问题 = 最近一次提问（空着提交只会造出一条没有问题的记录）。 */
  const lastQuestion = lastAnswer?.question ?? ''

  /**
   * 清空对话。
   *
   * 三层都要清，否则会出现"界面空了，但下一问还按旧上下文改写"的鬼故事：
   * 1) 前端消息列表；2) 打字机缓冲与定时器；3) 后端 Redis 里按 (user, scope) 存的对话历史
   * （``query_rewrite_service`` 拿它做指代消解，"多轮上下文"正是它要消除的东西）。
   */
  const clearChat = async () => {
    const ok = await resetConversation()
    if (ok) {
      message.success('已清空对话')
    } else {
      // 后端没清掉不该拦着用户：前端确实已经空了，只是"下一问的改写"可能仍受旧历史影响
      message.warning('前端已清空，但服务端历史清理失败：下一问的改写可能仍受旧历史影响')
    }
  }

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

  const onPressEnter = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法：候选框里的回车不能当"发送"——拼音还没上屏就把半截问题发出去了。
    // （部分浏览器只在 nativeEvent 上给 isComposing，所以读 nativeEvent。）
    if (e.nativeEvent.isComposing) return
    if (e.shiftKey) return // Shift+Enter 换行
    e.preventDefault()
    void send()
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
          {/* 角色必须可见：它决定了"能不能传公共库""有没有用户授权面板"，
              藏起来只会让用户把"功能被权限挡住"误解成"功能坏了" */}
          <Tag
            color={
              user.role === 'admin' ? 'red' : user.role === 'authorized_user' ? 'gold' : undefined
            }
          >
            {ROLE_BADGE[user.role]}
          </Tag>
          <Button ghost onClick={() => setPasswordModalOpen(true)}>
            修改密码
          </Button>
          <Button danger ghost onClick={onLogout} loading={loggingOut}>
            退出登录
          </Button>
        </Space>
      </Header>

      {/* hasSider 显式声明：否则 antd 要靠 child 类型探测，首帧容易先按"无侧栏"排版再跳一下。
          height 固定成"视口 - 顶栏"，内部的两块才能各自出现滚动条（而不是整页滚）。 */}
      <Layout hasSider style={{ height: 'calc(100vh - 64px)' }}>
        <Sider width={300} theme="light" style={{ padding: 16, overflowY: 'auto' }}>
          <Space orientation="vertical" size={20} style={{ width: '100%' }}>
            <div>
              <Typography.Text strong>会话</Typography.Text>
              <Button
                danger
                block
                style={{ marginTop: 8 }}
                onClick={() => void clearChat()}
                disabled={messages.length === 0}
              >
                清空对话
              </Button>
              {/*
                运营看板入口（模块 6）：**只给管理员看**。
                普通用户点了只会吃 403，而"看得见却进不去"的入口比没有入口更让人困惑。
              */}
              {user.role === 'admin' && (
                <Button
                  block
                  type="primary"
                  ghost
                  style={{ marginTop: 8 }}
                  onClick={() => void navigate('/admin')}
                  data-testid="open-admin-dashboard"
                >
                  📊 运营看板
                </Button>
              )}
            </div>

            <div>
              <Typography.Text strong>检索范围</Typography.Text>
              <Radio.Group
                value={scopeKind}
                onChange={(e) => {
                  // 切库清掉文件过滤：file_uuid 是"某个库里的文件"，把公共库的 uuid 带到私人库
                  // 只会查出空结果（后端 scope 过滤兜底，不越权），但对用户是纯粹的困惑。
                  setScopeKind(e.target.value as ScopeMode)
                  setFileFilter(null)
                }}
                style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}
              >
                {SCOPE_MODE_LABELS.map((opt) => (
                  <Radio key={opt.value} value={opt.value}>
                    {opt.label}
                  </Radio>
                ))}
              </Radio.Group>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {scopeKind === 'both' ? 'both（公共库 + 我的私人库）' : scopeValue}
              </Typography.Text>
            </div>

            {/* 上传（模块 3）：「上传目标」里的公共库选项由后端的 can_write_public 决定，
                普通用户看不到它，也就不会点了才吃 403 */}
            <div>
              <Typography.Text strong>上传文档</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 8 }}
                value={uploadTarget}
                onChange={(value) => setUploadTarget(value as 'public' | 'private')}
                options={
                  user.can_write_public
                    ? [
                        { value: 'private', label: '我的私人库' },
                        { value: 'public', label: '公共库（所有人可见）' },
                      ]
                    : [{ value: 'private', label: '我的私人库' }]
                }
              />
              {/* accept（决策：暂不支持图片）：名单里不放 png/jpg/jpeg——与后端能解析的文档类型
                  对齐。这只是"别让用户白挑一次"，不是安全边界：后端对图片一律 400
                  「图片格式暂不支持上传」，界面绕过去了也拦得住。 */}
              <Upload
                showUploadList={false}
                accept=".pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.html,.md"
                disabled={uploading}
                customRequest={({ file }) => {
                  // antd 给的是 RcFile（File 的子类），上传只需要 File 的部分
                  void doUpload(file as File)
                }}
              >
                <Button block style={{ marginTop: 8 }} loading={uploading} disabled={uploading}>
                  {uploading ? '解析入库中…' : '选择文件并上传'}
                </Button>
              </Upload>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {user.can_write_public
                  ? '支持 PDF / Word / PPT / Excel / HTML；图片格式暂不支持上传；解析入库需要几十秒，期间别关页面。'
                  : '普通用户只能上传到私人库。若需上传到公共库，请联系管理员把你的角色改为「已授权用户」。'}
              </Typography.Text>
            </div>

            <div>
              <Typography.Text strong>文件级过滤</Typography.Text>
              <Select
                allowClear
                style={{ width: '100%', marginTop: 8 }}
                placeholder="全部文件"
                loading={filesLoading}
                value={fileFilter}
                onChange={(value) => setFileFilter(value ?? null)}
                options={files.map((f) => ({ value: f.file_uuid, label: f.file_name }))}
                notFoundContent={filesLoading ? '加载中...' : '该库暂无文件'}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                已入库 {files.length} 个文件
              </Typography.Text>
            </div>

            {/* 文件管理（模块：文件管理 + 下载）：可折叠面板，列表里直接下载原件。
                数据由后端按会话给（公共库 + 我的私人库），前端不做权限判断；
                reloadKey 跟着"上传成功"一起变，新传的文件立刻出现在表里。 */}
            <FileManagerPanel reloadKey={filesReloadKey} />

            <div>
              <Typography.Text strong>检索设置</Typography.Text>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 8,
                }}
              >
                <Typography.Text>启用 Rerank</Typography.Text>
                <Switch size="small" checked={enableRerank} onChange={setEnableRerank} />
              </div>
              {/* testid 放在外面这层普通 div 上：antd 的 Select 是否把未知属性透传到 DOM
                  取决于版本，E2E 定位不能赌这个（用 div 包一层是 100% 可控的）。 */}
              <div data-testid="rerank-model-select">
                <Select
                  style={{ width: '100%', marginTop: 8 }}
                  value={rerankModel}
                  onChange={(value) => setRerankModel(value)}
                  disabled={!enableRerank}
                  options={RERANK_MODELS}
                />
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                用 Cross-Encoder 对召回结果重排：更准但更慢，关掉可选择的速度优先。
                中文语料推荐默认的 bge-reranker-base。
              </Typography.Text>
            </div>

            {/* 用户授权（模块 3）：仅管理员可见；后端 PUT /api/admin/users/{uuid}/role
                还会二次校验，这里隐藏只是"别让人白试一次" */}
            {user.role === 'admin' && (
              <div>
                <Typography.Text strong>用户授权</Typography.Text>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, display: 'block', marginTop: 4 }}
                >
                  改为「已授权用户」后即可上传公共库；改完会吊销对方会话，他需要重新登录。
                </Typography.Text>
                {adminUsers === null ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    账号列表加载失败
                  </Typography.Text>
                ) : (
                  <Space
                    orientation="vertical"
                    size={4}
                    style={{ width: '100%', marginTop: 8 }}
                  >
                    {adminUsers.map((u) => (
                      <div
                        key={u.user_uuid}
                        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                      >
                        <Typography.Text style={{ flex: 1, fontSize: 12 }} ellipsis>
                          {u.username}
                        </Typography.Text>
                        <Select
                          size="small"
                          style={{ width: 170 }}
                          value={u.role}
                          // 自己那一行禁用：后端也会拒（不许改自己的角色），
                          // 与其让管理员点了才吃 400，不如直接不给点
                          disabled={u.user_uuid === user.user_uuid}
                          onChange={(role) => void changeRole(u, role as RoleName)}
                          options={(Object.keys(ROLE_LABELS) as RoleName[]).map((r) => ({
                            value: r,
                            label: ROLE_LABELS[r],
                          }))}
                        />
                      </div>
                    ))}
                  </Space>
                )}
              </div>
            )}
          </Space>
        </Sider>

        {/* minHeight: 0 必须加：flex 子项默认 min-height:auto，会让内部的滚动条失效 */}
        <Content
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 24,
            minHeight: 0,
          }}
        >
          <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
            {messages.length === 0 ? (
              <div style={{ marginTop: 48 }}>
                <Empty description="还没有对话，先在左侧选好检索范围，再提问吧" />
              </div>
            ) : (
              messages.map((m) => {
                // 反馈状态按 q_hash 查（模块 6）：同一个问题只标记一次
                const key = feedbackKey(m)
                return (
                  <MessageBubble
                    key={m.id}
                    msg={m}
                    onOpenSource={setTraceCitation}
                    onRate={(rating) => void submitFor(m, rating)}
                    busyRating={busyFeedback?.key === key ? busyFeedback.rating : null}
                    ratedRating={rated[key]}
                  />
                )
              })
            )}
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            {/* 输入框在生成期间**不禁用**：用户可以先打下一个问题（禁用会让焦点丢掉，
                中文输入法用户尤其难受）。 */}
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={onPressEnter}
              placeholder="输入你的问题：Enter 发送，Shift+Enter 换行"
              autoSize={{ minRows: 2, maxRows: 6 }}
              autoFocus
            />
            {/*
              「资料缺失/建议反馈」（模块 6）：没有对话时禁用——弹窗默认提交"最近一次提问"，
              空着提交只会造出一条没有问题的 bad case，运营看了也不知道该补什么。
            */}
            <Button
              onClick={() => setFeedbackModalOpen(true)}
              disabled={!lastQuestion}
              data-testid="report-missing"
            >
              资料缺失/反馈
            </Button>
            {streaming ? (
              <Button danger onClick={stop}>
                停止
              </Button>
            ) : (
              <Button type="primary" onClick={() => void send()} disabled={!input.trim()}>
                发送
              </Button>
            )}
          </div>
        </Content>
      </Layout>

      {/* 改密码弹窗（模块 2.1）：成功后后端会吊销全部会话，弹窗自己负责跳 /login */}
      <ChangePasswordModal
        open={passwordModalOpen}
        onClose={() => setPasswordModalOpen(false)}
      />

      {/* 引用出处弹窗（文件管理模块）：点引用标签打开，可看摘录、下载原件 */}
      <SourceTraceModal citation={traceCitation} onClose={() => setTraceCitation(null)} />

      {/*
        资料缺失 / 建议反馈弹窗（模块 6）：提交到同一个 POST /feedback（rating=down）。
        提交成功后用**服务端返回的 q_hash** 标记「已反馈」——它与回答下方 👎 是同一条记录，
        两处入口的状态必须一致（用户不该在弹窗里提交完、再看到回答下面还能点 👎）。
      */}
      <FeedbackModal
        open={feedbackModalOpen}
        onClose={() => setFeedbackModalOpen(false)}
        scope={lastAnswer?.scopeRequest ?? scopeValue}
        defaultQuestion={lastQuestion}
        answer={lastAnswer?.content}
        citations={visibleCitations(lastAnswer?.citations)}
        onSubmitted={(qHash) => setRated((prev) => ({ ...prev, [qHash]: 'down' }))}
      />
    </Layout>
  )
}
