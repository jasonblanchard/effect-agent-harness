import * as readline from "readline";
import { agent } from "./agent.ts";
import { randomUUID } from "@ag-ui/client";
import type { AgentSubscriber, RunAgentParameters } from "@ag-ui/client";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question: string) => new Promise<string>((resolve) => rl.question(question, resolve));

const subscriber: AgentSubscriber = {
  onTextMessageStartEvent() {
    process.stdout.write("🤖 Assistant: ");
  },
  onTextMessageContentEvent({ event }) {
    process.stdout.write(event.delta);
  },
  onTextMessageEndEvent() {
    console.log("\n");
  },
  onToolCallStartEvent({ event }) {
    console.log("🔧 Tool call:", event.toolCallName);
  },
  onToolCallArgsEvent({ event }) {
    process.stdout.write(event.delta);
  },
  onToolCallEndEvent() {
    console.log("");
  },
  onToolCallResultEvent({ event }) {
    if (event.content) {
      console.log("🔍 Tool call result:", event.content);
    }
  },
};

// Runs the agent, then answers every approval it asks for and runs it again,
// until it finishes without an interrupt.
async function run(parameters: RunAgentParameters = {}) {
  await agent.runAgent(parameters, subscriber);
  if (agent.pendingInterrupts.length === 0) {
    return;
  }
  const resume: NonNullable<RunAgentParameters["resume"]> = [];
  for (const interrupt of agent.pendingInterrupts) {
    const answer = await ask(`❓ ${interrupt.message ?? "Approve the tool call?"} (y/n) `);
    resume.push({ interruptId: interrupt.id, status: "resolved", payload: { approved: answer.trim() === "y" } });
  }
  await run({ resume });
}

async function chatLoop() {
  console.log("🤖 AG-UI Assistant started!");
  console.log("Type your messages and press Enter. Press Ctrl+D to quit.\n");

  for (;;) {
    const input = await ask("> ").catch(() => undefined);
    if (input === undefined) {
      return;
    }
    if (input.trim() === "") {
      continue;
    }
    console.log("");

    agent.messages.push({
      id: randomUUID(),
      role: "user",
      content: input.trim(),
    });

    // Interrupts can still be open if answering them failed. AG-UI has a run
    // answer every open interrupt, so typing something new gives up on them.
    const cancelled = agent.pendingInterrupts.map((interrupt) => ({
      interruptId: interrupt.id,
      status: "cancelled" as const,
    }));

    try {
      await run(cancelled.length === 0 ? {} : { resume: cancelled });
    } catch (error) {
      console.error("❌ Error:", error);
    }
  }
}

// Handle Ctrl+D to quit
rl.on("close", () => {
  console.log("\n👋 Thanks for using AG-UI Assistant!");
  process.exit(0);
});

chatLoop().catch(console.error);
