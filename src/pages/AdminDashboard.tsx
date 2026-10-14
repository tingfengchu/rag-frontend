import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { TableProps } from 'antd'

import { extractErrorMessage, getAdminStats, listBadCases, scopeLabel } from '../api/client'
import type { ApiAdminStats, ApiBadCase } from '../api/client'
import { useAuthUser } from '../components/RequireAuth'

/** 时间显示成 ``2026-10-13 18:05``（DB 存的是本地时间，不做时区换算）。 */
function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(
    parsed.getHours(),
  )}:${pad(parsed.getMinutes())}`
}

/** 一个表格卡片（标题 + 说明 + 表格）：四个块格式统一，省得各写一遍。 */
function Panel<T extends object>({
  title,
  hint,
  testId,
  columns,
  rows,
  loading,
  emptyText,
  rowKey,
}: {
  title: string
  hint?: string
  testId: string
  columns: TableProps<T>['columns']
  rows: T[]
  loading: boolean
  emptyText: string
  rowKey: string | ((row: T) => string)
}) {
  return (
    <Card
      size="small"
      title={title}
      extra={
        hint ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hint}
          </Typography.Text>
        ) : undefined
      }
    >
      <div data-testid={testId}>
        <Table<T>
          size="small"
          rowKey={rowKey}
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={false}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
            ),
          }}
        />
      </div>
    </Card>
  )
}

/**
 * 运营看板（``/admin``，仅管理员；模块 6）。
 *
 * 四个块各自回答一个运营问题：
 *
 * * **高频提问**：大家在问什么（没有被文档覆盖的热门问题 = 下一批要补的资料）；
 * * **被检索最多的文档**：哪些文件真的在被用；
 * * **检索无结果**：哪些问题**问不到答案**——最该先修的一列；
 * * **反馈汇总**：好评/差评与原因分布（用户主动说的"哪里不好"）。
 *
 * 数据是**快照**：``generated_at`` 与 ``window`` 都写在页头。不写出来的话，
 * 管理员会把几分钟前的数字当成实时的，然后质疑"我刚点的差评怎么没上去"。
 *
 * 权限：这一页由 ``<RequireAuth adminOnly>`` 挡住，真正的权威是后端
 * （``/api/admin/*`` 全是 ``require_admin``）；前端这道只负责说清楚为什么进不去。
 */
export default function AdminDashboard() {
  const navigate = useNavigate()
  const user = useAuthUser()

  const [stats, setStats] = useState<ApiAdminStats | null>(null)
  const [badCases, setBadCases] = useState<ApiBadCase[]>([])
  const [error, setError] = useState<string | null>(null)
  /** 点「刷新」时 +1 → 与推导出来的 loading 一起构成"想要的数据版本" */
  const [reloadKey, setReloadKey] = useState(0)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const loadKey = String(reloadKey)
  const loading = loadedKey !== loadKey

  useEffect(() => {
    let alive = true
    // 两个请求并行：一进页面就要看到全部块，串行只会让首屏更慢。
    // 一个失败就整页给错误提示（部分数据 + 一个红条，很容易被读成"统计就是这样"）。
    Promise.all([getAdminStats(), listBadCases(20)])
      .then(([nextStats, cases]) => {
        if (!alive) return
        setStats(nextStats)
        setBadCases(cases)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(extractErrorMessage(err, '看板数据加载失败，请稍后重试'))
      })
      .finally(() => {
        if (alive) setLoadedKey(loadKey)
      })
    return () => {
      alive = false
    }
  }, [loadKey])

  const summary = stats?.feedback_summary

  const questionColumns: TableProps<{
    question: string
    count: number
    last_at: string | null
  }>['columns'] = [
    {
      title: '问题',
      dataIndex: 'question',
      ellipsis: true,
      render: (question: string) => (
        <Typography.Text style={{ fontSize: 13 }}>{question}</Typography.Text>
      ),
    },
    { title: '次数', dataIndex: 'count', width: 72 },
    {
      title: '最近',
      dataIndex: 'last_at',
      width: 128,
      render: (value: string | null) => (
        <Typography.Text style={{ fontSize: 12 }}>{formatTime(value)}</Typography.Text>
      ),
    },
  ]

  const documentColumns: TableProps<{
    file_uuid: string
    file_name: string
    hits: number
  }>['columns'] = [
    {
      title: '文档',
      dataIndex: 'file_name',
      ellipsis: true,
      render: (name: string, row) =>
        // 文件被删了也不从统计里抹掉（它确实被检索过），只是没有名字可显示
        name ? (
          <Typography.Text style={{ fontSize: 13 }}>{name}</Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            （文件已删除：{row.file_uuid.slice(0, 8)}…）
          </Typography.Text>
        ),
    },
    { title: '被检索次数', dataIndex: 'hits', width: 108 },
  ]

  const reasonColumns: TableProps<{ reason: string; count: number }>['columns'] = [
    { title: '差评原因', dataIndex: 'reason', ellipsis: true },
    { title: '次数', dataIndex: 'count', width: 72 },
  ]

  const scopeColumns: TableProps<{ scope: string; up: number; down: number }>['columns'] = [
    { title: '库', dataIndex: 'scope', render: (scope: string) => scopeLabel(scope) },
    { title: '好评', dataIndex: 'up', width: 72 },
    { title: '差评', dataIndex: 'down', width: 72 },
  ]

  const badCaseColumns: TableProps<ApiBadCase>['columns'] = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 128,
      render: (value: string | null) => (
        <Typography.Text style={{ fontSize: 12 }}>{formatTime(value)}</Typography.Text>
      ),
    },
    {
      title: '问题',
      dataIndex: 'question',
      ellipsis: true,
      render: (question: string) => (
        <Typography.Text style={{ fontSize: 13 }}>{question}</Typography.Text>
      ),
    },
    {
      title: '原因',
      dataIndex: 'reason',
      width: 180,
      ellipsis: true,
      render: (reason: string | null) =>
        reason ? (
          <Tag color="volcano" style={{ marginInlineEnd: 0 }}>
            {reason}
          </Tag>
        ) : (
          '—'
        ),
    },
    {
      title: '库',
      dataIndex: 'scope',
      width: 92,
      render: (scope: string) => scopeLabel(scope),
    },
    {
      title: '用户',
      dataIndex: 'user_uuid',
      width: 96,
      // 只显示 uuid 前 8 位：看板没有"按人追责"的需求，而完整 uuid 截图外传没有好处
      render: (uuid: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {uuid.slice(0, 8)}…
        </Typography.Text>
      ),
    },
  ]

  const summaryColumns: TableProps<{ label: string; value: string }>['columns'] = [
    { title: '指标', dataIndex: 'label', width: 160 },
    { title: '数值', dataIndex: 'value' },
  ]

  const summaryRows = [
    { label: '反馈总数', value: String(summary?.total ?? 0) },
    { label: '好评 👍', value: String(summary?.up ?? 0) },
    { label: '差评 👎', value: String(summary?.down ?? 0) },
    {
      label: '好评率',
      value:
        summary && summary.total
          ? `${Math.round((summary.up_rate ?? 0) * 100)}%（${summary.up} / ${summary.total}）`
          : '暂无反馈',
    },
  ]

  return (
    <div data-testid="admin-dashboard" style={{ padding: 24 }}>
      <Space
        orientation="vertical"
        size={16}
        style={{ width: '100%', maxWidth: 1180, margin: '0 auto' }}
      >
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <div>
            <Typography.Title level={4} style={{ marginBottom: 0 }}>
              📊 运营看板
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前账号：{user.username}
              {stats
                ? ` ｜ 数据截止 ${formatTime(stats.generated_at)}（统计最近 ${stats.window} 次检索）`
                : ''}
            </Typography.Text>
          </div>
          <Space>
            <Button onClick={() => void navigate('/chat')}>返回对话</Button>
            <Button type="primary" loading={loading} onClick={() => setReloadKey((k) => k + 1)}>
              刷新
            </Button>
          </Space>
        </Space>

        {error && (
          <Alert
            type="error"
            showIcon
            title={error}
            action={
              <Button size="small" onClick={() => setReloadKey((k) => k + 1)}>
                重试
              </Button>
            }
          />
        )}

        <Row gutter={16}>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="窗口内检索次数"
                value={stats?.retrieval_total ?? 0}
                loading={loading}
                suffix="次"
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="无结果问题（按问题去重）"
                value={stats?.no_result_queries.length ?? 0}
                loading={loading}
                suffix="个"
                valueStyle={
                  (stats?.no_result_queries.length ?? 0) > 0 ? { color: '#cf1322' } : undefined
                }
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="反馈总数"
                value={summary?.total ?? 0}
                loading={loading}
                suffix={`（👎 ${summary?.down ?? 0}）`}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="好评率"
                value={summary?.total ? Math.round((summary.up_rate ?? 0) * 100) : 0}
                loading={loading}
                suffix={summary?.total ? '%' : '（暂无反馈）'}
              />
            </Card>
          </Col>
        </Row>

        <Panel
          title="🔥 高频提问"
          hint="同一模式下被问得最多的问题"
          testId="admin-top-questions"
          rowKey="question"
          loading={loading}
          columns={questionColumns}
          rows={stats?.top_questions ?? []}
          emptyText="还没有提问记录（问一次之后这里就有数据了）"
        />

        <Panel
          title="⚠️ 检索无结果的问题"
          hint="这些是最该补资料的信号"
          testId="admin-no-result"
          rowKey="question"
          loading={loading}
          columns={questionColumns}
          rows={stats?.no_result_queries ?? []}
          emptyText="很好：窗口内没有检索不到结果的问题"
        />

        <Panel
          title="📄 被检索最多的文档"
          hint="召回到就算一次（与最终答没答上无关）"
          testId="admin-top-documents"
          rowKey="file_uuid"
          loading={loading}
          columns={documentColumns}
          rows={stats?.top_documents ?? []}
          emptyText="还没有检索命中的文档"
        />

        <Row gutter={16}>
          <Col span={10}>
            <Panel
              title="👍👎 反馈汇总"
              testId="admin-feedback-summary"
              rowKey="label"
              loading={loading}
              columns={summaryColumns}
              rows={summaryRows}
              emptyText="暂无反馈"
            />
          </Col>
          <Col span={7}>
            <Panel
              title="按库分布"
              testId="admin-feedback-scope"
              rowKey="scope"
              loading={loading}
              columns={scopeColumns}
              rows={summary?.by_scope ?? []}
              emptyText="暂无反馈"
            />
          </Col>
          <Col span={7}>
            <Panel
              title="差评原因 Top 5"
              testId="admin-feedback-reasons"
              rowKey="reason"
              loading={loading}
              columns={reasonColumns}
              rows={summary?.top_reasons ?? []}
              emptyText="暂无差评原因"
            />
          </Col>
        </Row>

        <Panel
          title="🐞 最近的差评样本"
          hint="用户点了 👎（或提交了「资料缺失」）的问答"
          testId="admin-bad-cases"
          rowKey="id"
          loading={loading}
          columns={badCaseColumns}
          rows={badCases}
          emptyText="还没有差评，挺好"
        />
      </Space>
    </div>
  )
}

