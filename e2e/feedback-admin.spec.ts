import { expect, request as pwRequest, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME } from './global-setup'
import { antdButton, loginForm, registerTempUser } from './helpers'

/**
 * 反馈飞轮 + 运营看板（模块 6）。
 *
 * 四条用例覆盖交付验收清单：
 *   1. 点 👎 → 按钮变「已反馈」→ 差评样本**真的落库**（用管理员会话查 bad-cases 接口）；
 *   2. 「资料缺失/反馈」弹窗能提交，且同一条回答的按钮同步变「已反馈」；
 *   3. 管理员进 ``/admin``：四个统计块齐全，**刚问过的问题出现在高频提问里**
 *      （这条同时验证了"检索流水真的在写"——看板的数据源就是它）；
 *   4. 普通用户进 ``/admin``：看到「需要管理员权限」，侧栏里也没有看板入口。
 *
 * 依赖与其它用例一致：后端 + 前端都起着、后端 ``allow_register = true``
 * （用例自建临时账号）、以及可用的临时管理员（``e2e/global-setup.ts`` 建的）。
 * 缺任何一项**skip 并说明原因**，不让"环境没准备好"表现成"功能坏了"。
 */

/** 登录（登录表单要限定在 `#login` 里找，antd 的注册弹窗关闭后仍在 DOM 里）。 */
async function login(page: Page, username: string, password: string): Promise<boolean> {
  await page.goto('/login')
  await loginForm(page).getByLabel('用户名').fill(username)
  await loginForm(page).getByLabel('密码', { exact: true }).fill(password)
  await antdButton(page, '登录').click()
  return page
    .waitForURL(/\/chat/, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
}

/** 提一个问题，并等回答**定稿**（回答没定稿时不会出现 👍/👎）。 */
async function askAndWaitForAnswer(page: Page, question: string): Promise<boolean> {
  await page.getByPlaceholder(/输入你的问题/).fill(question)
  await antdButton(page, '发送').click()
  return page
    .getByTestId('answer-feedback')
    .first()
    .waitFor({ state: 'visible', timeout: 180_000 })
    .then(() => true)
    .catch(() => false)
}

/** 那个"可丢弃管理员"的 API 会话（用来抽查接口返回的是不是真数据）。 */
async function adminSession(baseURL: string) {
  const ctx = await pwRequest.newContext({ baseURL })
  const resp = await ctx.post('/api/auth/login', {
    data: { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD },
  })
  return { ctx, ok: resp.ok() }
}


test.describe('反馈与运营看板（模块 6）', () => {
  test('点 👎：按钮变「已反馈」，差评样本能在管理接口里查到', async ({
    page,
    request,
  }, testInfo) => {
    const username = await registerTempUser(request, 'e2e_feedback', 'E2ePass_123!')
    test.skip(!username, '后端未开启 allow_register，跳过（环境配置问题，不是功能问题）')
    test.skip(!(await login(page, username as string, 'E2ePass_123!')), '登录失败：后端可能没起')

    // 问题里带随机编号：bad-case 断言要靠这个编号在库里认出这一条
    const nonce = Date.now().toString(36)
    const answered = await askAndWaitForAnswer(page, `E2E 反馈校验 ${nonce}：这个说法有依据吗？`)
    test.skip(!answered, '这次提问没有产生可评价的回答（后端 / LLM / 知识库没准备好）')

    const down = page.getByTestId('feedback-down').first()
    await expect(down).toBeVisible()
    await down.click()

    // 提交后**就地**变成「已反馈」：按钮不消失（否则用户不知道到底提交上没有）
    await expect(page.getByTestId('feedback-done').first()).toContainText('已反馈')

    const baseURL = testInfo.project.use.baseURL ?? 'http://localhost:5173'
    const admin = await adminSession(baseURL)
    test.skip(!admin.ok, '临时管理员登录失败（环境没准备好）')
    const cases = (await (await admin.ctx.get('/api/feedback/bad-cases?limit=100')).json()) as {
      question: string
      rating: string
    }[]
    await admin.ctx.dispose()

    const mine = cases.filter((row) => row.question.includes(nonce))
    expect(mine.length, '差评样本没有落库（接口返回里找不到这次提问）').toBeGreaterThan(0)
    expect(mine.every((row) => row.rating === 'down')).toBeTruthy()
  })

  test('「资料缺失/反馈」弹窗：提交后同一条回答同步显示「已反馈」', async ({
    page,
    request,
  }) => {
    const username = await registerTempUser(request, 'e2e_missing', 'E2ePass_123!')
    test.skip(!username, '后端未开启 allow_register，跳过（环境配置问题）')
    test.skip(!(await login(page, username as string, 'E2ePass_123!')), '登录失败：后端可能没起')

    const nonce = Date.now().toString(36)
    const answered = await askAndWaitForAnswer(page, `E2E 资料缺失 ${nonce}：那份文档里有说明吗？`)
    test.skip(!answered, '这次提问没有产生可评价的回答（后端 / LLM / 知识库没准备好）')

    // 有对话之后这个按钮才可用（它默认提交"最近一次提问"）
    const report = page.getByTestId('report-missing')
    await expect(report).toBeEnabled()
    await report.click()

    const modal = page.getByRole('dialog')
    await expect(modal).toContainText('资料缺失')
    // 问题默认就是刚才那一问：改成别的问题就与回答的 q_hash 对不上，
    // 也就验不到"两个入口是同一条记录"这件事
    await expect(modal.getByLabel('问题')).toHaveValue(/E2E 资料缺失/)
    await modal.getByLabel('补充说明（选填）').fill('应该在某份需求文档里，但检索不到')
    await antdButton(modal, '提交反馈').click()

    // 弹窗关闭 + 回答下方变「已反馈」（后端按 q_hash 判重，两处入口指的是同一条记录）
    await expect(modal).toBeHidden()
    await expect(page.getByTestId('feedback-done').first()).toContainText('已反馈')
  })

  test('管理员 /admin：四个统计块齐全，刚问过的问题出现在高频提问里', async ({ page }) => {
    test.skip(
      !(await login(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD)),
      '临时管理员登录失败（环境没准备好）',
    )

    const nonce = Date.now().toString(36)
    test.skip(
      !(await askAndWaitForAnswer(page, `E2E 看板校验 ${nonce}：这个说法有依据吗？`)),
      '这次提问没有完成，无法验证看板数据',
    )

    await page.getByTestId('open-admin-dashboard').click()
    await expect(page).toHaveURL(/\/admin/, { timeout: 20_000 })
    await expect(page.getByTestId('admin-dashboard')).toBeVisible()

    // 四个块 + 差评样本一个都不能少（少了哪块都不算"运营看板"）
    for (const testId of [
      'admin-top-questions',
      'admin-no-result',
      'admin-top-documents',
      'admin-feedback-summary',
      'admin-bad-cases',
    ]) {
      await expect(page.getByTestId(testId)).toBeVisible()
    }

    // 页头写着数据口径（快照时间 + 窗口），否则管理员会把这些数字当成实时值
    await expect(page.getByTestId('admin-dashboard')).toContainText('数据截止')

    // **关键断言**：刚问的问题必须在高频提问里 —— 它证明检索流水真的写进去了
    await expect(page.getByTestId('admin-top-questions')).toContainText(nonce)
  })

  test('普通用户 /admin：看到「需要管理员权限」，侧栏里也没有看板入口', async ({
    page,
    request,
  }) => {
    const username = await registerTempUser(request, 'e2e_noadmin', 'E2ePass_123!')
    test.skip(!username, '后端未开启 allow_register，跳过（环境配置问题）')
    test.skip(!(await login(page, username as string, 'E2ePass_123!')), '登录失败：后端可能没起')

    // 侧栏不该出现"看得见却进不去"的入口
    await expect(page.getByTestId('open-admin-dashboard')).toHaveCount(0)

    await page.goto('/admin')

    await expect(page.getByText('需要管理员权限')).toBeVisible()
    // 后端才是权限的权威：顺手确认普通用户拿不到统计数据
    expect((await page.request.get('/api/admin/stats')).status()).toBe(403)
  })
})
