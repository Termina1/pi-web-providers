import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { type TObject, Type } from "typebox";
import { resolveConfigValue, resolveEnvMap } from "../config-values.js";
import type {
  Grok,
  GrokOptions,
  ProviderCapabilityStatus,
  ProviderContext,
  SearchResponse,
  Tool,
} from "../types.js";
import { defineCapability, defineProvider } from "./definition.js";
import { trimSnippet } from "./shared.js";

const DEFAULT_SEARCH_MODE = "web";
const DEFAULT_MODEL = "grok-build";
const DEFAULT_REASONING_EFFORT = "low";

interface GrokSearchOutput {
  sources: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
}

interface GrokCliJsonOutput {
  text?: string;
  structuredOutput?: unknown;
  structuredOutputError?: string | null;
  stopReason?: string;
  type?: string;
  message?: string;
}

const grokSearchOptionsSchema = Type.Object(
  {
    model: Type.Optional(
      Type.String({
        description: "Grok model override (for example 'grok-build').",
      }),
    ),
    effort: Type.Optional(
      Type.Union(
        [
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
          Type.Literal("max"),
        ],
        { description: "Reasoning effort for Grok Build." },
      ),
    ),
    maxTurns: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum number of Grok agent turns.",
      }),
    ),
    searchMode: Type.Optional(
      Type.Union(
        [Type.Literal("web"), Type.Literal("x"), Type.Literal("both")],
        {
          description:
            "Which Grok search surface to prefer: public web, X/Twitter, or both.",
        },
      ),
    ),
  },
  { description: "Grok CLI search options." },
);

const grokImplementation = {
  id: "grok" as const,
  label: "Grok",
  docsUrl: "https://docs.x.ai/build/overview",

  getToolOptionsSchema(capability: Tool): TObject | undefined {
    switch (capability) {
      case "search":
        return grokSearchOptionsSchema;
      default:
        return undefined;
    }
  },

  createTemplate(): Grok {
    return {
      options: {
        model: DEFAULT_MODEL,
        effort: DEFAULT_REASONING_EFFORT,
        searchMode: DEFAULT_SEARCH_MODE,
      },
    };
  },

  getCapabilityStatus(
    config: Grok | undefined,
    _cwd: string,
  ): ProviderCapabilityStatus {
    const executable = config?.grokPath ?? "grok";
    if (config?.grokPath && !existsSync(config.grokPath)) {
      return { state: "missing_executable" };
    }

    const result = spawnSync(executable, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: "missing_executable" };
      }
      return { state: "invalid_config", detail: result.error.message };
    }

    return { state: "ready" };
  },

  async search(
    query: string,
    maxResults: number,
    config: Grok,
    context: ProviderContext,
    options?: Record<string, unknown>,
  ): Promise<SearchResponse> {
    const output = parseGrokSearchOutput(
      await runGrokJsonQuery({
        prompt: buildSearchPrompt(query, maxResults, config, options),
        config,
        context,
        options,
      }),
    );

    return {
      provider: this.id,
      results: output.sources.slice(0, maxResults).map((source) => ({
        title: source.title.trim(),
        url: source.url.trim(),
        snippet: trimSnippet(source.snippet),
      })),
    };
  },
};

async function runGrokJsonQuery({
  prompt,
  config,
  context,
  options,
}: {
  prompt: string;
  config: Grok;
  context: ProviderContext;
  options: Record<string, unknown> | undefined;
}): Promise<unknown> {
  const runtimeOptions = resolveGrokOptions(config, options);
  const executable = config.grokPath ?? "grok";
  const args = [
    "--no-auto-update",
    "--no-memory",
    "--no-subagents",
    "--verbatim",
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--cwd",
    context.cwd,
  ];

  if (runtimeOptions.model) {
    args.push("-m", runtimeOptions.model);
  }
  if (runtimeOptions.effort) {
    args.push("--reasoning-effort", runtimeOptions.effort);
  }
  if (runtimeOptions.maxTurns) {
    args.push("--max-turns", String(runtimeOptions.maxTurns));
  }

  const stdout = await runCommand(executable, args, config, context);
  const result = parseCliJson(stdout);

  if (result.type === "error") {
    throw new Error(result.message ?? "Grok returned an error");
  }

  if (
    result.structuredOutput !== undefined &&
    result.structuredOutput !== null
  ) {
    return result.structuredOutput;
  }

  if (typeof result.text === "string" && result.text.trim().length > 0) {
    return extractJsonObject(result.text);
  }

  if (result.structuredOutputError) {
    throw new Error(
      `structured output failed and Grok returned no text: ${result.structuredOutputError}`,
    );
  }

  throw new Error("returned an empty response");
}

