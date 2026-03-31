> **项目说明（请务必阅读）**  
> - 本项目以 [**llm-council**](https://github.com/karpathy/llm-council) 为参考，在相同的三阶段议会思路上，额外加入了 **搜索（OpenRouter 联网 / `web` 插件）**、**分阶段与分模型重跑** 等能力。  
> - **本仓库全部代码均为 AI 生成**，未保证人工逐行审核；使用前请自行审查安全性与正确性，生产环境请充分测试，风险自负。

---

# llm-council-search（Ai 理事会）

**中文名：Ai 理事会**；仓库与 npm 根包名为 `llm-council-search`。

基于 **多模型三阶段议会**（独立回答 → 匿名互评与排名 → 主席汇总）的 Web 应用，使用 **pnpm workspace** 拆分为 API 与前端。


## 技术栈

| 包 | 说明 |
|----|------|
| **`apps/api`** | Hono + TypeScript，`tsx` 开发；OpenRouter Chat Completions；会话 JSON 存储 + 文件锁 |
| **`apps/web`** | Next.js 16（App Router）+ Tailwind 4 + Radix UI；`next-themes`；SSE 消费三阶段事件流 |

## 功能概览

- **三阶段流程**：Stage1 并行多模型 → Stage2 匿名评审与解析排名 → Stage3 主席综合；支持 **SSE** 与 **非流式** 接口。
- **评委权重**：Stage2 聚合排名加权；高级设置里 Slider + `localStorage`；请求体支持 `judge_weights` / 别名 `weights`。
- **主席模型**：可选 `chairman_model` / 别名 `final_model`；设置内下拉 + 自定义模型 ID。
- **联网**：OpenRouter `web` 插件；失败时 **自动去掉插件重试**（未实现 `:online` 模型后缀策略）。
- **重跑**：按模型重跑 Stage1、整阶段 Stage2、Stage3；**失败顶栏可「重试」**（发送流式与重跑均支持）。
- **UI**：Stepper 进度；**Stage 1/2/3 主 Tab** + Stage1/2 内 **按模型（及聚合）子 Tab**，固定高度面板内滚动，减少整页拖动。
- **会话**：列表、删除会话；助手消息持久化 `metadata`（`label_to_model`、`aggregate_rankings`）、`stale`、`assistantMessageId`。
- **环境变量**：API 启动时用 **dotenv** 读取仓库根目录 `.env`，可选 `apps/api/.env` 覆盖。

## 要求

- Node **20+**
- **pnpm 9+**

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 OPENROUTER_API_KEY
pnpm dev
```

- **API**：<http://localhost:8001>
- **Web**：<http://localhost:3000>（若 `EADDRINUSE`，请先释放 3000 或临时改 `apps/web/package.json` 里 `next dev -p`）

单独启动：`pnpm dev:api` / `pnpm dev:web`。

### 环境变量

1. **根目录 `.env`**（推荐，与 `.env.example` 一致）  
   - 必填：`OPENROUTER_API_KEY`  
   - 可选：`CHAIRMAN_MODEL`、`TITLE_MODEL`、`PORT`（API，默认 `8001`）、`DATA_DIR`（会话目录绝对路径）  
   - 勿将 `.env` 提交到 Git（已在 `.gitignore` 中忽略）。

2. **覆盖**：可在 `apps/api/.env` 再放一份，会覆盖根目录同名变量。

3. **前端**（可选）：`apps/web/.env.local`，见 `apps/web/.env.example`  
   - `NEXT_PUBLIC_API_URL` 默认 `http://localhost:8001`（开发时直连 API，CORS 已允许 `localhost:3000` / `5173`）。

### 常见问题

| 现象 | 处理 |
|------|------|
| OpenRouter `401 Missing Authentication header` | 密钥必须写在 **本仓库根目录**（或 `apps/api/.env`），不是别的项目路径下的 `.env`；改后重启 `pnpm dev`。 |
| Web 启动报端口占用 | 结束占用 3000 的进程，或改 `next dev` 端口并在 `apps/api/src/index.ts` 的 CORS `origin` 中加入新前端地址。 |

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | `council_models`、`chairman_model`、`title_model` |
| GET | `/api/conversations` | 会话列表元数据 |
| POST | `/api/conversations` | 新建会话 |
| GET | `/api/conversations/:id` | 完整会话 |
| DELETE | `/api/conversations/:id` | 删除会话 |
| POST | `/api/conversations/:id/message` | 非流式跑完全程 |
| POST | `/api/conversations/:id/message/stream` | SSE，事件类型与经典三阶段约定一致 |
| POST | `.../messages/:msgIndex/rerun-stage1-model` | body：`{ model, use_web_search? }` |
| POST | `.../messages/:msgIndex/rerun-stage2` | body：`{ use_web_search?, judge_weights?, weights? }` |
| POST | `.../messages/:msgIndex/rerun-stage3` | body：`{ chairman_model?, final_model?, use_web_search?, judge_weights?, weights? }` |

### 发消息 body（`message` / `message/stream`）

- `content`（必填）
- `chairman_model` 或 **`final_model`**（可选，后者为别名）
- `use_web_search`（可选）
- `judge_weights` 或 **`weights`**（可选）；同时存在时以 **`judge_weights`** 为准

### 联网说明

仅通过 OpenRouter 的 `web` 插件；**未实现**「`:online` 模型后缀」与插件并行的策略。生产若需同源，可在 Next `rewrites` 将 `/api` 代理到 Hono（需自行配置）。

### 数据目录

默认：`apps/api/data/conversations/*.json`。同一会话写操作经锁串行化，避免并发损坏。

## 构建

```bash
pnpm build
```

- API：`pnpm --filter @llm-council-search/api build` → `apps/api/dist/`，生产可用 `node dist/index.js`（需先 build 并配置环境变量）。
- Web：`pnpm --filter @llm-council-search/web build` → Next 产物。

类型检查示例：

```bash
pnpm --filter @llm-council-search/api exec tsc --noEmit
pnpm --filter @llm-council-search/web exec tsc --noEmit
```

## 仓库结构

```
apps/
  api/          # Hono 服务、OpenRouter、council 逻辑、存储
  web/          # Next 应用、聊天 UI、SSE 客户端
```

## 许可证与致谢

- 参考实现：<https://github.com/karpathy/llm-council>；感谢原作者与社区分享的三阶段议会思路。
