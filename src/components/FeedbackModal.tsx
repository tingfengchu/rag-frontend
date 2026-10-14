import { useEffect, useState } from 'react'
import { Alert, App as AntdApp, Form, Input, Modal, Typography } from 'antd'

import { extractErrorMessage, submitFeedback } from '../api/client'
import type { Citation } from '../api/client'

/**
 * 「资料缺失」是运营最想要的那类信号：它直接告诉管理员"该补什么资料"。
 * 做成默认原因，用户不用自己想措辞（想补充就写在下面的说明里）。
 */
export const REASON_MISSING_DOCS = '资料缺失'

interface FormValues {
  question: string
  detail?: string
}

/**
 * 「资料缺失 / 建议反馈」弹窗（模块 6）。
 *
 * 为什么单独一个弹窗、而不是只留一个 👎：
 * 👎 只能表达"这次答得不好"，**说不了原因**；而运营要的是"哪份资料该补"。
 * 这里提交的永远是 ``rating='down'``（这是负反馈收集，不是评分），
 * ``reason`` 固定以「资料缺失」开头，用户的补充说明接在后面——
 * 后端 ``feedback_summary.top_reasons`` 按 reason 聚合，前缀一致才能聚成一类。
 *
 * ``question`` 默认填**最近一次提问**（可改）：空着提交的话，那条 bad case
 * 在运营看板上就是一行没有问题的记录，谁都不知道该去补什么。
 */
export default function FeedbackModal({
  open,
  onClose,
  scope,
  defaultQuestion,
  answer,
  citations,
  onSubmitted,
}: {
  open: boolean
  onClose: () => void
  /** 当前检索模式（``public`` / ``private:<uuid>`` / ``both``） */
  scope: string
  defaultQuestion: string
  answer?: string
  citations?: Citation[]
  /** 提交成功回调：把服务端算好的 q_hash 交回去，供 ChatPage 标记「已反馈」 */
  onSubmitted: (qHash: string) => void
}) {
  const [form] = Form.useForm<FormValues>()
  const { message } = AntdApp.useApp()
  const [submitting, setSubmitting] = useState(false)

  // 每次打开都用"当下这条提问"重置：上一次留下的问题文本与这一次对不上，
  // 提交出去就是一条张冠李戴的 bad case。
  useEffect(() => {
    if (open) form.setFieldsValue({ question: defaultQuestion, detail: '' })
  }, [open, defaultQuestion, form])

  const submit = async () => {
    let values: FormValues
    try {
      values = await form.validateFields()
    } catch {
      return // 校验失败：antd 已在字段下方给出原因
    }

    setSubmitting(true)
    try {
      const detail = values.detail?.trim()
      const result = await submitFeedback({
        scope,
        question: values.question.trim(),
        answer: answer ?? null,
        citations,
        rating: 'down',
        reason: detail ? `${REASON_MISSING_DOCS}：${detail}` : REASON_MISSING_DOCS,
      })
      message.success(result.message)
      onSubmitted(result.q_hash)
      onClose()
    } catch (err) {
      message.error(extractErrorMessage(err, '反馈提交失败，请稍后重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title="资料缺失 / 建议反馈"
      okText="提交反馈"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      mask={{ closable: !submitting }}
    >
      <Alert
        type="info"
        showIcon
        title="告诉我们知识库里缺了什么：管理员会照着补充资料，之后同样的问题就能答上了。"
        style={{ marginBottom: 12 }}
      />

      <Form<FormValues> form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="question"
          label="问题"
          rules={[{ required: true, message: '请填写你问的问题' }]}
        >
          <Input placeholder="例如：XX 项目的交付时间是什么时候？" />
        </Form.Item>

        <Form.Item name="detail" label="补充说明（选填）">
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder="例如：应该在某份需求文档里，但检索不到"
          />
        </Form.Item>
      </Form>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        提交后会记成一条「资料缺失」负反馈（评价方向 = 👎），
        可随时在运营看板里查看。
      </Typography.Text>
    </Modal>
  )
}