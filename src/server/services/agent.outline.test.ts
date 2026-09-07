import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@/lib/domain";
vi.mock("../providers/llm", () => ({ createLlmProvider: () => ({ generateOutline: async () => ({ version: 1, summary: "往返", days: [{ day: 1, title: "西湖一日游", places: ["西湖"], stay: "无（当日往返）" }], highlights: [], notes: "" }) }) }));
import { TravelAgentService } from "./agent";

describe("草案展示前的终点约束", () => {
  it("一日往返先展示用户的具体终点，再等待确认", async () => {
    let saved: AgentSession = { schemaVersion: 1, id: "session_test", stage: "ready", brief: { destination: "杭州", days: 1, startPoint: "杭州东站", endPoint: "杭州东站", confirmedFields: ["destination", "days", "startPoint", "endPoint"] }, interviewQueue: [], messages: [], createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" };
    const sessions = { get: async () => saved, save: async (value: AgentSession) => (saved = value) };
    const service = new TravelAgentService(sessions);
    const { session } = await service.handleTurn(saved.id, { type: "create_outline" });
    expect(session.stage).toBe("drafting");
    expect(session.outline?.days[0].stay).toBe("杭州东站");
    expect(session.messages.at(-1)?.content).toContain("杭州东站");
    expect(session.messages.at(-1)?.content).not.toContain("无（当日往返）");
  });
});
