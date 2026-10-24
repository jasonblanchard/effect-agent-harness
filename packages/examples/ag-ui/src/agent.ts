import { HttpAgent } from "@ag-ui/client";
import { DEMO_TOKEN } from "./auth.ts";
import { handler } from "./server.ts";

export const agent = new HttpAgent({
  // The host is never resolved: requests are routed to the in-process handler.
  url: "http://effentic.local/agent",
  threadId: "main-conversation",
  headers: { authorization: `Bearer ${DEMO_TOKEN}` },
  fetch: (url, init) => handler(new Request(url, init)),
});
