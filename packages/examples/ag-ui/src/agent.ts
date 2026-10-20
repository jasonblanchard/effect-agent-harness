import { HttpAgent } from "@ag-ui/client";
import { handler } from "./server.ts";

export const agent = new HttpAgent({
  // The host is never resolved: requests are routed to the in-process handler.
  url: "http://effentic.local/agent",
  threadId: "main-conversation",
  fetch: (url, init) => handler(new Request(url, init)),
});
