import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { request, type FullConfig } from '@playwright/test'

/**
 * E2E 临时管理员账号（文件管理用例要"管理员看到全部文件"这一条）。
 *
 * 为什么固定名字而不是随机：**自助注册建不出管理员**（``routers/auth.py`` 不接受 role，
 * 这是有意的——否则任何能打开登录页的人都能自封管理员），所以只能走后端 CLI。
 * 固定名 + ``e2e_`` 前缀有两个好处：重复跑时账号已存在也能照常登录（口令不变），
 * 而收尾的 ``purge_e2e_users.py`` 会按前缀把它清掉。
 */
export const E2E_ADMIN_USERNAME = 'e2e_admin_file'
export const E2E_ADMIN_PASSWORD = 'E2eAdmin_123!'

/**
 * E2E 全局准备：① 硬校验后端注册开关 ② 建一个可丢弃的管理员账号。
 *
 * 为什么走 Python CLI 而不是在 Node 里直连 MySQL 插一行：口令必须用后端的
 * ``utils/passwords.hash_password``（bcrypt）算——在 Node 侧重写一遍哈希，
 * 迟早会因为成本参数/算法差异造出一个"密码明明对却登不上"的账号。
 *
 * 建账号失败只 warn：账号已存在是最常见的情况（上一轮没跑 teardown），
 * 那是环境状态而不是功能故障；真正的判据在用例里（登录不上就 skip 并说明原因）。
 * 但**注册开关**不一样：它必须先硬校验，见 ``assertAllowRegister``。
 */
export default async function globalSetup(config: FullConfig) {
  // 闸门放在建账号之前：开关没开时整轮反正要挂，没必要先造一个用不上的管理员
  await assertAllowRegister(config)
  const backendDir = process.env.E2E_BACKEND_DIR ?? 'C:\\projects\\new_rag_project'
  const python =
    process.env.E2E_PYTHON ?? path.join(backendDir, '.venv', 'Scripts', 'python.exe')

  try {
    const output = execFileSync(
      python,
      [
        path.join(backendDir, 'scripts', 'create_admin.py'),
        '--username',
        E2E_ADMIN_USERNAME,
        '--password',
        E2E_ADMIN_PASSWORD,
      ],
      { cwd: backendDir, encoding: 'utf8', timeout: 60_000 },
    )
    console.log(`[e2e] ${output.trim()}`)
  } catch (err) {
    console.warn(
      `[e2e] 临时管理员创建已跳过（可能已存在）：${(err as Error).message.split('\n')[0]}`,
    )
  }
}

/**
 * 硬断言后端 ``allow_register=true``。
 *
 * 为什么必须是**抛错**，而不是像用例里那样 ``test.skip``：
 * 后端默认配置就是 ``allow_register=false``，而所有"自建临时账号"的用例都挂在
 * ``helpers.registerTempUser`` 上（模块 5b / 6 的新用例全在内）。返回 null 让调用方
 * ``test.skip`` 收场的结果是整轮 ``3 passed / 14 skipped`` 且**退出码 0**——
 * 新功能一行都没验，CI 却是绿的（2026-10-12 实测踩到，所以在这里堵死）。
 * 现在开关没开就在准备阶段直接失败，红得可见，连用例都不进。
 *
 * 判据是"等于 ``true``"而不是"不等于 false"：配置读不出来或形状变了都按**关闭**处理，
 * 与前端登录页的默认一致（``allow_register`` 拿不到就当没开，安全默认）。
 */
async function assertAllowRegister(config: FullConfig) {
  // 与 playwright.config.ts 的 baseURL 同源：优先取项目配置，其次环境变量，最后默认前端端口
  const baseURL =
    config.projects[0]?.use?.baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:5173'
  const allowed = await readAllowRegister(baseURL)

  if (allowed !== true) {
    throw new Error(
      'E2E 需要后端 allow_register=true，请用环境变量启动后端' +
        `（GET ${baseURL}/api/auth/config 返回 allow_register=${JSON.stringify(allowed)}）。` +
        '启动示例：cmd /c "set ALLOW_REGISTER=true && .venv\\Scripts\\python.exe ' +
        '-m uvicorn api.main:app --port 8000 --workers 1"',
    )
  }

  console.log(`[e2e] 注册开关已确认打开：${baseURL}/api/auth/config → allow_register=true`)
}

/**
 * 读 ``{allow_register}``。用 Playwright 的 request 上下文而不是 Node 的 fetch：
 * 与用例走同一条路（前端 5173 把 ``/api`` 反代给后端 8000），这条路不通的话
 * 用例本来也全跑不起来，所以这里同样直接报错而不是静默放行。
 */
async function readAllowRegister(baseURL: string): Promise<unknown> {
  const context = await request.newContext({ baseURL })
  try {
    const resp = await context.get('/api/auth/config')
    if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`)
    return ((await resp.json()) as { allow_register?: unknown }).allow_register
  } catch (err) {
    throw new Error(
      'E2E 需要后端 allow_register=true，请用环境变量启动后端；' +
        `但读不到 ${baseURL}/api/auth/config（${(err as Error).message.split('\n')[0]}）。` +
        '请先起后端 8000 与前端 5173（npm run dev）。',
    )
  } finally {
    await context.dispose()
  }
}
