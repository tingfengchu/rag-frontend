import fs from 'node:fs'

import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME } from './global-setup'
import { antdButton, loginForm, registerTempUser } from './helpers'

/**
 * 文件管理 + 下载 + 在线预览（模块：文件管理 / 2026-10-13 验收修正）。
 *
 * 八条用例覆盖交付验收清单：
 *   1. 管理员登录 → 「📁 文件管理」面板看到公共库里那 3 个文件（含版本/时间/上传人）→
 *      下载成功，「**预览**」打开的是新标签页里的 inline 原件（不是下载）；
 *   2. 普通用户 → 只看到公共库的文件（私人库列表里**没有**别人的 private）→ 下载成功；
 *   3. 别人的私人库文件 → 列表里看不到，直接按 uuid 下载 → 403「无下载权限，请联系管理员」
 *      （这条用的是"用产品自己的删除接口收尾"，跑完不留脏数据）；
 *   4. 引用标签可点击 → 弹窗里有文件名/页码/置信度/摘录 → 「下载原文」拿到公共库原件，
 *      「**查看原文**」打开的是带 `#page=N` 的预览 URL（直接翻到引用那一页）；
 *   5. 同一份文件（MD5 相同）重复上传 → 被**去重**：不新建版本，历史版本里也还是那一条。
 *   6. **管理员删除**（2026-10-13 验收新增）：上传临时文件 → 点「删除」→ 弹二次确认 →
 *      「取消」什么都不会发生 → 确认后行消失，且再删一次是 404（记录 / ES 块 / 向量 /
 *      留存原件一起清了）；
 *   7. **普通用户删公共库文件 → 403**：界面上**没有**删除入口（`can_delete=false`），
 *      绕过界面直接调接口也是 403，文件原封不动；
 *   8. 普通用户删**自己私人库**的文件：入口存在且删得掉（权限按库算，不是一刀切）。
 *
 * 真前端 + 真后端 + 真文件（那 3 个 PDF 就在后端项目根目录，兜底目录默认指那里）。
 * 需要后端 `allow_register = true`（用例自己建临时账号）与可用的临时管理员
 * （`e2e/global-setup.ts` 会建 `e2e_admin_file`；建不出来时用例 skip 并说明原因，
 * 因为"环境没准备好"不该表现成"功能坏了"）。
 */

/** 交付环境公共库里的 3 个文档（面板必须把它们列全）。 */
const PUBLIC_FILES = [
  '自动驾驶算法与嵌入式具身智能运控.pdf',
  '1790569531500.pdf',
  'SAGE AI 智能问答助手.pdf',
]

const PANEL = '[data-testid="file-manager-panel"]'

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

/** 面板里的那一行（按文件名匹配：行的可访问名 = 各单元格文本拼接）。 */
function fileRow(page: Page, name: string) {
  return page.getByRole('row', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
}

/** 点某一行的「下载」并返回下载对象。 */
async function downloadRow(page: Page, row: ReturnType<typeof fileRow>) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByTestId('file-download').click(),
  ])
  return download
}

/** 下载到的字节数（`download.path()` 给的是临时文件路径）。 */
function downloadedSize(path: string | null): number {
  expect(path, '下载没落到临时文件上').toBeTruthy()
  return fs.statSync(path as string).size
}

/**
 * 在页面里给 `window.open` 装一个**只记录不拦截**的探针，返回"读记录"的函数。
 *
 * 为什么非它不可：预览是把 `blob:` URL 交给浏览器内置的 PDF 查看器（只有这样 `#page=N`
 * 才能跳页），而查看器**可能改写地址栏** —— 直接断言 `popup.url()` 会时红时绿。
 * 探针钉的是"应用请求打开的那个 URL"，那才是我们真正实现的契约（`blob:` + `#page=N`）。
 */
