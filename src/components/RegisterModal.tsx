import { useEffect, useState } from 'react'
import { Alert, App as AntdApp, Form, Input, Modal } from 'antd'

import { extractErrorMessage, registerAccount } from '../api/client'

/** 与后端 `utils/passwords.py` 一致的最小长度（前端只是提前告知，权威判定在后端）。 */
const MIN_PASSWORD_LEN = 8

interface FormValues {
  username: string
  password: string
  confirm_password: string
}

/**
 * 注册弹窗（模块 2.2）。
 *
 * 只在后端 `GET /auth/config` 的 `allow_register=true` 时才可能被打开——
 * 但**前端隐藏入口不等于关闭通道**：真正的闸门在 `POST /api/auth/register`
 * （关着时直接 403）。这里做的是"别让用户白填一遍表单"。
 *
 * 注册成功**不自动登录**：直接跳回登录页并提示，让用户用新密码走一次正常登录流程
 * （自动登录会掩盖"密码记错"这类问题，也少一次对会话链路的验证）。
 */
export default function RegisterModal({
  open,
  onClose,
  onRegistered,
}: {
  open: boolean
  onClose: () => void
  /** 注册成功回调：把用户名回填到登录表单，省得用户再打一遍。 */
  onRegistered?: (username: string) => void
}) {
  const [form] = Form.useForm<FormValues>()
  const { message } = AntdApp.useApp()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) form.resetFields()
  }, [open, form])

  const submit = async () => {
    let values: FormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }

    setSubmitting(true)
    try {
      const user = await registerAccount({
        username: values.username,
        password: values.password,
      })
      onClose()
      onRegistered?.(user.username)
      message.success('注册成功，请登录')
    } catch (err) {
      // 常见错误：用户名已存在（409）、密码太短（400）、注册已关闭（403）——文案都由后端给
      message.error(extractErrorMessage(err, '注册失败，请稍后重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title="注册新账号"
      okText="注册"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      // antd v6：`maskClosable` 已弃用，改成 mask.closable（提交中禁止误点遮罩关掉弹窗）
      mask={{ closable: !submitting }}
    >
      <Alert
        type="info"
        showIcon
        title="新账号只能上传到自己的私人库；上传公共库需要管理员授权。"
        style={{ marginBottom: 12 }}
      />

      <Form<FormValues> form={form} layout="vertical" autoComplete="off" requiredMark={false}>
        <Form.Item
          name="username"
          label="用户名"
          rules={[
            { required: true, message: '请输入用户名' },
            { max: 64, message: '用户名不超过 64 个字符' },
          ]}
        >
          <Input placeholder="用户名" autoComplete="username" />
        </Form.Item>

        <Form.Item
          name="password"
          label="密码"
          rules={[
            { required: true, message: '请输入密码' },
            { min: MIN_PASSWORD_LEN, message: `密码至少 ${MIN_PASSWORD_LEN} 位` },
          ]}
        >
          <Input.Password placeholder={`至少 ${MIN_PASSWORD_LEN} 位`} autoComplete="new-password" />
        </Form.Item>

        <Form.Item
          name="confirm_password"
          label="确认密码"
          dependencies={['password']}
          rules={[
            { required: true, message: '请再输入一次密码' },
            ({ getFieldValue }) => ({
              validator(_rule, value: string) {
                if (!value || value === getFieldValue('password')) return Promise.resolve()
                return Promise.reject(new Error('两次输入的密码不一致'))
              },
            }),
          ]}
        >
          <Input.Password placeholder="再输入一次密码" autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
