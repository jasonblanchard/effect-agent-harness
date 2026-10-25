import { createFileRoute } from "@tanstack/react-router";
import { handler } from "../../server/chat.server.ts";

// Start's server route only forwards the request: effentic's router decodes
// it and streams the run back.
export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: ({ request }) => handler(request),
    },
  },
});
