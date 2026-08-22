import type { AgentEvent } from "@/lib/domain";
import { TravelAgentService } from "@/server/services/agent";

export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const input = await request.json().catch(() => ({}));
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        await new TravelAgentService().handleTurn(id, input, send);
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : "Agent 处理失败" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
