import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * E2E 全局收尾：清掉本机 E2E 建的临时账号（``e2e_*``）。
 *
 * 为什么需要：用例自己通过 ``POST /api/auth/register`` 建账号（``e2e_cite_*``、
 * ``e2e_rewrite_*`` …），而账号**没有删除接口**，跑一轮就攒几个——管理端用户列表
 * 越拉越长，那些账号既不是测试数据产物也不是业务数据。
 *
 * 为什么走 Python 脚本而不是在 Node 里直连 MySQL：
 * 删除逻辑只能有一份（``scripts/purge_e2e_users.py``，pytest 的 conftest 与手工
 * 保洁用的是同一个函数）。在 Node 侧重写一遍 SQL，迟早两边判据漂移——而这是删用户表。
 *
 * 为什么失败只 warn 不 throw：用例的结论由断言决定，"保洁没做好"不该把一次绿色的
 * E2E 判红（账号残留是脏数据，不是功能故障）。
 */
export default function globalTeardown() {
  const backendDir = process.env.E2E_BACKEND_DIR ?? 'C:\\projects\\new_rag_project'
  const python =
    process.env.E2E_PYTHON ?? path.join(backendDir, '.venv', 'Scripts', 'python.exe')

  try {
    const output = execFileSync(
      python,
      [path.join(backendDir, 'scripts', 'purge_e2e_users.py')],
      { cwd: backendDir, encoding: 'utf8', timeout: 30_000 },
    )
    console.log(`[e2e] ${output.trim()}`)
  } catch (err) {
    console.warn(`[e2e] 测试账号清理已跳过：${(err as Error).message}`)
  }
}
