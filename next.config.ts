import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: false,
  // pi 包内部使用变量形式动态 import()（register-builtins/env-api-keys），
  // webpack 无法静态分析，必须标记为 server external 交给 Node 运行时原生加载
  serverExternalPackages: ["@mariozechner/pi-ai", "@mariozechner/pi-agent-core"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
