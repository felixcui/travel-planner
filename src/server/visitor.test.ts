import { beforeEach, describe, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => jar }));
import { visitorRepositories } from "./visitor";

beforeEach(() => { jar.get.mockReset(); jar.set.mockReset(); });
describe("匿名浏览器身份", () => {
  it("只读访问不创建 Cookie，写入入口签发不可预测的 HttpOnly 凭据", async () => {
    await visitorRepositories();
    expect(jar.set).not.toHaveBeenCalled();
    await visitorRepositories(true);
    expect(jar.set).toHaveBeenCalledWith("travel_planner_visitor", expect.stringMatching(/^[a-f0-9]{64}$/), expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }));
    const first = jar.set.mock.calls[0][1];
    await visitorRepositories(true);
    expect(jar.set.mock.calls[1][1]).not.toBe(first);
  });
  it("合法身份复用，伪造的短 Cookie 不被当成归属标识", async () => {
    jar.get.mockReturnValue({ value: "a".repeat(64) });
    await visitorRepositories(true);
    expect(jar.set).not.toHaveBeenCalled();
    jar.get.mockReturnValue({ value: "owner-a" });
    await visitorRepositories(true);
    expect(jar.set).toHaveBeenCalledOnce();
  });
});
