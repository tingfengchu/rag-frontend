import { expect, test } from '@playwright/test'

import { antdButton, loginForm, registerTempUser } from './helpers'

/**
 * 引用噪声与置信度 1.00（P0，用户实测复现）。
 *
 * 现象：问"张嘉亮是谁？"，引用列表里出现 自动驾驶算法.pdf 与
 * SAGE AI 智能问答助手.pdf 的第 18/4/12 页——它们在真实知识库上的精排分只有
 * **0.00004**（RRF 捞上来的陪跑），却因为当时没有任何"单条引用"级别的分数过滤
 * 而被列成了"引用来源"；同时"最高置信度"显示 **1.00**（真实分数 0.9993292 被
 * `toFixed(2)` 舍入成 1.00，而 1.00 在本系统里另有含义）。
 *
 * 这条用例钉住三件事：
 *   1. 引用列表里有**至少一条**真引用（否则"没有噪声"就是空断言）；
 *   2. 无关文件不在引用里，且每条引用的分数都 ≥ 阈值（分数挂在 Tag 的 title 上）；
 *   3. "最高置信度"不再是 1.00，也没有任何引用标着哨兵（"本次未做分数门控"）。
 *
 * 真前端 + 真后端 + 真检索 + 真 LLM（10~30 秒），超时给宽。
 * 需要 `allow_register=true`（用例自己建临时账号）。
 */

/** 用户报告的那条无关文件（substring 匹配：真实文件名更长） */
const NOISE_FILE = '自动驾驶'

/** 后端 `api/routers/chat.py:CITATION_THRESHOLD`（前端 client.ts 同名常量） */
const CITATION_THRESHOLD = 0.5

/** 哨兵标签：rerank 打开时**不该**出现（它只在"这次没做分数门控"时出现） */
const NO_GATING_LABEL = '本次未做分数门控'

test.describe('引用噪声与置信度（P0）', () => {
  test('无关文件不进引用来源，置信度也不再是 1.00', async ({ page, request }) => {
    test.setTimeout(180_000)

    const password = 'E2eCite_123!'
    const username = await registerTempUser(request, 'e2e_cite', password)
    test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

    await page.goto('/login')
    await loginForm(page).getByLabel('用户名').fill(username as string)
    await loginForm(page).getByLabel('密码', { exact: true }).fill(password)
    await antdButton(page, '登录').click()
    await expect(page).toHaveURL(/\/chat/)

    await page.getByPlaceholder(/输入你的问题/).fill('张嘉亮是谁？')
    await antdButton(page, '发送').click()

    // 引用区域**必须真的出现**：拒答/报错时它不渲染，那样"没有噪声"就成了空断言
    await expect(page.getByText('引用来源：')).toBeVisible({ timeout: 120_000 })

    // antd Tag 渲染成 <span class="ant-tag" title="置信度 0.98">；title 是我们的标签
    const citations = await page.locator('.ant-tag[title]').evaluateAll((els) =>
      els.map((el) => ({
        title: el.getAttribute('title') ?? '',
        text: (el.textContent ?? '').trim(),
      })),
    )

    // 1) 至少一条真引用：空列表不算"通过了引用噪声的验收"
    expect(citations.length, '一条引用都没有，这条用例等于没验').toBeGreaterThan(0)

    // 2) 无关文件不在引用里（用户报的那条）
    expect(citations.map((c) => c.text).join(' | ')).not.toContain(NOISE_FILE)

    // 3) 每条引用的分数都过阈值；rerank 打开时不该出现哨兵标签
    for (const citation of citations) {
      expect(citation.title).not.toContain(NO_GATING_LABEL)

      const score = citation.title.match(/置信度\s*([0-9.]+)/)
      if (score) {
        expect(Number(score[1])).toBeGreaterThanOrEqual(CITATION_THRESHOLD)
      }
    }

    // 4) 最高置信度不再是 1.00（0.999 会被 toFixed(2) 舍入成 1.00 → 展示层退一格成 0.99）
    const confidence = page.getByText(/最高置信度|缓存原始置信度/).first()
    await expect(confidence).toBeVisible()
    await expect(confidence).not.toContainText('1.00')
  })
})
