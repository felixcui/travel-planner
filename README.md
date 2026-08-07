# 去野 · 智能自驾旅行规划

面向国内多日自驾的本地 MVP。用户输入目的地、天数、同行人员与偏好后，系统生成两套行程，通过每日卡片、地图路线和详情抽屉展示，并支持编辑、局部重算、只读分享、Excel/PDF 导出。

## 本地运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

打开 <http://127.0.0.1:3000>。运营后台为 <http://127.0.0.1:3000/admin>。

必须配置：

- `GLM_API_KEY`：生成候选行程并整理搜索资料。
- `TAVILY_API_KEY`：自动搜索和提取景点资料。
- `OPS_SECRET`：运营后台本地密钥。

未配置或外部服务不可用时，应用会返回明确标记的演示/估算结果，不把降级数据伪装成实时精确信息。

## 架构边界

- `SearchProvider`：一期 Tavily，未来可新增其他搜索实现。
- `LlmProvider`：一期 GLM-5.2。
- `MapProvider`：一期 Nominatim、OSM、OSRM。
- Repository：一期 JSON 文件，浏览器草稿使用 IndexedDB。
- 当前新疆地图保留在 `/Users/felixcui/Documents/tmp/xinjiang-roadtrip-map/index.html`，只作为交互与回归参考，不与产品代码耦合。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

真实外部服务冒烟测试会消耗 API 额度，应使用单个短行程并观察页面上的来源、估算状态和错误提示。
