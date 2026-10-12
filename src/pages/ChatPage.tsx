import { useCallback, useEffect, useRef, useState } from 'react'
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
} from 'antd'

import {
  ChatStreamError,
  RERANK_MODELS,
  SSEChat,
  api,
  clearHistory,
  extractErrorMessage,
  listFiles,
} from '../api/client'
import type {
  ApiFile,
  ChatDoneResult,
  ChatMeta,
  Citation,
  RerankModelName,
} from '../api/client'
import { useAuthUser } from '../components/RequireAuth'

const { Header, Sider, Content } = Layout

/** 打字机的刷新间隔：16ms ≈ 60fps，看起来就是"一个字一个字蹦出来"。 */
const TYPE_TICK_MS = 16

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
  maxScore?: number
  /** 流内 error 事件，或请求本身失败的原因 */
  error?: string
  /** 用户主动点了"停止" */
  stopped?: boolean
}

/** 把流式请求的异常翻成中文。fetch 的异常不是 axios 错误，extractErrorMessage 在 here 用不上。 */
function describeStreamError(err: unknown): string {
  if (err instanceof ChatStreamError) return err.message
  if (err instanceof TypeError) return '无法连接服务器，请确认后端已启动'
  return '流式问答失败，请稍后重试'
}

/** AI 气泡下方的状态标签 + 引用来源。 */
function MessageFooter({ msg }: { msg: ChatMessage }) {
  const citations = msg.citations ?? []
  const hasMeta = Boolean(msg.cached) || Boolean(msg.refused) || typeof msg.maxScore === 'number'
  if (!hasMeta && citations.length === 0) return null

  return (
    <div style={{ marginTop: 6 }}>
      {hasMeta && (
        <Space size={4} wrap>
          {msg.cached && <Tag color="gold">命中缓存</Tag>}
          {msg.refused && <Tag color="red">模型拒答</Tag>}
          {typeof msg.maxScore === 'number' && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最高置信度 {msg.maxScore.toFixed(2)}
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
              <Tag key={`${c.source}#${c.page}`} color="blue">
                {c.source} · 第 {c.page} 页
              </Tag>
            ))}
          </Space>
        </div>
      )}
    </div>
  )
}

/** 一个消息气泡：用户靠右（蓝底白字）、AI 靠左（白底带边框）。 */
function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'

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
        {!isUser && <MessageFooter msg={msg} />}
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

  // ---------------- 侧栏（检索设置） ----------------
  const [scopeKind, setScopeKind] = useState<'public' | 'private'>('public')
  const [files, setFiles] = useState<ApiFile[]>([])
  const [fileFilter, setFileFilter] = useState<string | null>(null)
  const [enableRerank, setEnableRerank] = useState(true)
  const [rerankModel, setRerankModel] = useState<RerankModelName>(RERANK_MODELS[0].value)
  /** 已经加载完成的 scope：用它推导 loading，避免"切库瞬间显示上一个库的文件列表" */
  const [loadedScope, setLoadedScope] = useState<string | null>(null)

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
   * 实际发给后端的 scope。
   *
   * 默认公共库：普通用户的"默认库"按后端 ``deps.resolve_chat_scope`` 是私人库，
   * 但私人库对刚注册的用户是空的，首屏必然撞上"还没有文档"的报错；
   * 公共库是所有人可读的共享知识库（只有写入需要 admin），做默认更合理。
   */
  const scopeValue = scopeKind === 'public' ? 'public' : `private:${user.user_uuid}`

  /**
   * 文件列表是否还在加载：由"想要的 scope"与"已加载的 scope"推导，
   * 而不是在 effect 里同步 setState。
   *
   * 这样写有两个好处：切库那一帧就是 loading（不会先闪出上一个库的文件名），
   * 也不用在 effect 体里同步写状态（那会多触发一轮渲染）。
   */
  const filesLoading = loadedScope !== scopeValue

  // 切库时重拉文件列表。effect 里只做异步写状态，同步部分一律交给事件/推导。
  useEffect(() => {
    let alive = true
    listFiles(scopeValue)
      .then((list) => {
        if (!alive) return
        setFiles(list)
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
  }, [scopeValue, message])

  const stopTicker = useCallback(() => {
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current)
      tickerRef.current = null
    }
  }, [])

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
            patch.citations = final.citations
            patch.cached = final.cached
            patch.refused = final.refused
            patch.maxScore = final.max_score
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
      { id: aiId, role: 'assistant', content: '', streaming: true, thinking: true },
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
          if (meta.rewritten && meta.rewritten_question) p.rewritten = meta.rewritten_question
          if (meta.cached) p.cached = true
          if (meta.refused) p.refused = true
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
          if (citations) patch(aiId, { citations })
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

  /**
   * 清空对话。
   *
   * 三层都要清，否则会出现"界面空了，但下一问还按旧上下文改写"的鬼故事：
   * 1) 前端消息列表；2) 打字机缓冲与定时器；3) 后端 Redis 里按 (user, scope) 存的对话历史
   * （``query_rewrite_service`` 拿它做指代消解，"多轮上下文"正是它要消除的东西）。
   */
  const clearChat = async () => {
    abortRef.current?.abort()
    stopTicker()
    pendingRef.current = ''
    finalRef.current = null
    streamEndedRef.current = true
    setMessages([])
    setStreaming(false)
    try {
      await clearHistory(scopeValue)
      message.success('已清空对话')
    } catch (err) {
      // 后端没清掉不该拦着用户：前端确实已经空了，只是"下一问的改写"可能仍受旧历史影响
      message.warning(extractErrorMessage(err, '前端已清空，但服务端历史清理失败'))
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
            </div>

            <div>
              <Typography.Text strong>检索范围</Typography.Text>
              <Radio.Group
                value={scopeKind}
                onChange={(e) => {
                  // 切库清掉文件过滤：file_uuid 是"某个库里的文件"，把公共库的 uuid 带到私人库
                  // 只会查出空结果（后端 scope 过滤兜底，不越权），但对用户是纯粹的困惑。
                  setScopeKind(e.target.value as 'public' | 'private')
                  setFileFilter(null)
                }}
                style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}
              >
                <Radio value="public">公共库</Radio>
                <Radio value="private">我的私人库</Radio>
              </Radio.Group>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {scopeValue}
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
              <Select
                style={{ width: '100%', marginTop: 8 }}
                value={rerankModel}
                onChange={(value) => setRerankModel(value)}
                disabled={!enableRerank}
                options={RERANK_MODELS}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                用 Cross-Encoder 对召回结果重排：更准但更慢，关掉可选择的速度优先。
              </Typography.Text>
            </div>
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
              messages.map((m) => <MessageBubble key={m.id} msg={m} />)
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
    </Layout>
  )
}
