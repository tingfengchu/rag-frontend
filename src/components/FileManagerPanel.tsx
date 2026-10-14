import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  App as AntdApp,
  Button,
  Collapse,
  Empty,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { TableProps } from 'antd'

import {
  FetchHttpError,
  deleteFile,
  deleteFileErrorMessage,
  downloadFile,
  extractErrorMessage,
  formatFileSize,
  listLibraryFiles,
  previewFile,
} from '../api/client'
import type { ApiLibraryFile } from '../api/client'

/** 时间显示成"2026-10-13 18:05"（秒没用；DB 存的是本地时间，不做时区换算）。 */
function formatTime(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(
    parsed.getHours(),
  )}:${pad(parsed.getMinutes())}`
}

/**
 * 「📁 文件管理」面板（左侧栏可折叠）。
 *
 * 数据来自 ``GET /api/files/library``：**后端**按会话给出"我可见的原件"
 * （公共库 + 我自己的私人库）。前端不传 scope、也不做角色判断——
 * 权限规则只能有一份，否则"界面给了、接口却 403"这类错位迟早出现。
 *
 * 列一个都不省的原因（表格就 6 列，每列排障时都用得上）：
 *   * 库：同名文件在两个库里都有一份时必须能分清点的是哪一个；
 *   * 版本：取 ``file_dedup.version``（模块 5b 起是**真实列**），不由列表层按顺序数；
 *   * 时间 / 上传人：问"这份是谁什么时候传的"是最常见的追问；
 *   * 大小：判断"下下来的是不是完整那份"的第一眼依据。
 *   * 操作（预览 / 下载 / **删除**）：删除按钮只在后端算出的 ``can_delete`` 为真时出现，
 *     前端不做角色判断——与"查哪些库由后端决定"是同一条原则（一份规则只留一处）。
 */
export default function FileManagerPanel({ reloadKey = 0 }: { reloadKey?: number }) {
  // antd v6：message / modal 都从 App 上下文取（静态方法拿不到主题与语言包）
  const { message, modal } = AntdApp.useApp()
  const navigate = useNavigate()
  const [files, setFiles] = useState<ApiLibraryFile[]>([])
  /** 点「刷新」时 +1 → 与 reloadKey 一起组成"想要的数据版本" */
  const [refreshKey, setRefreshKey] = useState(0)
  /** 已经加载完成的数据版本；``null`` = 一次都还没成功结束（首帧就是 loading） */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  /** 正在下载的 file_uuid（按钮转圈；只锁那一行，不锁整张表） */
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 正在预览的 file_uuid（同上）：预览要等原件回来才能开标签页，同样得转圈 */
  const [previewId, setPreviewId] = useState<string | null>(null)
  /**
   * 正在删除的 file_uuid（删除要等三库清理完才回来）。
   *
   * 与 ``busyId`` / ``previewId`` 分开记：删除的按钮文案、提示语都不一样，
   * 合并成一个"忙碌行"就得在渲染时反推"这一行到底在忙什么"。
   */
  const [deletingId, setDeletingId] = useState<string | null>(null)
  /**
   * 是否显示历史版本（模块 5）。
   *
   * 默认**关闭**：库里"到底有几个文件"是最常被问的问题，把每个被覆盖过的旧版本
   * 都铺在列表里，答案会随历史遗留数量一起膨胀。要看"上一版长什么样"时再打开。
   * 开关状态不落 localStorage：它是"我现在想不想看"，不是需要长期记住的偏好。
   */
  const [showArchived, setShowArchived] = useState(false)

  const loadKey = `${reloadKey}:${refreshKey}:${showArchived}`
  /**
   * loading **推导**出来，而不是在 effect 里 setState：
   * 切 reloadKey 那一帧就显示 loading（不会先闪一下旧数据），
   * 也避免"同步 setState 触发级联渲染"（oxlint react/set-state-in-effect）。
   * 与 ChatPage 的 ``filesLoading`` 是同一套写法。
   */
  const loading = loadedKey !== loadKey

  useEffect(() => {
    let alive = true
    listLibraryFiles(showArchived)
      .then((list) => {
        if (alive) setFiles(list)
      })
      .catch((err: unknown) => {
        if (alive) {
          // 401 已由 axios 全局拦截器统一跳登录页；这里只处理"列表没拿到"的提示
          setFiles([])
          message.warning(extractErrorMessage(err, '文件列表加载失败'))
        }
      })
      .finally(() => {
        // 失败也要"结束加载"，否则转圈永不消失
        if (alive) setLoadedKey(loadKey)
      })
    return () => {
      alive = false
    }
  }, [loadKey, message, showArchived])

  /**
   * 下载 / 预览共用的失败处理。
   *
   * 两者都走 ``fetch``（要读响应头里的文件名和 Content-Disposition，并自己弹中文提示），
   * 到不了 axios 的全局 401 拦截器——不在这里显式处理，用户看到的会是"下载失败"，
   * 而真正的原因是登录过期了。
   */
  const reportFetchError = (err: unknown, fallback: string) => {
    if (err instanceof FetchHttpError && err.status === 401) {
      message.error('登录状态已失效，请重新登录')
      navigate('/login', { replace: true })
      return
    }
    // 403 的文案就是后端那句（下载是「无下载权限…」、预览是「无预览权限…」）
    message.error(err instanceof FetchHttpError ? err.message : fallback)
  }

  const handleDownload = async (file: ApiLibraryFile) => {
    setBusyId(file.file_uuid)
    try {
      await downloadFile(file)
      message.success(`已开始下载 ${file.file_name}`)
    } catch (err) {
      reportFetchError(err, '下载失败，请稍后重试')
    } finally {
      setBusyId(null)
    }
  }

  /**
   * 在线预览：在新标签页里打开原件（PDF 直接看，不落盘）。
   *
   * 降级成下载时**必须给一句说明**——用户点的是"预览"，结果文件进了下载目录，
   * 不解释的话看起来就像按钮点错了。两种情况会降级（见 client.ts:previewFile）：
   * 后端判定该类型不该内嵌（Word / Excel / HTML 只给 attachment），
   * 或浏览器拦了新标签页。
   */
  const handlePreview = async (file: ApiLibraryFile) => {
    setPreviewId(file.file_uuid)
    try {
      const outcome = await previewFile(file)
      if (outcome === 'download') {
        message.info(`${file.file_name} 无法在浏览器里直接预览，已改为下载`)
      }
    } catch (err) {
      reportFetchError(err, '预览失败，请稍后重试')
    } finally {
      setPreviewId(null)
    }
  }

  /**
   * 删除文件：二次确认 → 调接口 → 刷新列表。
   *
   * 为什么要 ``Modal.confirm``：删除**不可撤销**（MySQL 记录 / ES 父子块 / Chroma 向量 /
   * 留存原件一起清），而「删除」和「下载」是并排放的小按钮，误点的代价完全不对等。
   * 确认框里把文件名与后果都写出来，用户至少能核对自己点的是哪一行。
   *
   * 用 ``AntdApp.useApp()`` 的 ``modal`` 而不是静态 ``Modal.confirm``：静态方法拿不到
   * App 上下文（主题 / 语言包），antd 从 v5 起也明确不推荐。
   *
   * 失败时**也关掉弹窗**、只弹提示：留着弹窗会让"关掉它"和"再点一次重试"两条路同时
   * 对着用户，而提示里已经说清原因了（403 / 404 / 500 各有专用文案）。
   */
  const handleDelete = (file: ApiLibraryFile) => {
    modal.confirm({
      title: '确认删除',
      content: `删除「${file.file_name}」？它的记录、检索块与留存原件会一起清掉，且不可撤销。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setDeletingId(file.file_uuid)
        try {
          await deleteFile(file)
          message.success('已删除')
          // 重新拉一次列表，而不是本地 filter 掉那一行：以后端为准（将来若改成软删除 /
          // 延迟清理，这里不用跟着改），也顺带证明"列表里真的没有了"。
          setRefreshKey((k) => k + 1)
        } catch (err) {
          message.error(deleteFileErrorMessage(err))
        } finally {
          setDeletingId(null)
        }
      },
    })
  }

  const columns: TableProps<ApiLibraryFile>['columns'] = [
    {
      title: '文件名',
      dataIndex: 'file_name',
      key: 'file_name',
      // 长中文名很常见：单行省略 + Tooltip 看全名，表格才不会被撑散
      ellipsis: true,
      render: (_value, file) => (
        <Tooltip title={file.file_name}>
          <div style={{ minWidth: 0 }}>
            <Typography.Text ellipsis style={{ fontSize: 13 }}>
              {file.file_name}
            </Typography.Text>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {formatFileSize(file.size_bytes)}
              </Typography.Text>
            </div>
          </div>
        </Tooltip>
      ),
    },
    {
      title: '库',
      dataIndex: 'scope_label',
      key: 'scope_label',
      width: 92,
      render: (label: string) => (
        <Tag color={label === '公共库' ? 'blue' : 'green'} style={{ marginInlineEnd: 0 }}>
          {label}
        </Tag>
      ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 96,
      render: (version: number, file) => (
        <Space size={4}>
          <Typography.Text style={{ fontSize: 12 }}>{`v${version}`}</Typography.Text>
          {/*
            历史版本（模块 5）：默认列表里不会有它，打开「显示历史版本」才出现。
            标签用默认灰色 —— 它是"这条已被取代"，不是错误，用红色会让人以为文件坏了。
          */}
          {file.archived && (
            <Tag
              color="default"
              style={{ marginInlineEnd: 0 }}
              data-testid="file-archived-tag"
            >
              历史版本
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 128,
      render: (value: string | null) => (
        <Typography.Text style={{ fontSize: 12 }}>{formatTime(value)}</Typography.Text>
      ),
    },
    {
      title: '上传人',
      dataIndex: 'owner_username',
      key: 'owner_username',
      width: 84,
      ellipsis: true,
      render: (name: string) => name || '—',
    },
    {
      title: '操作',
      key: 'action',
      width: 176,
      render: (_value, file) => {
        // 一次只做一件事：三个按钮共用一个锁，避免"预览还没开完又点下载/删除"
        const busy = busyId !== null || previewId !== null || deletingId !== null
        const readActions = (
          <Space size={0}>
            <Button
              size="small"
              type="link"
              data-testid="file-preview"
              loading={previewId === file.file_uuid}
              disabled={!file.downloadable || busy}
              onClick={() => void handlePreview(file)}
            >
              预览
            </Button>
            <Button
              size="small"
              type="link"
              data-testid="file-download"
              loading={busyId === file.file_uuid}
              disabled={!file.downloadable || busy}
              onClick={() => void handleDownload(file)}
            >
              下载
            </Button>
          </Space>
        )
        // 没原件时把原因写在 hover 上：不然用户只会反复点一个灰按钮。
        // 这个 Tooltip 只包「预览 / 下载」：删除**不受原件影响**——恰恰是改造前上传、
        // 没有留存件的历史文件最需要能删掉；把删除一起塞进来，那句提示就成了假话。
        const readers = file.downloadable ? (
          readActions
        ) : (
          <Tooltip title="该文件没有留存原件（改造前上传的历史文件），无法预览或下载">
            {/* 禁用按钮不触发鼠标事件 → 用 span 包一层承载 Tooltip */}
            <span>{readActions}</span>
          </Tooltip>
        )
        return (
          <Space size={0}>
            {readers}
            {/* 「删除」只在**后端说可以**时才渲染（file.can_delete，见后端 _can_delete）：
                权限规则只留一份，前端不按 role / owner 自己判。 */}
            {file.can_delete && (
              <Button
                size="small"
                type="link"
                danger
                data-testid="file-delete"
                loading={deletingId === file.file_uuid}
                disabled={busy && deletingId !== file.file_uuid}
                onClick={() => handleDelete(file)}
              >
                删除
              </Button>
            )}
          </Space>
        )
      },
    },
  ]

  return (
    <Collapse
      // 默认展开：文件管理是交付验收里"一眼要看到那 3 个文件"的那块
      defaultActiveKey={['files']}
      size="small"
      items={[
        {
          key: 'files',
          label: (
            <span>
              📁 文件管理
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                （{loading ? '…' : files.length}）
              </Typography.Text>
            </span>
          ),
          children: (
            <div data-testid="file-manager-panel">
              <Space size={12} style={{ marginBottom: 8 }} wrap>
                <Button size="small" onClick={() => setRefreshKey((k) => k + 1)} loading={loading}>
                  刷新
                </Button>
                {/* 「显示历史版本」（模块 5）：开关状态直接进请求参数，不在前端过滤——
                    后端才知道哪些行是历史版本，也才做得到"默认只回最新版本"。 */}
                <Space size={4}>
                  <Switch
                    size="small"
                    checked={showArchived}
                    onChange={setShowArchived}
                    data-testid="files-show-archived"
                  />
                  <Typography.Text style={{ fontSize: 12 }}>显示历史版本</Typography.Text>
                </Space>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                公共库人人可看可下；私人库只有本人（预览与下载同一套权限）；
                删除按同一套库权限给出口（公共库需管理员或已授权用户，私人库仅本人）
                {showArchived ? '；灰色行为已被同名新版取代的历史版本' : ''}
              </Typography.Text>

              <Table<ApiLibraryFile>
                size="small"
                rowKey="file_uuid"
                loading={loading}
                columns={columns}
                dataSource={files}
                // 历史版本整行变浅（模块 5）：版本标签之外再给一个整体的视觉区分，
                // 一眼就能看出"这一行不是当前版本"，而不用逐行读标签。
                onRow={(file) =>
                  file.archived ? { style: { color: 'rgba(0, 0, 0, 0.45)' } } : {}
                }
                pagination={false}
                // 面板在侧栏（300px）里：横向滚动比"列被压扁到看不清"更好用
                // （加「预览」时 560 → 640；再加「删除」→ 700，避免三个按钮被挤成两行）
                scroll={{ x: 700 }}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={loading ? '加载中…' : '暂无可下载的文件'}
                    />
                  ),
                }}
              />
            </div>
          ),
        },
      ]}
    />
  )
}
