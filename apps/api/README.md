# Vela 助手 · 后端（`@llm-council-search/api`）

[Hono](https://hono.dev/) + TypeScript 实现的 API 服务：Ofox 三阶段议会、Tavily 联网检索、会话 JSON 存储、SSE 流式端点、分阶段重跑等。

**完整说明、免责声明、仓库链接**见 monorepo 根目录 [**`../../README.md`**](../../README.md)。

## 技术栈

- **运行时**：Node 20+，`tsx watch` 开发
- **框架**：Hono、`@hono/node-server`
- **配置**：`dotenv` 读取 **`../../.env`**（仓库根），可选本目录 **`.env`** 覆盖

## 脚本

在 **monorepo 根目录**执行（推荐）：

```bash
pnpm --filter @llm-council-search/api dev
pnpm --filter @llm-council-search/api build
pnpm --filter @llm-council-search/api exec tsc --noEmit
```

在本目录执行需已安装依赖：

```bash
pnpm dev      # tsx watch src/index.ts
pnpm build    # tsc → dist/
pnpm start    # node dist/index.js（需先 build）
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `OFOX_API_URL` | 可选，默认 `https://api.ofox.ai/v1/chat/completions` |
| `TAVILY_API_URL` | 可选，默认 `https://api.tavily.com/search` |
| `PORT` | 默认 `8001` |
| `CHAIRMAN_MODEL` / `TITLE_MODEL` | 可选 |
| `DATA_DIR` | 可选，会话目录；默认 `apps/api/data/conversations` |

## 目录说明

- `src/index.ts` — 路由与 SSE
- `src/council.ts` — Stage1/2/3 与聚合
- `src/ofox.ts` — Ofox 模型请求
- `src/tavily.ts` — Tavily 搜索封装
- `src/storage.ts` — 会话读写
- `src/config.ts` — 配置（含 dotenv 加载）
- `src/lock.ts` — 会话文件锁

## 默认服务地址

开发：<http://localhost:8001>（健康检查 `GET /`）
