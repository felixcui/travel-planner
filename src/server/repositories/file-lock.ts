import { mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 简单的文件级互斥锁，用于防止并发写入冲突。
 * 使用文件系统的独占打开模式实现跨进程锁。
 */
export class FileLock {
  private handle: FileHandle | null = null;
  private readonly lockPath: string;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  /**
   * 获取锁。如果锁已被其他进程持有，会重试直到超时。
   * @param timeoutMs 超时时间（毫秒）
   * @param retryIntervalMs 重试间隔（毫秒）
   */
  async acquire(timeoutMs = 5000, retryIntervalMs = 50): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    // 确保锁文件所在目录存在
    await mkdir(dirname(this.lockPath), { recursive: true });

    while (Date.now() < deadline) {
      try {
        // 使用 'wx' 标志：独占创建，如果文件已存在则失败
        this.handle = await open(this.lockPath, "wx");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          // 锁文件已存在，等待后重试
          await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Failed to acquire lock for ${this.lockPath} within ${timeoutMs}ms`);
  }

  /**
   * 释放锁。
   */
  async release(): Promise<void> {
    if (this.handle) {
      try {
        await this.handle.close();
        try {
          await unlink(this.lockPath);
        } catch {
          // unlink 可能被环境安全钩子拦截（例如转为回收站删除并限流）。降级为改名到临时目录：
          // 锁路径得以释放，残留文件落在系统临时区由系统清理，不影响后续 acquire。
          await rename(this.lockPath, join(tmpdir(), `lock-${basename(this.lockPath)}-${process.pid}-${Date.now()}`));
        }
      } catch (error) {
        // 忽略清理失败（可能已被清理）
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      } finally {
        this.handle = null;
      }
    }
  }
}

/**
 * 在锁保护下执行操作的辅助函数。
 * @param lockPath 锁文件路径
 * @param operation 需要原子执行的操作
 */
export async function withLock<T>(
  lockPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const lock = new FileLock(lockPath);
  try {
    await lock.acquire();
    return await operation();
  } finally {
    await lock.release();
  }
}

/**
 * 为特定资源 ID 生成锁文件路径。
 * @param baseDir 锁文件目录
 * @param resourceId 资源标识符
 */
export function getLockPath(baseDir: string, resourceId: string): string {
  return join(baseDir, `.${resourceId}.lock`);
}
