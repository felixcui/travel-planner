/**
 * 数据存储后端抽象。
 * 本地开发走文件系统；Vercel 等无服务器环境走 Redis REST，避免 /tmp 跨实例丢失。
 */
export interface StorageBackend {
  /** 读取指定类型的单个 JSON 对象，不存在时返回 null */
  read(type: string, id: string): Promise<unknown | null>;
  /** 写入指定类型的单个 JSON 对象 */
  write(type: string, id: string, value: unknown): Promise<void>;
  /** 列出指定类型下所有对象 id */
  list(type: string): Promise<string[]>;
}

export function isRedisEnabled() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
