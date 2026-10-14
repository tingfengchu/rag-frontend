import { useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, App as AntdApp, Button, Modal, Space, Tag, Typography } from 'antd'

import {
  FetchHttpError,
  citationScoreLabel,
  downloadFile,
  previewFile,
  scopeLabel,
} from '../api/client'
import type { Citation } from '../api/client'

/** 一行"字段名 + 值"（弹窗里的元信息区）。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, minWidth: 56 }}>
        {label}
      </Typography.Text>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

/**
 * 引用溯源弹窗（文件管理模块）。
 *
 * 用户点开一条引用时最想知道两件事，这个弹窗就是按这两件事排的：
 *
 * 1. **证据是什么** —— 命中的那段原文（``excerpt``）。只给"文件名 + 第 12 页"等于
 *    让用户自己翻，那正是"引用不可点"时代的体验；
 * 2. **出处能不能拿到** —— 「查看原文」在新标签页里**直接翻到那一页**（PDF 支持 ``#page=N``，
 *    不必先下载再手翻）；「下载原文」把原件存到本地。后端按 scope 判权限，
 *    别人的私人库会回 403「无下载权限 / 无预览权限，请联系管理员」，这里原样展示后端文案。
 *
 * 老数据（老缓存里的引用）没有 ``file_uuid`` / ``excerpt``：如实说明，并把两个按钮都禁用。
 * 不用文件名去猜测 uuid —— 猜错就是把**别人的文档**下给用户。
 */
export default function SourceTraceModal({
  citation,
  onClose,
}: {
  citation: Citation | null
  onClose: () => void
}) {
  const { message } = AntdApp.useApp()
  const navigate = useNavigate()
  const [downloading, setDownloading] = useState(false)
  /** 正在取预览原件（要等字节回来才能开标签页，所以按钮得转圈） */
  const [previewing, setPreviewing] = useState(false)

  const open = citation !== null
  const canDownload = Boolean(citation?.file_uuid)

  /** 下载 / 预览共用的失败处理（两者都走 fetch，到不了 axios 的全局 401 拦截器）。 */
  const reportFetchError = (err: unknown, fallback: string) => {
    if (err instanceof FetchHttpError && err.status === 401) {
      message.error('登录状态已失效，请重新登录')
      navigate('/login', { replace: true })
      return
    }
    // 403 的文案就是后端那句（「无下载权限…」/「无预览权限…」）——不在这里另编一句，
    // 否则界面说的和接口说的会慢慢不是一回事
    message.error(err instanceof FetchHttpError ? err.message : fallback)
  }

  const handleDownload = async () => {
    if (!citation?.file_uuid) return
    setDownloading(true)
    try {
      await downloadFile({ file_uuid: citation.file_uuid, file_name: citation.source })
      message.success(`已开始下载 ${citation.source}`)
    } catch (err) {
      reportFetchError(err, '下载失败，请稍后重试')
    } finally {
      setDownloading(false)
    }
  }

  /**
   * 「查看原文」：在新标签页里打开原件，并**带上这条引用所在的页码**（``#page=N``）。
   *
   * 这是这个弹窗最该有的一步：弹窗说了\"第 N 页\"，可用户手上没有 PDF 就无从对照——
   * \"先下载、再翻到第 N 页\"这条链路里最容易出错的那一步，原先由用户手工完成。
   * PDF 之外的类型（Word 等）后端只会回 attachment，预览会自动降级成下载并提示。
   */
  const handlePreview = async () => {
    if (!citation?.file_uuid) return
    setPreviewing(true)
    try {
      const outcome = await previewFile(
        { file_uuid: citation.file_uuid, file_name: citation.source },
        citation.page,
      )
      if (outcome === 'download') {
        message.info(`${citation.source} 无法在浏览器里直接预览，已改为下载`)
      }
    } catch (err) {
      reportFetchError(err, '预览失败，请稍后重试')
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <Modal
      open={open}
      title="引用出处"
      onCancel={onClose}
      mask={{ closable: true }}
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button
          key="preview"
          data-testid="trace-preview"
          loading={previewing}
          disabled={!canDownload}
          onClick={() => void handlePreview()}
        >
          查看原文
        </Button>,
        <Button
          key="download"
          type="primary"
          data-testid="trace-download"
          loading={downloading}
          disabled={!canDownload}
          onClick={() => void handleDownload()}
        >
          下载原文
        </Button>,
      ]}
    >
      <div data-testid="source-trace-modal">
        <Field label="文件名">
          <Typography.Text strong>{citation?.source}</Typography.Text>
        </Field>

        <Field label="页码">
          <Typography.Text>第 {citation?.page} 页</Typography.Text>
        </Field>

        {citation?.scope && (
          <Field label="所在库">
            <Tag>{scopeLabel(citation.scope)}</Tag>
          </Field>
        )}

        <Field label="置信度">
          {/* 与 Tag 上的 hover 文案同源：0.999 不显示成 1.00，没有分数就说"未做分数门控" */}
          <Typography.Text data-testid="trace-confidence">
            {citationScoreLabel(citation?.rerank_score)}
          </Typography.Text>
        </Field>

        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            命中片段
          </Typography.Text>
          {citation?.excerpt ? (
            <div
              data-testid="trace-excerpt"
              style={{
                marginTop: 4,
                maxHeight: 220,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                background: 'rgba(0,0,0,0.02)',
                border: '1px solid rgba(0,0,0,0.08)',
                borderRadius: 6,
                padding: 8,
                fontSize: 13,
              }}
            >
              {citation.excerpt}
            </div>
          ) : (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 4 }}
              title="这条引用来自旧缓存，没有保存片段摘录。"
            />
          )}
        </div>

        {!canDownload && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            title="这条引用没有文件标识（来自旧缓存），无法定位原件，因此不能下载。"
          />
        )}

        <Space size={4} style={{ marginTop: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {/* 让人知道"打不开"时该找谁，而不是以为按钮坏了 */}
            若提示无下载权限 / 无预览权限，说明该文档属于他人的私人库，请联系管理员。
          </Typography.Text>
        </Space>
      </div>
    </Modal>
  )
}
