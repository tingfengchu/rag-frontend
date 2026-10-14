import { expect, test } from '@playwright/test'

import { antdButton, loginForm, registerTempUser } from './helpers'

/**
 * 模块 2.2：注册入口的开关（真前端 + 真后端）。
 *
 * 两条路都验：
 * * `allow_register=false`（默认）→ 登录页**不显示**"没有账号？立即注册"，
 *   并且直接打接口也会被拒（403）——前端藏入口不等于关掉通道；
 * * `allow_register=true`（演示时在 `rag_config.txt` 里打开）→ 入口出现，
 *   注册成功后提示"注册成功，请登录"、用户名回填、用新账号能登录。
 */
test.describe('注册开关（模块 2.2）', () => {
  test('入口显示与后端开关一致，且关着时接口也拒绝', async ({ page, request }) => {
    const config = await (await request.get('/api/auth/config')).json()
    await page.goto('/login')

    const link = page.getByRole('button', { name: '没有账号？立即注册' })

    if (!config.allow_register) {
      await expect(link).toHaveCount(0)

      // 关键：关着的时候必须连接口一起拒（否则"关闭注册"只是个摆设）
      const denied = await request.post('/api/auth/register', {
        data: { username: `e2e_blocked_${Date.now().toString(36)}`, password: 'Whatever_123!' },
      })
      expect(denied.status()).toBe(403)
      return
    }

    await expect(link).toBeVisible()
    await link.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const username = `e2e_reg_${Date.now().toString(36)}`
    const password = 'E2eReg_789!'
    await dialog.getByLabel('用户名').fill(username)
    await dialog.getByLabel('密码', { exact: true }).fill(password)
    await dialog.getByLabel('确认密码').fill(password)
    await antdButton(dialog, '注册').click()

    await expect(page.getByText('注册成功，请登录')).toBeVisible()
    // 用户名已回填到登录表单（省得用户再打一遍），密码留空。
    // 这里必须限定在登录表单内：注册弹窗关掉后仍在 DOM 里，`page.getByLabel('用户名')` 会匹配到两个。
    const form = loginForm(page)
    await expect(form.getByLabel('用户名')).toHaveValue(username)
    await expect(page).toHaveURL(/\/login/)

    // 用新账号登录
    await form.getByLabel('密码', { exact: true }).fill(password)
    await antdButton(form, '登录').click()
    await expect(page).toHaveURL(/\/chat/)
  })

  test('密码不一致时前端先拦住，不打接口', async ({ page, request }) => {
    const username = await registerTempUser(request, 'e2e_reg_check', 'Whatever_123!')
    test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能看到注册入口')

    await page.goto('/login')
    await page.getByRole('button', { name: '没有账号？立即注册' }).click()
    const dialog = page.getByRole('dialog')

    await dialog.getByLabel('用户名').fill(`${username}_x`)
    await dialog.getByLabel('密码', { exact: true }).fill('E2eReg_789!')
    await dialog.getByLabel('确认密码').fill('E2eReg_789?')
    await antdButton(dialog, '注册').click()

    await expect(dialog.getByText('两次输入的密码不一致')).toBeVisible()
    await expect(dialog).toBeVisible() // 没提交成功 → 弹窗不关
  })
})

