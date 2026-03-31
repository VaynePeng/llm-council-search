# Ai 理事会 · 前端（`@llm-council-search/web`）

[Next.js 16](https://nextjs.org/)（App Router）+ [Tailwind CSS 4](https://tailwindcss.com/) + [Radix UI](https://www.radix-ui.com/) 实现的聊天与三阶段结果展示：SSE、Stepper/Tabs、深浅色、移动端侧栏、高级设置（联网 / 主席 / 评委权重）、失败重试等。

**完整说明、免责声明、仓库链接**见 monorepo 根目录 [**`../../README.md`**](../../README.md)。

## 技术栈

- React 19、Next.js 16、`next-themes`
- 业务 UI 主要在 `src/components/CouncilApp.tsx`，API 客户端在 `src/lib/api.ts`

## 脚本

在 **monorepo 根目录**执行（推荐）：

```bash
pnpm --filter @llm-council-search/web dev
pnpm --filter @llm-council-search/web build
pnpm --filter @llm-council-search/web exec tsc --noEmit
```

在本目录：

```bash
pnpm dev      # next dev -p 3000
pnpm build
pnpm start
pnpm lint
```

## 环境变量

复制 `.env.example` 为 `.env.local`（可选）：

| 变量 | 说明 |
|------|------|
| `NEXT_PUBLIC_API_URL` | 后端基址，默认 `http://localhost:8001` |

开发时浏览器直连 API，需后端 CORS 允许当前前端源（如 `http://localhost:3000`）。

## 目录说明

- `src/app/` — App Router 布局与首页
- `src/components/` — 页面与 UI 组件
- `src/lib/api.ts` — 对 Hono API 的 fetch / SSE

## 默认开发地址

<http://localhost:3000>
