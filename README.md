# RAG 知识库问答 · Web 前端

多租户 RAG 知识库问答平台的浏览器端：**React 19 + TypeScript + Vite 8 + Ant Design 6**，
对接同机的 FastAPI 后端（`C:\projects\new_rag_project`，`:8000`）。

核心体验：**SSE 流式问答**（打字机效果 + 可中断）、引用溯源（文件名 / 页码 / 置信度）、
公共库 / 私人库切换、按文件过滤、Rerank 模型可选、清空对话（同时清 Redis 历史）。

---

## 🚀 本地启动

### 0. 依赖安装

| 组件 | 建议版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（LTS） | `node -v` 自检 |
| Python | 3.12 | 后端 `.venv` |
| MySQL / Redis / Elasticsearch | 8.0 / 7.x / 8.11 | `docker compose` 拉起 |

```powershell
# 中间件（MySQL + Redis + ES，ES 自带 IK 中文分词）
cd C:\projects\new_rag_project
docker compose up -d db es redis

# 后端依赖与配置
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env                        # 填 ZHIPU_API_KEY / MySQL 口令等
copy rag_config.txt.example rag_config.txt

# 管理员账号（默认密码 ChangeMe_123!）
.venv\Scripts\python.exe scripts\create_admin.py

# 前端依赖
cd C:\projects\rag-frontend
npm install
```

### 1. 启动后端（FastAPI，:8000）

```powershell
cd C:\projects\new_rag_project
.venv\Scripts\python.exe -m uvicorn api.main:app --host 0.0.0.0 --port 8000
```

等价脚本：`C:\projects\rag-frontend\start_backend.ps1`

* 存活探针：<http://localhost:8000/api/health> → `{"ok":true,"service":"rag-api",...,"es_ready":true}`
* 接口文档：<http://localhost:8000/api/docs>
* **不要加 `--workers`**（默认即 1）：每个 worker 都会各自常驻 embedding / Cross-Encoder(~80MB) /
  Docling 模型和独立的向量库连接，只会更慢更吃内存——原因见 `api/main.py` 顶部 docstring。

### 2. 启动前端（Vite，:5173）

```powershell
cd C:\projects\rag-frontend
npm run dev
```

浏览器打开 <http://localhost:5173>。

前端只请求相对路径 `/api/*`，由 Vite 开发代理转发到 `http://localhost:8000`（见 `vite.config.ts`），
于是**浏览器视角下前后端同源**：后端不必配 CORS，会话 Cookie（HttpOnly + SameSite=Lax）照常收发。
⚠️ 代理**不要**加 rewrite 去掉 `/api` 前缀——后端路由本身带 `/api`（`include_router(..., prefix="/api")`），去掉就 404。

### 3. 演示账号

| 用户名 | 密码 | 角色 |
| --- | --- | --- |
| `admin` | `ChangeMe_123!` | admin |

> ⚠️ 这是 `scripts/create_admin.py` 的**默认密码**，登录后请立刻在「侧边栏 → 修改密码」改掉。
> 公网演示时它等于把管理员权限公开：建议改密码，或另建一个普通（`user`）演示账号。

<!-- PART2 -->

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
