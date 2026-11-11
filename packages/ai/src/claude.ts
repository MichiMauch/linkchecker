import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared Anthropic Claude client for the small classification/ranking calls.
 *
 * Degrades gracefully: if ANTHROPIC_API_KEY is unset, getClient() returns null
 * and callers fall back to deterministic logic. The model is configurable via
 * ANTHROPIC_MODEL (default claude-haiku-5-5) so the id can be swapped without a
 * code change.
 */

const DEFAULT_MODEL = "claude-haiku-5-5";

let client: Anthropic | null | undefined;

export function getClient(): Anthropic | null {
  if (client === undefined) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    client = apiKey ? new Anthropic({ apiKey }) : null;
  }
  return client;
}

export function getModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

export interface JsonToolSpec {
  name: string;
  description: string;
  /** JSON schema of the object the model must return. */
  schema: Record<string, unknown>;
}

/**
 * Asks Claude for a structured answer via a forced tool call and returns the
 * tool input. Falls back to the first JSON object in a text reply. Returns null
 * on any API or parse error so callers can fall back.
 */
export async function askJson<T>(
  c: Anthropic,
  opts: { system?: string; prompt: string; tool: JsonToolSpec; maxTokens?: number },
): Promise<T | null> {
  try {
    const res = await c.messages.create({
      model: getModel(),
      max_tokens: opts.maxTokens ?? 300,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: opts.prompt }],
      tools: [
        {
          name: opts.tool.name,
          description: opts.tool.description,
          input_schema: { type: "object", ...opts.tool.schema },
        },
      ],
      tool_choice: { type: "tool", name: opts.tool.name },
    });

    for (const block of res.content) {
      if (block.type === "tool_use" && block.name === opts.tool.name && block.input && typeof block.input === "object") {
        return block.input as T;
      }
    }
    for (const block of res.content) {
      if (block.type === "text") {
        const match = block.text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]) as T;
      }
    }
    return null;
  } catch {
    return null;
  }
}
