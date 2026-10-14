import { expect, test } from '@playwright/test'

import { antdButton, loginForm, registerTempUser } from './helpers'

/**
 * 追问的指代消解（P0，用户实测复现）。
 *
 * 现象：先问「张嘉亮是谁？」，再追问「**他的实习经历呢？**」——
 * 界面上显示「已重写为：他的实习经历」：LLM 只把"呢？"抹掉了，"他"原封不动。
 * 于是检索真的去查"他"，什么都命中不了（置信度 0.12 → 拒答）。
 *
 * 修复后的契约：**改写结果里不许留下指代**——
 * 规则闸门先放行（含代词），LLM 尽力消解，若它没做到就用历史里的实体做确定性替换
 * （候选实体由 jieba 词性标注从历史中抽：人名 nr / 专名 nz / 英文词 eng）。
 * 因此这条用例即使碰上模型偷懒（只删语气词）也必须通过——这正是"保证"而非"期望"。
 *
 * 真前端 + 真后端 + 真 LLM（两轮问答，20~60 秒），超时给宽。
 * 需要 `allow_register=true`（用例自己建临时账号）。
 */

/** 历史里的实体：消解后必须出现在重写结果里 */
const ENTITY = '张嘉亮'

test.describe('追问指代消解（P0）', () => {
  test('「他的实习经历呢？」被重写成含"张嘉亮"的问题', async ({ page, request }) => {
    test.setTimeout(240_000)

    const password = 'E2eRewrite_123!'
    const username = await registerTempUser(request, 'e2e_rewrite', password)
    test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

    await page.goto('/login')
    await loginForm(page).getByLabel('用户名').fill(username as string)
    await loginForm(page).getByLabel('密码', { exact: true }).fill(password)
    await antdButton(page, '登录').click()
    await expect(page).toHaveURL(/\/chat/)

    // 第一轮：把"张嘉亮"写进（服务端）历史——改写器只有拿到历史才允许消解
    await page.getByPlaceholder(/输入你的问题/).fill(`${ENTITY}是谁？`)
    await antdButton(page, '发送').click()

    // 等这一轮流**结束**：打字机还在跑时发送键会换成"停止"，等它变回"发送"。
    // （这比"等某个文案出现"可靠：回答长短、是否拒答都不影响这个信号。）
    await expect(antdButton(page, '发送')).toBeVisible({ timeout: 120_000 })

    // 第二轮：追问（含代词"他"+ 句尾"呢"）
    await page.getByPlaceholder(/输入你的问题/).fill('他的实习经历呢？')
    await antdButton(page, '发送').click()

    // 改写提示必须出现，且**必须把指代换成历史里的实体**
    const rewritten = page.getByText(/已重写为：/).first()
    await expect(rewritten).toBeVisible({ timeout: 120_000 })
    await expect(rewritten).toContainText(ENTITY)

    // 反向锁定：改写结果里不许还留着"他的"（用户看到的就是这个）
    await expect(rewritten).not.toContainText('他的')
  })
})
