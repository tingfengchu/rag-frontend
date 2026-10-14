import { expect, test } from '@playwright/test'

import { antdButton, loginForm, registerTempUser } from './helpers'

/**
 * 检索设置：Rerank 模型下拉的**默认值**（用户实测提的改动）。
 *
 * 钉住三件事：
 *   1. 默认选中 `bge-reranker-base`（中文可用；MiniLM 是英文模型，中文实测分数饱和）；
 *   2. MiniLM 仍在下拉里（**只改默认值，没有删选项**）；
 *   3. 手动切回 MiniLM 也能生效（默认值不是"唯一可选项"，否则等于把备选藏起来）。
 *
 * 为什么这条要进 E2E 而不是只管后端单测：默认值在**两个地方**各自写了一份
 * （前端 `DEFAULT_RERANK_MODEL` 与后端 `utils.rerank.DEFAULT_RERANK_MODEL`），
 * 后端那份有 `tests/unit/test_rerank.py::TestDefaultModelIsAligned` 钉住，
 * 前端这份只能在这里钉——界面上的默认值就是用户看到的那一个。
 *
 * 需要 `allow_register=true`（用例自己建临时账号）。
 */
test.describe('检索设置：Rerank 模型默认值', () => {
  test('默认 bge-reranker-base，MiniLM 仍可选', async ({ page, request }) => {
    test.setTimeout(120_000)

    const password = 'E2eRerank_123!'
    const username = await registerTempUser(request, 'e2e_rerank', password)
    test.skip(!username, '需要 rag_config.txt 里 allow_register = true 才能自建临时账号')

    await page.goto('/login')
    await loginForm(page).getByLabel('用户名').fill(username as string)
    await loginForm(page).getByLabel('密码', { exact: true }).fill(password)
    await antdButton(page, '登录').click()
    await expect(page).toHaveURL(/\/chat/)

    // ⚠️ 不要用 `.ant-select-selection-item`：antd v6 在**单选**下不再渲染这个 class
    //    （实测该 locator 报 element(s) not found）。这里断言整个控件的**文案**，
    //    既稳又更贴近"用户看到的是什么"；点击则走 role=combobox（无障碍属性，最稳）。
    const select = page.locator('[data-testid="rerank-model-select"]')
    await expect(select).toBeVisible()
    await expect(select).toContainText('bge-reranker-base')
    // 默认值必须真的是"中文推荐 · 默认"那一项，而不是列表里的另一项
    await expect(select).toContainText('默认')

    // 打开下拉：两个模型都在（MiniLM 是备选，不是被删掉）。
    // ⚠️ 两个 antd 坑（都实测踩过）：
    //   ① getByText 会同时命中外层 role=option 与内层 .ant-select-item-option-content
    //      → strict mode violation；所以用 role=option / 容器文案断言；
    //   ② 下拉是 rc-virtual-list 虚拟列表：role=option 能定位到，但 toBeVisible()
    //      判它 hidden（行的盒子由虚拟列表动态测量）→ 鼠标点不动，改用键盘导航。
    await select.getByRole('combobox').click()
    const dropdown = page.locator('.ant-select-dropdown:visible')
    await expect(dropdown).toContainText('bge-reranker-base')
    await expect(dropdown).toContainText('ms-marco-MiniLM-L-6-v2')

    // 切到 MiniLM 生效（说明备选确实能选）。顺序固定为 [BGE, MiniLM]，
    // 所以从默认项按一次"下"就是 MiniLM。
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(select).toContainText('ms-marco-MiniLM-L-6-v2')

    // 再切回默认（按一次"上"）
    await select.getByRole('combobox').click()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(select).toContainText('bge-reranker-base')
  })
})