async function spyOnWindowOpen(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __openedUrls: string[] }
    w.__openedUrls = []
    const original = window.open.bind(window)
    const spy = (url?: string | URL, ...rest: unknown[]) => {
      w.__openedUrls.push(String(url))
      return original(url as string, ...(rest as []))
    }
    window.open = spy as unknown as typeof window.open
  })
  return () =>
    page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls)
}

/**
 * 上传并返回**完整响应体**：去重用例要看 `duplicate` / `version`，不只是 `file_uuid`。
 */
async function uploadNoteFull(
  ctx: APIRequestContext,
  scope: string,
  name: string,
  body: string,
): Promise<{
  ok: boolean
  message: string
  file_uuid: string | null
  duplicate: boolean
  version: number | null
}> {
  const response = await ctx.post('/api/files/upload', {
    multipart: {
      scope,
      file: { name, mimeType: 'text/markdown', buffer: Buffer.from(body, 'utf8') },
    },
    timeout: 180_000,
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()) as {
    ok: boolean
    message: string
    file_uuid: string | null
    duplicate: boolean
    version: number | null
  }
}

/** 从来源库上传一个很小的 Markdown（走 Docling 的文本路径，比 PDF 快得多）。 */
async function uploadPrivateNote(ctx: APIRequestContext, userUUID: string): Promise<string> {
  const response = await ctx.post('/api/files/upload', {
    multipart: {
      scope: `private:${userUUID}`,
      file: {
        name: 'e2e_private_note.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(
          '# E2E 私人文档\n\n这是 E2E 用例上传的私人库文档，用来验证"别人的私人库文件不可下载"。\n',
          'utf8',
        ),
      },
    },
    timeout: 180_000,
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = (await response.json()) as { file_uuid?: string }
  expect(body.file_uuid, '上传没有返回 file_uuid').toBeTruthy()
  return body.file_uuid as string
}

/**
 * 上传一个很小的 Markdown 并返回 `{file_uuid, version}`（模块 5 的版本用例要用版本号）。
 *
 * 与 ``uploadPrivateNote`` 同一套路：走真实入库链路（不只是造一条记录），
 * 文件名可指定——同名两次上传正是要验的场景。
 */
async function uploadNote(
  ctx: APIRequestContext,
  scope: string,
  name: string,
  body: string,
): Promise<{ file_uuid: string; version: number }> {
  const response = await ctx.post('/api/files/upload', {
    multipart: {
      scope,
      file: { name, mimeType: 'text/markdown', buffer: Buffer.from(body, 'utf8') },
    },
    timeout: 180_000,
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const json = (await response.json()) as { file_uuid?: string; version?: number | null }
  expect(json.file_uuid, '上传没有返回 file_uuid').toBeTruthy()
  return { file_uuid: json.file_uuid as string, version: json.version ?? 0 }
}

interface LibraryRow {
  file_uuid: string
  file_name: string
  version: number
  archived: boolean
}

test.describe('文件管理 + 下载', () => {
  test('管理员：面板列出 3 个文件，下载拿回原件', async ({ page }) => {
    test.setTimeout(180_000)

    const loggedIn = await login(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD)
    test.skip(
      !loggedIn,
      '需要可用的临时管理员（e2e/global-setup.ts 负责创建 e2e_admin_file；登录失败说明环境未就绪）',
    )

    const panel = page.locator(PANEL)
    await expect(panel).toBeVisible({ timeout: 30_000 })

    // 表头必须齐全：少一列就是"版本/上传人这些信息其实没给出来"
    for (const header of ['文件名', '库', '版本', '更新时间', '上传人']) {
      await expect(panel.getByRole('columnheader', { name: header })).toBeVisible()
    }

    // 公共库里的 3 个文档都要在（改造前入库的也要能列出来 + 能下载）
    for (const name of PUBLIC_FILES) {
      await expect(fileRow(page, name)).toBeVisible({ timeout: 30_000 })
    }

    const sageRow = fileRow(page, 'SAGE AI 智能问答助手.pdf')
    await expect(sageRow).toContainText('公共库')
    await expect(sageRow).toContainText('v1')
    // 上传人/时间必须有值：这两列空着等于面板没完成它的活
    await expect(sageRow).not.toContainText('—')

    const download = await downloadRow(page, sageRow)
    expect(download.suggestedFilename()).toBe('SAGE AI 智能问答助手.pdf')
    expect(downloadedSize(await download.path())).toBeGreaterThan(1_000)

    // 在线预览（2026-10-13 验收）：新标签页里打开原件，**不落盘**
    const openedUrls = await spyOnWindowOpen(page)
    const newTab = page.context().waitForEvent('page')
    const previewRequest = page.waitForRequest((req) => req.url().includes('/preview'))
    await sageRow.getByTestId('file-preview').click()
    const [previewResponse] = await Promise.all([
      previewRequest.then((req) => req.response()),
      newTab,
    ])

    const opened = await openedUrls()
    expect(opened, '预览必须交给浏览器查看器（blob:），而不是走下载').toHaveLength(1)
    expect(opened[0]).toMatch(/^blob:/)
    // 面板的预览不带页码：``#page=N`` 只由引用弹窗（知道页码的那一处）带过来
    expect(opened[0]).not.toContain('#page=')
    expect(previewResponse?.status(), '预览接口应当 200').toBe(200)
    // inline 是这个端点存在的理由：写成 attachment 浏览器就直接下载了，预览按钮等于失效
    expect(previewResponse?.headers()['content-disposition']).toContain('inline')
    const previewBytes = await previewResponse?.body()
    expect(previewBytes?.subarray(0, 4).toString('latin1'), '预览回的必须是 PDF 原件').toBe(
      '%PDF',
    )
  })

  test('普通用户：只看到公共库的文件，下载同样可用', async ({ page, request }) => {
    test.setTimeout(180_000)

    const password = 'E2eFiles_123!'
    const username = await registerTempUser(request, 'e2e_files', password)
    test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

    const loggedIn = await login(page, username as string, password)
    expect(loggedIn, '临时账号登录失败').toBeTruthy()

    const panel = page.locator(PANEL)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    for (const name of PUBLIC_FILES) {
      await expect(fileRow(page, name)).toBeVisible({ timeout: 30_000 })
    }

    // 新用户的私人库是空的，而"别人的私人库"压根不会被查 → 一行「我的文档」都不该有
    await expect(panel.getByText('我的文档')).toHaveCount(0)

    const download = await downloadRow(page, fileRow(page, '1790569531500.pdf'))
    expect(download.suggestedFilename()).toBe('1790569531500.pdf')
    expect(downloadedSize(await download.path())).toBeGreaterThan(1_000)
  })

  test('别人的私人库文件：列表里没有，直接下载 403', async ({ page, request, playwright }) => {
    test.setTimeout(300_000)

    const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
    const passwordB = 'E2ePrivate_123!'
    const usernameB = await registerTempUser(request, 'e2e_private_b', passwordB)
    test.skip(!usernameB, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

    // 用**独立的 API 上下文**登录 B：与浏览器里那个会话互不干扰（否则 A 会被顶掉）
    const bContext = await playwright.request.newContext({ baseURL })
    try {
      expect(
        (await bContext.post('/api/auth/login', {
          data: { username: usernameB, password: passwordB },
        })).ok(),
      ).toBeTruthy()
      const userB = (await (await bContext.get('/api/auth/me')).json()) as { user_uuid: string }
      // 真上传一个小文件到 B 的私人库：不是"造一条假记录"，而是走完整入库链路
      const privateUUID = await uploadPrivateNote(bContext, userB.user_uuid)

      // B 自己看得见（说明文件确实入库了，后面的 403 不是"因为文件不存在"）
      const bLibrary = (await (await bContext.get('/api/files/library')).json()) as Array<{
        file_uuid: string
        scope_label: string
      }>
      expect(bLibrary.some((f) => f.file_uuid === privateUUID && f.scope_label === '我的文档')).toBe(
        true,
      )

      // A 登录后：面板里没有别人的私人库文件
      const passwordA = 'E2ePrivate_123!'
      const usernameA = await registerTempUser(request, 'e2e_private_a', passwordA)
      expect(await login(page, usernameA as string, passwordA)).toBeTruthy()
      const panel = page.locator(PANEL)
      await expect(panel).toBeVisible({ timeout: 30_000 })
      await expect(panel.getByText('我的文档')).toHaveCount(0)

      // 直接按 uuid 下载 → 403（权限判定在**查磁盘之前**，所以即使原件存在也拿不到）
      const denied = await page.request.get(`/api/files/${privateUUID}/download`)
      expect(denied.status()).toBe(403)
      expect((await denied.json()).detail).toBe('无下载权限，请联系管理员')

      // 收尾：用产品自己的删除接口清掉（ES 块 / 向量 / 记录 / 留存原件一起删）
      const cleaned = await bContext.delete(`/api/files/${privateUUID}`, {
        params: { scope: `private:${userB.user_uuid}` },
      })
      expect(cleaned.ok(), await cleaned.text()).toBeTruthy()
    } finally {
      await bContext.dispose()
    }
  })

  test('引用标签可点击：弹窗里有摘录与置信度，能下载原文', async ({ page, request }) => {
    test.setTimeout(300_000)

    const password = 'E2eTrace_123!'
    const username = await registerTempUser(request, 'e2e_trace', password)
    test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

    expect(await login(page, username as string, password)).toBeTruthy()

    // 问题里带一个随机编号：**目的是绕开语义缓存**。
    // 命中老缓存时引用里没有 file_uuid / excerpt（那一版还没存），弹窗会如实显示
    // "无法定位原件"并把下载禁用——那是**正确**行为，但它验证不到本次新增的溯源链路。
    const nonce = Date.now().toString(36)
    await page.getByPlaceholder(/输入你的问题/).fill(`张嘉亮是谁？（E2E 校验 ${nonce}）`)
    await antdButton(page, '发送').click()

    // 引用标签必须真的出现（拒答/报错时不渲染，那样下面全是空断言）
    const tag = page.getByTestId('citation-tag').first()
    await expect(tag).toBeVisible({ timeout: 180_000 })
    const citedName = ((await tag.textContent()) ?? '').split(' · ')[0].trim()
    expect(PUBLIC_FILES, `引用指向的文件不在公共库里：${citedName}`).toContain(citedName)

    await tag.click()
    const modal = page.getByTestId('source-trace-modal')
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('文件名')
    await expect(modal).toContainText(/第 \d+ 页/)
    await expect(modal.getByTestId('trace-confidence')).toContainText('置信度')
    // 摘录必须有内容：老缓存那种"没有摘录"会走另一条提示分支（这个 testid 不会出现）
    await expect(modal.getByTestId('trace-excerpt')).not.toBeEmpty()

    const downloadButton = page.getByTestId('trace-download')
    await expect(downloadButton).toBeEnabled()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ])
    expect(download.suggestedFilename()).toBe(citedName)
    expect(downloadedSize(await download.path())).toBeGreaterThan(1_000)

    // 「查看原文」（2026-10-13 验收）：新标签页打开，且 URL 上带着**引用所在的页码**
    const citedPage = Number(/第 (\d+) 页/.exec((await modal.textContent()) ?? '')?.[1])
    expect(citedPage, '弹窗里必须给得出页码，否则无从跳到那一页').toBeGreaterThan(0)

    const openedUrls = await spyOnWindowOpen(page)
    const newTab = page.context().waitForEvent('page')
    const previewRequest = page.waitForRequest((req) => req.url().includes('/preview'))
    await page.getByTestId('trace-preview').click()
    const [previewResponse] = await Promise.all([
      previewRequest.then((req) => req.response()),
      newTab,
    ])

    const opened = await openedUrls()
    expect(opened, '查看原文必须在新标签页里打开原件').toHaveLength(1)
    expect(opened[0]).toMatch(/^blob:/)
    expect(opened[0], 'PDF 要直接翻到引用那一页').toMatch(new RegExp(`#page=${citedPage}$`))
    expect(previewResponse?.headers()['content-disposition'], 'inline 才能就地预览').toContain(
      'inline',
    )
  })

  test('同名两次上传：默认只列 v2，开关打开后 v1 带「历史版本」且仍可下载/可删', async ({
    page,
    request,
    playwright,
  }) => {
    test.setTimeout(300_000)

    const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
    const password = 'E2eVersions_123!'
    const username = await registerTempUser(request, 'e2e_versions', password)
    test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

    const ctx = await playwright.request.newContext({ baseURL })
    const NAME = 'e2e_same_name.md'
    let scope = ''
    const uploaded: string[] = []
    try {
      expect(
        (await ctx.post('/api/auth/login', { data: { username, password } })).ok(),
      ).toBeTruthy()
      const me = (await (await ctx.get('/api/auth/me')).json()) as { user_uuid: string }
      scope = `private:${me.user_uuid}`

      // ① 同名两次上传：版本号必须递进（改造前这里会被 MD5 查重拦成"无需重复上传"）
      const first = await uploadNote(ctx, scope, NAME, '# 第一版\n\n这是第一版的内容。\n')
      expect(first.version, '第一次上传应当是 v1').toBe(1)
      uploaded.push(first.file_uuid)

      const second = await uploadNote(ctx, scope, NAME, '# 第二版\n\n这是第二版的内容。\n')
      expect(second.version, '同名第二次上传应当是 v2').toBe(2)
      uploaded.push(second.file_uuid)

      // ② 后端事实：默认只回 v2；要历史版本得显式要
      const latest = (await (await ctx.get('/api/files/library')).json()) as LibraryRow[]
      const mineLatest = latest.filter((row) => row.file_name === NAME)
      expect(mineLatest.map((row) => row.version)).toEqual([2])
      expect(mineLatest[0].archived).toBe(false)

      const all = (await (
        await ctx.get('/api/files/library', { params: { include_archived: true } })
      ).json()) as LibraryRow[]
      const mineAll = all.filter((row) => row.file_name === NAME)
      expect(mineAll.map((row) => row.version), '新版在前、旧版在后').toEqual([2, 1])
      expect(mineAll.map((row) => row.archived)).toEqual([false, true])

      // ③ 界面上：默认一行；打开「显示历史版本」后两行，旧版带标签
      expect(await login(page, username as string, password)).toBeTruthy()
      const panel = page.locator(PANEL)
      await expect(panel).toBeVisible({ timeout: 30_000 })
      await expect(fileRow(page, NAME)).toHaveCount(1)
      await expect(fileRow(page, NAME)).toContainText('v2')

      await panel.getByTestId('files-show-archived').click()
      await expect(fileRow(page, NAME)).toHaveCount(2)

      const archivedRow = fileRow(page, NAME).filter({ hasText: '历史版本' })
      await expect(archivedRow, '历史版本必须带标记，否则两行长得一模一样').toHaveCount(1)
      await expect(archivedRow).toContainText('v1')

      // ④ 归档只是标记、不是删数据：历史版本照样下得下来
      const download = await downloadRow(page, archivedRow)
      expect(download.suggestedFilename()).toBe(NAME)
      expect(downloadedSize(await download.path())).toBeGreaterThan(0)
    } finally {
      // 收尾：两个版本都删掉。顺带证明**历史版本删得掉**（删除路径要带
      // include_archived，否则归档的那条会回 404、变成删不掉的幽灵数据）
      for (const fileUUID of uploaded) {
        const cleaned = await ctx.delete(`/api/files/${fileUUID}`, { params: { scope } })
        expect(cleaned.ok(), await cleaned.text()).toBeTruthy()
      }
      await ctx.dispose()
    }
  })

  test('同一份文件重复上传：被去重，不新建版本、历史版本里也只有一条', async ({
    page,
    request,
    playwright,
  }) => {
    test.setTimeout(300_000)

    const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
    const password = 'E2eDedup_123!'
    const username = await registerTempUser(request, 'e2e_dedup', password)
    test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

    const ctx = await playwright.request.newContext({ baseURL })
    const NAME = 'e2e_same_bytes.md'
    const BODY = '# 同一份文件\n\n这段内容会被上传两次，第二次必须被去重。\n'
    let scope = ''
    const uploaded: string[] = []
    try {
      expect(
        (await ctx.post('/api/auth/login', { data: { username, password } })).ok(),
      ).toBeTruthy()
      const me = (await (await ctx.get('/api/auth/me')).json()) as { user_uuid: string }
      scope = `private:${me.user_uuid}`

      // ① 第一次：正常入库 → v1
      const first = await uploadNoteFull(ctx, scope, NAME, BODY)
      expect(first.version, '第一次上传应当是 v1').toBe(1)
      expect(first.duplicate).toBe(false)
      uploaded.push(first.file_uuid as string)

      // ② 第二次：**同一份文件**（MD5 相同）→ 去重
      //    改造后的判据落在内容上：同名 + 同内容只是"又传了一遍"，记成 v2 会让面板上
      //    并排出现两条一模一样的记录（v1 还会被打上「历史版本」）。
      const again = await uploadNoteFull(ctx, scope, NAME, BODY)
      expect(again.duplicate, '同 MD5 重复上传必须被去重').toBe(true)
      expect(again.message).toContain('已入库')
      expect(again.file_uuid, '去重不该产生新记录').toBeNull()
      expect(again.version, '去重不该给出新版本号').toBeNull()

      // ③ 后端事实：连历史版本一起看，同名文件**只有一条**
      const all = (await (
        await ctx.get('/api/files/library', { params: { include_archived: true } })
      ).json()) as LibraryRow[]
      const mine = all.filter((row) => row.file_name === NAME)
      expect(mine.map((row) => row.version)).toEqual([1])
      expect(mine.map((row) => row.archived)).toEqual([false])

      // ④ 界面上：默认一行；打开「显示历史版本」后**仍然**只有一行（没有历史版本）
      expect(await login(page, username as string, password)).toBeTruthy()
      const panel = page.locator(PANEL)
      await expect(panel).toBeVisible({ timeout: 30_000 })
      await expect(fileRow(page, NAME)).toHaveCount(1)
      await expect(fileRow(page, NAME)).toContainText('v1')

      // 等这一次刷新**真的**回来再数行数：否则"1 行"可能是点击前的旧数据（去了也是 1）
      const reloaded = page.waitForResponse(
        (res) =>
          res.url().includes('/api/files/library') &&
          res.url().includes('include_archived=true'),
      )
      await panel.getByTestId('files-show-archived').click()
      expect((await reloaded).status()).toBe(200)
      await expect(fileRow(page, NAME)).toHaveCount(1)
      // exact: true —— 开关旁边那句「显示历史版本」也含这三个字，模糊匹配会误伤
      await expect(panel.getByText('历史版本', { exact: true })).toHaveCount(0)
    } finally {
      for (const fileUUID of uploaded) {
        const cleaned = await ctx.delete(`/api/files/${fileUUID}`, { params: { scope } })
        expect(cleaned.ok(), await cleaned.text()).toBeTruthy()
      }
      await ctx.dispose()
    }
  })

  test('管理员：删除临时文件 → 二次确认 → 行消失且记录被真的清掉', async ({ page }) => {
    test.setTimeout(300_000)

    const loggedIn = await login(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD)
    test.skip(
      !loggedIn,
      '需要可用的临时管理员（e2e/global-setup.ts 负责创建 e2e_admin_file；登录失败说明环境未就绪）',
    )

    const panel = page.locator(PANEL)
    await expect(panel).toBeVisible({ timeout: 30_000 })

    // 上传走**浏览器自己的会话**（page.request 与页面共享 Cookie）：
    // 再登一次管理员会顶掉页面里那个会话，后面就没法在界面上点删除了
    const NAME = `e2e_delete_${Date.now().toString(36)}.md`
    let fileUUID = ''
    try {
      const uploaded = (await (
        await page.request.post('/api/files/upload', {
          multipart: {
            scope: 'public',
            file: {
              name: NAME,
              mimeType: 'text/markdown',
              buffer: Buffer.from('# 待删除\n\n这个文件是 E2E「删除」用例上传的。\n', 'utf8'),
            },
          },
          timeout: 180_000,
        })
      ).json()) as { file_uuid: string }
      expect(uploaded.file_uuid, '上传没有返回 file_uuid').toBeTruthy()
      fileUUID = uploaded.file_uuid

      // 上传是走接口做的，界面不会自己知道 → 点「刷新」并等这一次响应回来再断言
      const reloaded = page.waitForResponse(
        (res) => res.url().includes('/api/files/library') && res.status() === 200,
      )
      await antdButton(panel, '刷新').click()
      await reloaded

      const row = fileRow(page, NAME)
      await expect(row).toBeVisible({ timeout: 30_000 })
      // 管理员对公共库的行必须有「删除」入口（can_delete 由后端按会话算好）
      const deleteButton = row.getByTestId('file-delete')
      await expect(deleteButton).toBeVisible()

      // ① 点删除 → **二次确认**：弹窗里必须带文件名与后果，用户才能核对自己点的是哪一行。
      //    用 :visible 限定：antd 的 confirm 关闭后仍可能留在 DOM 里，不限定会撞 strict mode。
      const dialog = page.locator('.ant-modal-confirm:visible')
      await deleteButton.click()
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText(NAME)
      await expect(dialog).toContainText('不可撤销')

      // ② 先取消：什么都不能发生（防的是"弹窗只是装饰、点了就删"）
      await antdButton(dialog, '取消').click()
      await expect(dialog).toBeHidden()
      await expect(row).toBeVisible()

      // ③ 再点一次并确认 → 成功提示 + 那一行消失（列表是重新拉的，不是本地 filter）
      await deleteButton.click()
      await expect(dialog).toBeVisible()
      await antdButton(dialog, '删除').click()
      await expect(page.getByText('已删除', { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(row).toHaveCount(0)

      // ④ 后端事实：记录真的没了（再删一次是 404），原件也访问不到了
      const again = await page.request.delete(`/api/files/${fileUUID}`, {
        params: { scope: 'public' },
      })
      expect(again.status(), '第二次删除应当 404：记录确实被清了').toBe(404)
      const preview = await page.request.get(`/api/files/${fileUUID}/preview`)
      expect(preview.status(), '原件与记录一起清掉后，预览也应当是 404').toBe(404)
    } finally {
      // 兜底收尾（正常路径上早已删掉，这里只是 404）：中途失败时不留垃圾文件在公共库
      if (fileUUID) {
        await page.request.delete(`/api/files/${fileUUID}`, { params: { scope: 'public' } })
      }
    }
  })

  test('普通用户：公共库的行没有「删除」入口，直接调接口 403', async ({ page, request }) => {
    test.setTimeout(180_000)

    const password = 'E2eDelete_123!'
    // registerTempUser 在 allow_register 关闭时**抛错**（不再返回 null），所以这里不写 test.skip
    const username = await registerTempUser(request, 'e2e_delete_denied', password)

    expect(await login(page, username, password), '临时账号登录失败').toBeTruthy()

    const panel = page.locator(PANEL)
    await expect(panel).toBeVisible({ timeout: 30_000 })

    const sageRow = fileRow(page, 'SAGE AI 智能问答助手.pdf')
    await expect(sageRow).toBeVisible({ timeout: 30_000 })
    // 没权限 → 界面上**没有**这个入口（验收第 4 条：按钮只在有权限时显示）。
    // 反过来做（按钮都在、点了才 403）会让用户以为功能坏了。
    await expect(sageRow.getByTestId('file-delete')).toHaveCount(0)

    // 从列表接口取真实 uuid（不猜），并断言后端根本没把删除权标成 true
    const library = (await (await page.request.get('/api/files/library')).json()) as Array<{
      file_uuid: string
      file_name: string
      can_delete: boolean
    }>
    const target = library.find((row) => row.file_name === 'SAGE AI 智能问答助手.pdf')
    expect(target, '公共库里应当有这份文档').toBeTruthy()
    // 新账号的私人库是空的 → 所有行都是公共库的 → 一条都不该给删除权
    expect(library.every((row) => row.can_delete === false)).toBe(true)

    // 绕过界面直接调接口 → 403（不是 404/500），文案点明需要管理员
    const denied = await page.request.delete(`/api/files/${target?.file_uuid}`, {
      params: { scope: 'public' },
    })
    expect(denied.status()).toBe(403)
    expect((await denied.json()).detail).toContain('管理员')

    // 403 之后文件必须原封不动：列表里还在
    const after = (await (await page.request.get('/api/files/library')).json()) as Array<{
      file_uuid: string
    }>
    expect(after.some((row) => row.file_uuid === target?.file_uuid)).toBe(true)
  })

  test('普通用户：自己私人库的文件能删（入口出现 → 确认 → 行消失）', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000)

    const password = 'E2eDelete_123!'
    const username = await registerTempUser(request, 'e2e_delete_own', password)

    expect(await login(page, username, password)).toBeTruthy()
    const panel = page.locator(PANEL)
    await expect(panel).toBeVisible({ timeout: 30_000 })

    // 上传到**自己的**私人库：scope 用会话里的 uuid（服务端还会再核一遍）
    const me = (await (await page.request.get('/api/auth/me')).json()) as { user_uuid: string }
    const NAME = `e2e_delete_private_${Date.now().toString(36)}.md`
    const uploaded = (await (
      await page.request.post('/api/files/upload', {
        multipart: {
          scope: `private:${me.user_uuid}`,
          file: {
            name: NAME,
            mimeType: 'text/markdown',
            buffer: Buffer.from('# 我的私有文件\n\n验证"私人库的文件本人能删"。\n', 'utf8'),
          },
        },
        timeout: 180_000,
      })
    ).json()) as { file_uuid: string }
    expect(uploaded.file_uuid).toBeTruthy()

    const reloaded = page.waitForResponse(
      (res) => res.url().includes('/api/files/library') && res.status() === 200,
    )
    await antdButton(panel, '刷新').click()
    await reloaded

    const row = fileRow(page, NAME)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('我的文档')

    // 私人库的本人有删除权（can_delete=true）→ 界面上必须有入口
    const deleteButton = row.getByTestId('file-delete')
    await expect(deleteButton).toBeVisible()

    const dialog = page.locator('.ant-modal-confirm:visible')
    await deleteButton.click()
    await expect(dialog).toBeVisible()
    await antdButton(dialog, '删除').click()

    await expect(page.getByText('已删除', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(row).toHaveCount(0)

    // 后端事实：私人库里也没有了（列表接口按会话拼 private:<自己>）
    const library = (await (await page.request.get('/api/files/library')).json()) as Array<{
      file_uuid: string
    }>
    expect(library.some((item) => item.file_uuid === uploaded.file_uuid)).toBe(false)
  })
})
