import type { Locator, Page } from '@playwright/test'

/**
 * 按文案找按钮（E2E 共用）。
 *
 * ⚠️ 为什么不能直接 `getByRole('button', { name: '登录' })`：
 * **antd 会在"恰好两个汉字"的按钮文案中间自动插一个空格**——
 * 界面上是 `登 录`、`注 册`、`发 送`（这是 antd 的排版优化），
 * 精确匹配 '登录' 就会 30s 超时，看起来像"页面没加载"，
 * 实际是定位器写错了。这里把文案拆成字符、允许字符之间出现空白，两种情况都能命中。
 */
export function antdButton(scope: Page | Locator, label: string): Locator {
  return scope.getByRole('button', { name: new RegExp(label.split('').join('\\s*')) })
}

/**
 * 登录表单本身（**不含弹窗**）。
 *
 * ⚠️ 为什么必须限定范围：antd 的 Modal 关闭后**仍留在 DOM 里**（只是隐藏），
 * 于是 `page.getByLabel('用户名')` 会同时匹配"登录表单里的用户名"和"注册弹窗里的用户名"，
 * 直接报 `strict mode violation`。登录表单的 id 来自 `<Form name="login">` → `#login`。
 */
export function loginForm(page: Page): Locator {
  return page.locator('#login')
}

/**
 * 注册一个临时账号（登录页 E2E 的前置）。
 *
 * 需要后端 `allow_register=true`：**没开就抛错**，不再返回 null。
 *
 * 为什么改成抛错（2026-10-12 实测）：以前返回 null 由调用方 `test.skip` 收场，
 * 于是后端用默认配置（`allow_register=false`）跑出来的结果是
 * **`3 passed / 14 skipped` 且退出码 0**——"没开开关"被静默翻译成了"全绿"，
 * 而这 14 条里包含模块 5b / 6 的全部新用例，等于新功能一行都没验过。
 * 现在开关没开就直接失败；`globalSetup`（`e2e/global-setup.ts`）里还有一道
 * 同样的硬断言，让整轮在准备阶段就停下，连用例都不进。
 */
export async function registerTempUser(
  request: import('@playwright/test').APIRequestContext,
  prefix: string,
  password: string,
): Promise<string> {
  const config = await (await request.get('/api/auth/config')).json()
  if (!config.allow_register) {
    throw new Error(
      'registerTempUser 失败：后端 allow_register 未开启（请用 ALLOW_REGISTER=true 启动后端，' +
        '或 rag_config.txt 里写 allow_register = true）',
    )
  }

  const username = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const resp = await request.post('/api/auth/register', {
    data: { username, password },
  })
  if (resp.status() !== 201) {
    throw new Error(`注册临时账号失败：HTTP ${resp.status()} ${await resp.text()}`)
  }
  return username
}
