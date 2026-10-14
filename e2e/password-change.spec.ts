import { expect, test } from '@playwright/test'

import { antdButton, registerTempUser } from './helpers'

/**
 * 模块 2.1：修改密码链路的端到端验收（真前端 + 真后端 + 真 MySQL/Redis）。
 *
 * 覆盖用户在界面上真正走的四步：
 *   1. 用初始密码登录 → 进 `/chat`；
 *   2. 顶栏「修改密码」→ 填 当前密码 + 新密码 ×2 → 提交；
 *   3. 被踢回 `/login`（后端吊销该用户**全部会话**并清 Cookie，前端主动跳转）并看到提示；
 *   4. 旧密码失效（401 报"用户名或密码错误"）、新密码可登录。
 *
 * 账号：用例自己注册临时账号 `e2e_pwd_<随机>`，**绝不碰真实账号的密码**。
 * 前提：`rag_config.txt` 里 `allow_register = true`（模块 2.2 的开关，默认关闭）；
 *       没打开就 skip 并说明原因（而不是让用例红着）。
 */
const OLD_PASSWORD = 'E2eOld_123!'
const NEW_PASSWORD = 'E2eNew_456!'

/** 注册并登录一个临时账号，返回用户名。 */
async function loginWithTempAccount(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
): Promise<string> {
  const username = await registerTempUser(request, 'e2e_pwd', OLD_PASSWORD)
  test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

  await page.goto('/login')
  await page.getByLabel('用户名').fill(username as string)
  await page.getByLabel('密码', { exact: true }).fill(OLD_PASSWORD)
  await antdButton(page, '登录').click()
  await expect(page).toHaveURL(/\/chat/)

  return username as string
}

test.describe('修改密码（模块 2.1）', () => {
  test('登录 → 改密码 → 被踢回登录页 → 旧密码失效、新密码可登录', async ({
    page,
    request,
  }) => {
    const username = await loginWithTempAccount(page, request)

    // 2) 打开弹窗并提交
    await antdButton(page, '修改密码').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('当前密码').fill(OLD_PASSWORD)
    await dialog.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await dialog.getByLabel('确认新密码').fill(NEW_PASSWORD)
    await antdButton(dialog, '确认修改').click()

    // 3) 被踢回 /login（后端已吊销全部会话）
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByText('密码已修改，请重新登录')).toBeVisible()

    // 4) 旧密码必须失效（证明是服务端吊销，不是"清了个 Cookie"）
    await page.getByLabel('用户名').fill(username)
    await page.getByLabel('密码', { exact: true }).fill(OLD_PASSWORD)
    await antdButton(page, '登录').click()
    await expect(page.getByText('用户名或密码错误')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)

    // 5) 新密码可登录
    await page.getByLabel('密码', { exact: true }).fill(NEW_PASSWORD)
    await antdButton(page, '登录').click()
    await expect(page).toHaveURL(/\/chat/)
  })

  test('前端校验：长度 / 与当前密码相同 / 两次不一致，都不让提交', async ({ page, request }) => {
    const username = await loginWithTempAccount(page, request)

    await antdButton(page, '修改密码').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('当前密码').fill(OLD_PASSWORD)

    // 太短
    await dialog.getByLabel('新密码', { exact: true }).fill('short')
    await dialog.getByLabel('确认新密码').fill('short')
    await antdButton(dialog, '确认修改').click()
    await expect(dialog.getByText('新密码至少 8 位')).toBeVisible()

    // 与当前密码相同
    await dialog.getByLabel('新密码', { exact: true }).fill(OLD_PASSWORD)
    await antdButton(dialog, '确认修改').click()
    await expect(dialog.getByText('新密码不能与当前密码相同')).toBeVisible()

    // 两次不一致
    await dialog.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await dialog.getByLabel('确认新密码').fill(`${NEW_PASSWORD}x`)
    await antdButton(dialog, '确认修改').click()
    await expect(dialog.getByText('两次输入的新密码不一致')).toBeVisible()

    // 一次都没提交成功 → 仍然停在 /chat，弹窗没关，也没出现"假成功"提示
    await expect(page).toHaveURL(/\/chat/)
    await expect(dialog).toBeVisible()
    await expect(page.getByText('密码已修改，请重新登录')).toHaveCount(0)

    // 用真实密码改一次，确认校验通过时能提交（避免"全部被前端拦死"这种反向故障）
    await dialog.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await dialog.getByLabel('确认新密码').fill(NEW_PASSWORD)
    await antdButton(dialog, '确认修改').click()
    await expect(page).toHaveURL(/\/login/)

    // 清理痕迹：把临时账号的密码改回原值（下次跑同名前缀的用例不受影响）
    await page.getByLabel('用户名').fill(username)
    await page.getByLabel('密码', { exact: true }).fill(NEW_PASSWORD)
    await antdButton(page, '登录').click()
    await expect(page).toHaveURL(/\/chat/)
    await antdButton(page, '修改密码').click()
    const dialog2 = page.getByRole('dialog')
    await dialog2.getByLabel('当前密码').fill(NEW_PASSWORD)
    await dialog2.getByLabel('新密码', { exact: true }).fill(OLD_PASSWORD)
    await dialog2.getByLabel('确认新密码').fill(OLD_PASSWORD)
    await antdButton(dialog2, '确认修改').click()
    await expect(page).toHaveURL(/\/login/)
  })
})

