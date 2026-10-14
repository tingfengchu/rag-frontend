import { expect, test } from '@playwright/test'

import { antdButton, registerTempUser } from './helpers'

/**
 * 模块 4：检索范围端到端（真前端 + 真后端 + 真检索 + 真 LLM）。
 *
 * 验证三件事：
 *   1. 侧栏默认就是「两者一起」（both），控件上能看到；
 *   2. 提问后回答气泡**上方**出现「检索范围：…」；
 *   3. 新用户的私人库还是空的 → 标注显示"公共库"（而不是硬报 both），
 *      因为后端会把空库从 `scopes` 里剔除（这正是"不撒谎"的设计）。
 *
 * 这个用例会真调一次 LLM（10~30 秒），所以超时给得比较宽。
 * 需要 `allow_register=true`（用例自己建临时账号）。
 */
test.describe('检索范围（模块 4）', () => {
  test('默认 both，回答气泡标注实际检索范围', async ({ page, request }) => {
    test.setTimeout(180_000)

    const password = 'E2eScope_123!'
    const username = await registerTempUser(request, 'e2e_scope', password)
    test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

    await page.goto('/login')
    await page.getByLabel('用户名').fill(username as string)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await antdButton(page, '登录').click()
    await expect(page).toHaveURL(/\/chat/)

    // 1) 默认就是 both：选项被选中 + 侧栏给出模式说明
    const bothRadio = page.getByRole('radio', {
      name: '两者一起（公共库 + 我的私人库）',
    })
    await expect(bothRadio).toBeChecked()
    await expect(page.getByText('both（公共库 + 我的私人库）')).toBeVisible()

    // 2) 提问（用公共库里确实存在的内容，避免"没搜到"把用例搞成假失败）
    await page.getByPlaceholder(/输入你的问题/).fill('张嘉亮的手机号是多少？')
    await antdButton(page, '发送').click()

    // 3) 气泡上方出现检索范围标注：私人库为空 → 标注"公共库"，**并说明私人库为什么没查**
    //    （UI 修复：只写"公共库"会让用户以为自己的文档根本没被检索）
    await expect(
      page.getByText('检索范围：公共库（我的私人库为空，已跳过）'),
    ).toBeVisible({ timeout: 120_000 })

    // 4) 切到"我的私人库"（空库）→ 提问应该拿到明确的"还没有文档"提示，而不是静默空转
    // exact: true 是必须的：第三个选项文案"两者一起（公共库 + 我的私人库）"里**包含**
    // "我的私人库"，不加 exact 会同时命中两个 radio（strict mode violation）。
    await page.getByRole('radio', { name: '我的私人库', exact: true }).click()
    await page.getByPlaceholder(/输入你的问题/).fill('这里有什么？')
    await antdButton(page, '发送').click()
    await expect(page.getByText(/还没有文档/)).toBeVisible({ timeout: 60_000 })
  })
})

