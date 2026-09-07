import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), share: vi.fn() }));
vi.mock("@/server/visitor", () => ({ visitorRepositories: async () => ({ trips: { get: mocks.get, save: mocks.save } }) }));
vi.mock("@/server/repositories/files", () => ({ FileShareRepository: class { save = mocks.share; } }));
import { GET, PUT } from "./[id]/route";
import { POST as share } from "../shares/route";
beforeEach(() => { mocks.get.mockReset(); mocks.save.mockReset(); mocks.share.mockReset(); });

describe("行程访问边界", () => {
  it("无归属的详情、写入和分享都拒绝，不触发持久写入", async () => {
    mocks.get.mockResolvedValue(null);
    const params = { params: Promise.resolve({ id: "trip_other" }) };
    expect((await GET(new Request("http://localhost"), params)).status).toBe(404);
    expect((await PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ id: "trip_other", ownerId: "forged" }) }), params)).status).toBe(404);
    expect((await share(new Request("http://localhost", { method: "POST", body: JSON.stringify({ id: "trip_other" }) }))).status).toBe(404);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
  });
  it("分享使用服务端所属行程，不采纳客户端提交的另一份内容", async () => {
    const saved = { id: "trip_owned", request: { notes: "stored" } };
    mocks.get.mockResolvedValue(saved);
    const response = await share(new Request("http://localhost", { method: "POST", body: JSON.stringify({ id: "trip_owned", request: { notes: "forged" } }) }));
    expect(response.status).toBe(200);
    expect(mocks.share).toHaveBeenCalledWith(expect.any(String), saved);
  });
});
