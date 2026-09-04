import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: false,
  // pi 包内部使用变量形式动态 import()（register-builtins/env-api-keys），
  // webpack 无法静态分析，必须标记为 server external 交给 Node 运行时原生加载
  serverExternalPackages: ["@mariozechner/pi-ai", "@mariozechner/pi-agent-core"],
  // 本地文件仓库允许通过 DATA_DIR 指向任意目录，文件追踪器因此会保守地把
  // 整个工作区加入每个使用仓库的函数。Vercel 生产环境使用 Blob，这些构建、
  // 源码和本地数据文件都不属于函数运行时依赖，必须从部署产物中排除。
  outputFileTracingExcludes: {
    "/*": [
      ".next/lock",
      ".next/cache/**/*",
      ".next/dev/**/*",
      "data/**/*",
      ".git/**/*",
      ".claude/**/*",
      ".workbuddy/**/*",
      "scripts/**/*",
      "src/**/*",
      ".env*",
      "*.md",
      "*.tsbuildinfo",
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
