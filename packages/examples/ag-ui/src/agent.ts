import { HttpAgent, randomUUID } from "@ag-ui/client";
import { DEMO_TOKEN } from "./auth.ts";
import { handler } from "./server.ts";

export const agent = new HttpAgent({
  // The host is never resolved: requests are routed to the in-process handler.
  url: "http://effect-agent-harness.local/agent",
  // A new thread per process, so each chat is its own conversation (and its own session in a tracing backend).
  threadId: `chat-${randomUUID()}`,
  headers: { authorization: `Bearer ${DEMO_TOKEN}` },
  fetch: (url, init) => handler(new Request(url, init)),
});
