import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright 配置（模块 2 的 E2E）。
 *
 * 刻意**不**用 webServer 自动起服务：后端是 `.venv` 里的 uvicorn、前端是 vite，
 * 两个进程跨目录、还要等模型加载；把这些塞进配置里只会让"E2E 跑不起来"变成更难查的问题。
 * 跑之前请确认：后端 127.0.0.1:8000 已起、前端 5173 已起（README「REST API」一节）。
 *
 * 账号策略：用例自己通过 `POST /api/auth/register` 建临时账号（需要 `allow_register = true`），
 * 所以**不依赖任何现有账号的密码**，也不会去改真实账号的密码。
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // 用例会建账号 / 改密码，串行 + 单 worker 跑，避免互相踩
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  /**
   * 全局准备：建一个可丢弃的管理员账号（``e2e_admin_file``）。
   *
   * 文件管理用例要验"管理员看到全部文件、点下载能拿到原件"，而自助注册**只能建普通用户**
   * （后端不接受 role，这是有意的安全边界），所以只能在后端用 CLI 建。
   * 与 globalTeardown 里那次清理是同一套判据：账号用 ``e2e_`` 前缀 → 跑完被收走。
   */
  globalSetup: './e2e/global-setup.ts',
  /**
   * 全局收尾：清掉本机 E2E 建的临时账号（``e2e_*``）。
   *
   * 账号没有删除接口，不收尾就会一轮攒几个（管理端用户列表肉眼可见地变长）。
   * 删除逻辑复用后端 ``scripts/purge_e2e_users.py``——判据只有一份。
   */
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'msedge',
      /**
       * 用系统自带的 Edge（内核同为 Chromium）。
       *
       * 为什么不用 Playwright 自带的 chromium：这台开发机的**组织策略（Device Guard）
       * 禁止运行**该二进制，启动时报
       *   `browserType.launch: spawn UNKNOWN`
       * 手工执行则是"已被组织用 Device Guard 策略阻止"。
       * 换到没有该策略的机器上想用自带浏览器时，设 `E2E_BROWSER=chromium` 即可。
       */
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.E2E_BROWSER === 'chromium' ? undefined : 'msedge',
      },
    },
  ],
})
