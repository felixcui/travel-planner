import { describe, expect, it, vi } from "vitest";

const handleTurn = vi.fn(async (_id: string, _input: unknown, emit: (event: unknown) => void) => {
  emit({ type: "ack", message: "已收到" });
  emit({ type: "progress", message: "正在整理" });
});

vi.mock("@/server/services/agent", () => ({ TravelAgentService: class { handleTurn = handleTurn; } }));

import { POST } from "./route";

describe("POST /api/agent/sessions/[id]/turns", () => {
  it("按 NDJSON 顺序输出 Agent 事件", async () => {
    const response = await POST(new Request("http://localhost/api/agent/sessions/session_1/turns", { method: "POST", body: JSON.stringify({ type: "message", message: "去川西" }) }), { params: Promise.resolve({ id: "session_1" }) });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((event) => event.type)).toEqual(["ack", "progress"]);
    expect(handleTurn).toHaveBeenCalledWith("session_1", { type: "message", message: "去川西" }, expect.any(Function));
  });
});