function runCommand(
  executable: string,
  args: string[],
  config: Grok,
  context: ProviderContext,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const resolvedEnv = resolveEnvMap(config.env);
    const apiKey = resolveConfigValue(config.credentials?.api);
    const child = spawn(executable, args, {
      cwd: context.cwd,
      env: {
        ...process.env,
        ...resolvedEnv,
        ...(apiKey ? { XAI_API_KEY: apiKey } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      context.signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      fail(new Error("aborted"));
    };

    if (context.signal?.aborted) {
      onAbort();
      return;
    }

    context.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          stripAnsi(stderr).trim() ||
            `Grok exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        ),
      );
    });
  });
}

function buildSearchPrompt(
  query: string,
  maxResults: number,
  config: Grok,
  options: Record<string, unknown> | undefined,
): string {
  const searchMode = resolveGrokOptions(config, options).searchMode;
  const searchInstruction =
    searchMode === "x"
      ? "Use Grok's X Search tool to search public X/Twitter posts, profiles, and threads."
      : searchMode === "both"
        ? "Use Grok's public web search and X Search tools as needed."
        : "Use Grok's public web search and browsing tools.";

  return [
    "You are performing search for another coding agent.",
    searchInstruction,
    "Do not inspect local files or the current repository; use only public search sources.",
    'Return only a JSON object matching this schema: {"sources":[{"title":"string","url":"string","snippet":"string"}]}',
    "Do not include markdown fences, prose, or extra commentary.",
    `Return at most ${maxResults} sources.`,
    "Prefer official, primary, or highly reputable sources when available.",
    "Each snippet should be short, factual, and specific to the source.",
    "For X results, use canonical X post/profile/thread URLs as source URLs.",
    "",
    `User query: ${query}`,
  ].join("\n");
}

function resolveGrokOptions(
  config: Grok,
  options: Record<string, unknown> | undefined,
): GrokOptions {
  const merged = {
    ...(config.options ?? {}),
    ...(options ?? {}),
  };

  const model = readNonEmptyString(merged.model) ?? DEFAULT_MODEL;
  const effort =
    readEnum(merged.effort, ["low", "medium", "high", "xhigh", "max"]) ??
    DEFAULT_REASONING_EFFORT;
  const searchMode =
    readEnum(merged.searchMode, ["web", "x", "both"]) ?? DEFAULT_SEARCH_MODE;
  const maxTurns = readPositiveInteger(merged.maxTurns);

  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    searchMode,
  };
}

function parseCliJson(stdout: string): GrokCliJsonOutput {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("returned an empty response");
  }

  try {
    return JSON.parse(trimmed) as GrokCliJsonOutput;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (!match) {
      throw new Error("returned invalid JSON output");
    }
    return JSON.parse(match[0]) as GrokCliJsonOutput;
  }
}

function parseGrokSearchOutput(value: unknown): GrokSearchOutput {
  const sources = readArray(value, "sources").map((entry) => ({
    title: readString(entry, "title"),
    url: readString(entry, "url"),
    snippet: readString(entry, "snippet"),
  }));
  return { sources };
}

function readArray(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`output is missing '${key}'`);
  }
  const entry = (value as Record<string, unknown>)[key];
  if (!Array.isArray(entry)) {
    throw new Error(`output field '${key}' must be an array`);
  }
  return entry;
}

function readString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`output is missing '${key}'`);
  }
  const entry = (value as Record<string, unknown>)[key];
  if (typeof entry !== "string") {
    throw new Error(`output field '${key}' must be a string`);
  }
  return entry;
}

function extractJsonObject(raw: string): unknown {
  if (!raw.trim()) {
    throw new Error("returned an empty response");
  }

  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("returned invalid JSON output");
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      throw new Error("returned invalid JSON output");
    }
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readEnum<const TValue extends string>(
  value: unknown,
  values: readonly TValue[],
): TValue | undefined {
  return typeof value === "string" && values.includes(value as TValue)
    ? (value as TValue)
    : undefined;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export const grokProvider = defineProvider({
  id: "grok" as const,
  label: grokImplementation.label,
  docsUrl: grokImplementation.docsUrl,
  config: {
    createTemplate: () => grokImplementation.createTemplate(),
    fields: ["grokPath", "credentials", "env", "options", "settings"],
  },
  getCapabilityStatus: (config, cwd, tool) =>
    (grokImplementation.getCapabilityStatus as any)(
      config as Grok | undefined,
      cwd,
      tool,
    ),
  capabilities: {
    search: defineCapability({
      options: grokImplementation.getToolOptionsSchema?.("search"),
      async execute(input: any, ctx) {
        const { query, maxResults, options } = input;
        return await grokImplementation.search!(
          query,
          maxResults,
          ctx.config as never,
          ctx,
          options,
        );
      },
    }),
  },
});
