import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
  };
});

import { grokProvider } from "../src/providers/grok.js";
import { providerHarness } from "./provider-harness.js";

afterEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
});

describe("Grok provider", () => {
  it("reports Grok as unavailable when an explicit executable path is missing", () => {
    const provider = providerHarness(grokProvider);

    expect(
      provider.getCapabilityStatus(
        {
          grokPath: "/definitely/missing/grok",
        },
        process.cwd(),
      ),
    ).toEqual({
      state: "missing_executable",
    });
  });

  it("reports Grok as available without preflighting auth", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "grok 0.2.67" });
    const provider = providerHarness(grokProvider);

    expect(provider.getCapabilityStatus({}, process.cwd())).toEqual({
      state: "ready",
    });
    expect(spawnSyncMock).toHaveBeenCalledWith("grok", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("runs Grok CLI headlessly with JSON text output and sanitized options", async () => {
    mockSpawnResult({
      text: JSON.stringify({
        sources: [
          {
            title: "Grok docs",
            url: "https://docs.x.ai/build/overview",
            snippet: "Official Grok Build docs",
          },
        ],
      }),
    });

    const provider = providerHarness(grokProvider);
    const response = await provider.search(
      "latest Grok Build docs",
      2,
      {
        credentials: { api: "literal-xai-key" },
        env: { GROK_SANDBOX: "readonly" },
        options: {
          model: "grok-build",
          effort: "low",
          maxTurns: 2,
          searchMode: "web",
        },
      },
      {
        cwd: "/repo",
      },
      {
        model: "grok-4.3",
        effort: "high",
        maxTurns: 4,
        searchMode: "x",
        cwd: "/tmp/override",
        permissionMode: "bypassPermissions",
      },
    );

    const [executable, args, options] = spawnMock.mock.calls[0];
    expect(executable).toBe("grok");
    expect(args).toEqual(
      expect.arrayContaining([
        "--no-auto-update",
        "--no-memory",
        "--no-subagents",
        "--verbatim",
        "-p",
        expect.stringContaining("Use Grok's X Search tool"),
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--cwd",
        "/repo",
        "-m",
        "grok-4.3",
        "--reasoning-effort",
        "high",
        "--max-turns",
        "4",
      ]),
    );
    expect(args).not.toContain("/tmp/override");
    expect(args).not.toContain("bypassPermissions");
    expect(args).not.toContain("--json-schema");
    expect(options).toMatchObject({
      cwd: "/repo",
      stdio: ["ignore", "pipe", "pipe"],
      env: expect.objectContaining({
        GROK_SANDBOX: "readonly",
        XAI_API_KEY: "literal-xai-key",
      }),
    });
    expect(response.results).toEqual([
      {
        title: "Grok docs",
        url: "https://docs.x.ai/build/overview",
        snippet: "Official Grok Build docs",
      },
    ]);
  });
});

function mockSpawnResult(payload: unknown) {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(payload)));
      child.emit("close", 0, null);
    });

    return child;
  });
}
