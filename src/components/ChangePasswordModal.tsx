import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, App as AntdApp, Form, Input, Modal } from 'antd'

import { changePassword, extractErrorMessage } from '../api/client'
import type { PasswordChangePayload } from '../api/client'

/**
 * 密码最小长度。**必须与后端 `utils/passwords.py` 的规则一致**：
 * 前端放宽就等于让用户填完表单才吃 400；前端收紧则会把后端本来能接受的密码挡掉。
 * （后端才是唯一权威，这里只是"提前告知"。）
 */
const MIN_PASSWORD_LEN = 8

interface FormValues extends PasswordChangePayload {}

/**
 * 修改密码弹窗（模块 2.1）。
 *
 * 三个字段都要：当前密码（否则拿到 Cookie 就等于拿到账号）、
 * 新密码、确认新密码（防手滑打错，改完就登不进去了）。
 *
 * ⚠️ 成功后必须跳 /login：后端在改密码成功时会**吊销该用户全部会话**并清掉 Cookie，
 * 留在 /chat 上的下一个请求就是 401。主动跳转 + 明确提示，比让用户撞一次 401 更清楚。
 */
export default function ChangePasswordModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [form] = Form.useForm<FormValues>()
  const { message } = AntdApp.useApp()
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)

  // 每次打开都从空白开始：上一次输到一半的密码留在框里是纯粹的惊吓
  useEffect(() => {
    if (open) form.resetFields()
  }, [open, form])

  const submit = async () => {
    let values: FormValues
    try {
      values = await form.validateFields()
    } catch {
      return // 校验失败：antd 已在字段下方给出原因
    }

    setSubmitting(true)
    try {
      await changePassword(values)
      onClose()
      message.success('密码已修改，请重新登录')
      navigate('/login', { replace: true })
    } catch (err) {
      // 后端的中文文案直接展示（例如"新密码不能与当前密码相同"、"密码至少 8 位"）
      message.error(extractErrorMessage(err, '修改密码失败，请稍后重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title="修改密码"
      okText="确认修改"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      // antd v6：`maskClosable` 已弃用，改成 mask.closable（提交中禁止误点遮罩关掉弹窗）
      mask={{ closable: !submitting }}
    >
      <Alert
        type="warning"
        showIcon
        title="修改成功后所有设备上的登录都会失效，需要用新密码重新登录。"
        style={{ marginBottom: 12 }}
      />

      <Form<FormValues> form={form} layout="vertical" autoComplete="off" requiredMark={false}>
        <Form.Item
          name="old_password"
          label="当前密码"
          rules={[{ required: true, message: '请输入当前密码' }]}
        >
          <Input.Password placeholder="当前密码" autoComplete="current-password" />
        </Form.Item>

        <Form.Item
          name="new_password"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: MIN_PASSWORD_LEN, message: `新密码至少 ${MIN_PASSWORD_LEN} 位` },
            // 与"当前密码"比较必须放在 validator 里：`dependencies` 只负责触发重校验，
            // 真正的判据要实时读另一个字段（react-hook 式的静态 rules 读不到）
            ({ getFieldValue }) => ({
              validator(_rule, value: string) {
                if (value && value === getFieldValue('old_password')) {
                  return Promise.reject(new Error('新密码不能与当前密码相同'))
                }
                return Promise.resolve()
              },
            }),
          ]}
        >
          <Input.Password placeholder={`至少 ${MIN_PASSWORD_LEN} 位`} autoComplete="new-password" />
        </Form.Item>

        <Form.Item
          name="confirm_password"
          label="确认新密码"
          dependencies={['new_password']}
          rules={[
            { required: true, message: '请再输入一次新密码' },
            ({ getFieldValue }) => ({
              validator(_rule, value: string) {
                if (!value || value === getFieldValue('new_password')) return Promise.resolve()
                return Promise.reject(new Error('两次输入的新密码不一致'))
              },
            }),
          ]}
        >
          <Input.Password placeholder="再输入一次新密码" autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
