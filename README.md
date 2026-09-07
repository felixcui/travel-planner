# 去野 · 智能自驾旅行规划

面向国内多日自驾的对话式 Agent MVP。用户用自然语言描述目的地、天数、同行人员与偏好，Agent 渐进追问后生成两套行程，通过每日卡片、地图路线和详情抽屉展示；后续可继续通过对话解释或修改方案，并支持修改预览、版本恢复、自动保存、只读分享、Excel/PDF 导出。

## 本地运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

打开 <http://127.0.0.1:3000>。已保存行程为 <http://127.0.0.1:3000/trips>，运营后台为 <http://127.0.0.1:3000/admin>。

必须配置：

- `GLM_API_KEY`：生成候选行程并整理搜索资料。
- `TAVILY_API_KEY`：自动搜索和提取景点资料。
- `OPS_SECRET`：运营后台本地密钥。

模型不可用或无法定位地点时，详细规划会明确报错并保留草案；真实地点间的道路服务失败时，可返回明确标记的车程估算，不把降级数据伪装成实时精确信息。

部署到 Vercel 时，还需在项目的 Storage 页面创建并连接一个 **Private Vercel Blob**。Vercel Functions 使用 Blob 持久化会话、行程、景点和分享数据；本地开发与测试仍使用 `data/` 下的 JSON 文件。

## 私人保存与路线校验

- 免登录用户通过 HttpOnly 浏览器 Cookie 获得独立身份；行程、会话的列表、详情、写入和分享都由服务端验证归属。清除 Cookie 或换浏览器后，不能通过猜测行程 ID 恢复访问。
- 升级前没有 `ownerId` 的旧行程和会话保留在存储中，但不再公开列出、读取或编辑，也不允许通过旧链接自动认领。恢复旧数据需要维护者核实归属后单独迁移；本次部署不重写或删除旧数据。
- 分享只使用本人服务端已保存版本，删除会话关联、归属、编辑历史、私人备注及儿童具体年龄；分享链接保持只读。浏览器未重算的修改不能直接分享。
- 详细规划必须给出真实起点与终点；“回家”等意图不能作为地点。不能定位的地点不会生成虚构坐标的导航路线，模型失败也不再用占位景点生成正式行程。
- 超限、必去遗漏、无效地点等会显示“需要调整”；最后一段到住宿/终点的驾驶也计入结束时间。完成道路计算不代表实时通行、开放时间和预约已经核实。

## 架构边界

- `SearchProvider`：一期 Tavily，未来可新增其他搜索实现。
- `LlmProvider`：一期 GLM-5.2。
- `MapProvider`：一期 Nominatim、OSM、OSRM。
- Repository：本地使用服务端 JSON 文件；Vercel 环境使用 Private Vercel Blob，避免 Serverless 实例间 `/tmp` 不共享导致数据丢失。浏览器同时使用 IndexedDB 保存最后草稿。
- Agent：匿名会话保存在 `data/agent-sessions/`；行程与对话分离，分享快照不会包含对话或版本历史。
- 当前新疆地图保留在 `/Users/felixcui/Documents/tmp/xinjiang-roadtrip-map/index.html`，只作为交互与回归参考，不与产品代码耦合。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

真实外部服务冒烟测试会消耗 API 额度，应使用单个短行程并观察页面上的来源、估算状态和错误提示。

## Agent API

- `POST /api/agent/sessions`：创建会话，可传 `tripId` 恢复已有行程。
- `GET /api/agent/sessions/:id`：恢复对话及其关联行程。
- `POST /api/agent/sessions/:id/turns`：发送消息、生成/选择方案或确认修改，返回 NDJSON 事件流。
