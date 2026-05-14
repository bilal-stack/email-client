---
name: anthropic-streaming
description: Canonical pattern for calling Anthropic from a Server Action with prompt caching + streaming to the client. Read this before adding any AI feature.
---

# Anthropic streaming + prompt caching

Use this pattern for every AI feature. It's the difference between a cheap, fast feature and an expensive, slow one.

## Setup

```ts
// lib/ai/client.ts
import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { "anthropic-version": "2023-06-01" },
});

export const MODEL_FAST = "claude-haiku-4-5-20251001";    // bulk classification, summaries
export const MODEL_BEST = "claude-sonnet-4-6";            // drafts, anything user-facing
```

## Prompt caching — mandatory for reused system prompts

Mark the system block with `cache_control: { type: "ephemeral" }`. Subsequent calls within the 5-minute TTL window pay the cached input rate (~1/10 of normal).

```ts
const response = await anthropic.messages.create({
  model: MODEL_FAST,
  max_tokens: 1024,
  system: [
    {
      type: "text",
      text: SUMMARY_SYSTEM_PROMPT, // long, static — worth caching
      cache_control: { type: "ephemeral" },
    },
  ],
  messages: [{ role: "user", content: userInput }],
});
```

Anything that isn't stable across calls (user input, the thread under analysis) goes in `messages`, not `system`.

## Streaming from a Server Action to a client component

```ts
// app/inbox/thread/[id]/actions.ts
"use server";
import { createStreamableValue } from "ai/rsc";

export async function streamDraft(threadId: string) {
  const stream = createStreamableValue("");
  (async () => {
    const response = anthropic.messages.stream({
      model: MODEL_BEST,
      max_tokens: 1024,
      system: [{ type: "text", text: DRAFT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: await buildDraftPrompt(threadId) }],
    });
    for await (const event of response) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        stream.update((curr) => curr + event.delta.text);
      }
    }
    stream.done();
  })();
  return { stream: stream.value };
}
```

Client component reads the stream with `useStreamableValue` and renders progressively.

## Tool-use for structured output (prioritization)

```ts
const tools = [
  {
    name: "report_priority",
    description: "Report the priority assessment for this message.",
    input_schema: {
      type: "object",
      properties: {
        priority: { type: "integer", minimum: 1, maximum: 5 },
        reason: { type: "string", maxLength: 280 },
        suggestedActions: {
          type: "array",
          items: { enum: ["reply", "archive", "snooze", "delegate"] },
        },
      },
      required: ["priority", "reason", "suggestedActions"],
    },
  },
] as const;

const response = await anthropic.messages.create({
  model: MODEL_FAST,
  max_tokens: 512,
  tools,
  tool_choice: { type: "tool", name: "report_priority" },
  system: [
    { type: "text", text: PRIORITIZE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ],
  messages: [{ role: "user", content: messageJsonPayload }],
});

const toolUse = response.content.find((b) => b.type === "tool_use");
const parsed = PriorityZodSchema.parse(toolUse?.input); // ALWAYS Zod-validate
```

## Retry-on-overload

Wrap each call in retry with jitter:

```ts
async function callWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const isOverload =
        err instanceof Anthropic.APIError && (err.status === 529 || err.status === 503);
      if (!isOverload || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i + Math.random() * 200));
    }
  }
  throw new Error("unreachable");
}
```

## Cost reporting

Log `response.usage.cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens`, `output_tokens`. Aim for `cache_read >> input` after warmup.
