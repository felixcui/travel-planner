import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { FileAgentSessionRepository, FileTripRepository } from "./repositories/files";
import { TravelAgentService } from "./services/agent";

const COOKIE = "travel_planner_visitor";

// Cookie contains the secret capability; records contain only its hash.
export async function visitorRepositories(create = false) {
  const jar = await cookies();
  let token = jar.get(COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    if (create) {
      token = randomBytes(32).toString("hex");
      jar.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 365 * 86400 });
    } else token = undefined;
  }
  const ownerId = token ? createHash("sha256").update(token).digest("hex") : "";
  const trips = new FileTripRepository(ownerId);
  const sessions = new FileAgentSessionRepository(ownerId);
  return { trips, sessions, agent: new TravelAgentService(sessions, trips) };
}
