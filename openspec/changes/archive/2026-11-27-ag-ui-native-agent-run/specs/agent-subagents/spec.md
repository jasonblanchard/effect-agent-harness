## MODIFIED Requirements

### Requirement: A subagent call runs the child inside the parent's run
A call to a subagent tool in a step that finishes with reason `tool-calls` or `stop` SHALL run the child agent with the parent's AG-UI input with its `tools` emptied (so the parent's thread id, run id and properties, and no frontend tools) and the parent's services, and with the child's own system prompt, tools and step limit. The child SHALL NOT be offered the input's frontend tools. Its system prompt and tool handlers SHALL see that input through the run input service. The child SHALL have an id determined by the spawning tool call's id alone. The child's model steps and tool calls SHALL be checkpointed under names that cannot collide with the parent's or another child's, so a run executed again replays the child's completed work and never repeats its tool handlers. Several subagent calls in one step SHALL run concurrently, like other tool calls.

#### Scenario: Child replayed after a crash
- **WHEN** a run with a ledger-backed checkpoint store crashes after the child's first tool call completed, and the same run id is executed again
- **THEN** the child's tool handler has run exactly once in total, and the child's id is the same in both attempts

#### Scenario: Two calls, two ids
- **WHEN** the parent calls `researcher` twice in one step
- **THEN** both children run, each with a different id, and neither replays the other's steps

#### Scenario: Same call, same id
- **WHEN** two runs on different threads each call `researcher` with the same tool call id
- **THEN** both children have the same id

#### Scenario: Child reads the parent's input
- **WHEN** a run with `forwardedProps` `{ locale: "fr" }` calls `researcher`, whose tool reads the run input service
- **THEN** that tool sees the parent's input with `tools` empty, with `forwardedProps` `{ locale: "fr" }`, and the child's model is not offered the parent's frontend tools

### Requirement: Child entries are carried by the parent step
A child's entries SHALL name the child as their owner. They SHALL be handed to the step-finished hook with the entries of the parent step that made the call, after that step's assistant entry and before its tool entries, and SHALL NOT be committed on their own. The child's brief SHALL NOT be stored: each time the child runs, its prompt SHALL be rebuilt as the parent prefix (under the `conversation` mode), the brief from the spawning call's input, then the child's own entries. The parent's prompt SHALL NOT contain any entry owned by a child.

#### Scenario: Entries of a step with a subagent call
- **WHEN** parent step 1 calls `researcher`, whose child makes one tool call and then replies
- **THEN** the step-finished hook receives, once for step 1, the parent's assistant entry, the child's assistant, tool and assistant entries owned by the child, then the parent's tool entry for the call

#### Scenario: Parent prompt
- **WHEN** the parent's model is called in step 2
- **THEN** it receives the `researcher` call and its result, and none of the child's messages
