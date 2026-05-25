/**
 * Tests for the JSON / TOML MCP-config IO helpers shared by
 * `almanac register` and `almanac remove`.
 *
 * Round-trip: parse → modify → serialize → parse should recover the
 * modified shape. Each format is exercised end-to-end against the
 * atomic-write helper.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseMcpConfig,
  serializeMcpConfig,
  writeMcpConfigAtomic,
} from "./mcp-config.ts";

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "almanac-mcpcfg-"));
  cleanup.push(d);
  return d;
}

// ──────────────────────────────────────────────────────────────────────────────
// parseMcpConfig
// ──────────────────────────────────────────────────────────────────────────────

describe("parseMcpConfig — JSON", () => {
  test("parses an existing claude-style config", () => {
    const raw = JSON.stringify({
      mcpServers: {
        "almanac-cooking": {
          command: "bun",
          args: ["run", "/cli.ts", "serve", "cooking"],
        },
      },
    });
    const parsed = parseMcpConfig(raw, "json");
    expect(parsed.mcpServers).toBeDefined();
  });

  test("throws on malformed JSON", () => {
    expect(() => parseMcpConfig("not json", "json")).toThrow();
  });

  test("throws when top-level is an array", () => {
    expect(() => parseMcpConfig("[]", "json")).toThrow(/expected a top-level object/);
  });

  test("throws when top-level is a scalar", () => {
    expect(() => parseMcpConfig("42", "json")).toThrow(/expected a top-level object/);
  });
});

describe("parseMcpConfig — TOML", () => {
  test("parses a codex-style config with nested table", () => {
    const raw = `
[mcp_servers.almanac-sqlite]
command = "bun"
args = ["run", "/cli.ts", "serve", "sqlite"]
`;
    const parsed = parseMcpConfig(raw, "toml");
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(servers).toBeDefined();
    const sqlite = servers["almanac-sqlite"] as Record<string, unknown>;
    expect(sqlite.command).toBe("bun");
    expect(Array.isArray(sqlite.args)).toBe(true);
  });

  test("throws on malformed TOML", () => {
    expect(() => parseMcpConfig("not = a = valid = toml", "toml")).toThrow();
  });

  test("hyphens in keys are accepted (TOML bare-key spec)", () => {
    const raw = `
[mcp_servers."almanac-with-hyphens"]
command = "x"
`;
    const parsed = parseMcpConfig(raw, "toml");
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(servers["almanac-with-hyphens"]).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// serializeMcpConfig
// ──────────────────────────────────────────────────────────────────────────────

describe("serializeMcpConfig", () => {
  test("JSON: pretty-printed + trailing newline", () => {
    const out = serializeMcpConfig({ a: 1, b: { c: 2 } }, "json");
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("  ");
    const back = JSON.parse(out);
    expect(back).toEqual({ a: 1, b: { c: 2 } });
  });

  test("TOML: tables emitted; trailing newline", () => {
    const out = serializeMcpConfig(
      { mcp_servers: { foo: { command: "bun", args: ["x"] } } },
      "toml",
    );
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("[mcp_servers.foo]");
    expect(out).toContain('command = "bun"');
  });

  test("round-trip preserves shape across both formats", () => {
    const config = {
      mcpServers: {
        "alma-1": {
          command: "bun",
          args: ["run", "/cli.ts", "serve", "alma-1"],
        },
      },
    };
    const json = serializeMcpConfig(config, "json");
    expect(parseMcpConfig(json, "json")).toEqual(config);

    const tomlConfig = {
      mcp_servers: {
        "alma-1": {
          command: "bun",
          args: ["run", "/cli.ts", "serve", "alma-1"],
        },
      },
    };
    const toml = serializeMcpConfig(tomlConfig, "toml");
    expect(parseMcpConfig(toml, "toml")).toEqual(tomlConfig);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// writeMcpConfigAtomic
// ──────────────────────────────────────────────────────────────────────────────

describe("writeMcpConfigAtomic", () => {
  test("creates the file and removes the temp on success (JSON)", async () => {
    const dir = mkTmp();
    const path = join(dir, ".claude.json");
    await writeMcpConfigAtomic({
      path,
      config: { mcpServers: { "alma-x": { command: "bun", args: [] } } },
      format: "json",
    });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.almanac-tmp`)).toBe(false);
    const back = JSON.parse(readFileSync(path, "utf8"));
    expect(back.mcpServers["alma-x"].command).toBe("bun");
  });

  test("creates the file (TOML, codex-shaped)", async () => {
    const dir = mkTmp();
    const path = join(dir, "config.toml");
    await writeMcpConfigAtomic({
      path,
      config: {
        mcp_servers: {
          "almanac-sqlite": { command: "bun", args: ["run", "/cli.ts"] },
        },
      },
      format: "toml",
    });
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("[mcp_servers.almanac-sqlite]");
    expect(body).toContain('command = "bun"');
  });

  test("overwrites an existing file (atomic via rename)", async () => {
    const dir = mkTmp();
    const path = join(dir, "existing.json");
    writeFileSync(path, `{"mcpServers":{"old":{"command":"old"}}}`);
    await writeMcpConfigAtomic({
      path,
      config: { mcpServers: { fresh: { command: "fresh" } } },
      format: "json",
    });
    const back = JSON.parse(readFileSync(path, "utf8"));
    expect(back.mcpServers.fresh).toBeDefined();
    expect(back.mcpServers.old).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: register-style read-modify-write
// ──────────────────────────────────────────────────────────────────────────────

describe("read-modify-write flow (mirrors registerMcp)", () => {
  test("JSON: add a new entry to an existing config without disturbing others", async () => {
    const dir = mkTmp();
    const path = join(dir, ".claude.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          "alma-other": { command: "bun", args: ["run", "/x", "serve", "other"] },
        },
        unrelated: "preserved",
      }),
    );
    const config = parseMcpConfig(readFileSync(path, "utf8"), "json");
    const servers = config.mcpServers as Record<string, unknown>;
    servers["alma-new"] = { command: "bun", args: ["run", "/x", "serve", "new"] };
    await writeMcpConfigAtomic({ path, config, format: "json" });

    const back = parseMcpConfig(readFileSync(path, "utf8"), "json");
    const finalServers = back.mcpServers as Record<string, unknown>;
    expect(Object.keys(finalServers).sort()).toEqual(["alma-new", "alma-other"]);
    // unrelated keys at top level are preserved.
    expect(back.unrelated).toBe("preserved");
  });

  test("TOML: add a new [mcp_servers.X] table to an existing config", async () => {
    const dir = mkTmp();
    const path = join(dir, "config.toml");
    writeFileSync(
      path,
      `[mcp_servers.existing]
command = "bun"
args = ["run", "/x", "serve", "existing"]
`,
    );
    const config = parseMcpConfig(readFileSync(path, "utf8"), "toml");
    const servers = config.mcp_servers as Record<string, unknown>;
    servers["almanac-new"] = {
      command: "bun",
      args: ["run", "/x", "serve", "new"],
    };
    await writeMcpConfigAtomic({ path, config, format: "toml" });

    const back = parseMcpConfig(readFileSync(path, "utf8"), "toml");
    const finalServers = back.mcp_servers as Record<string, unknown>;
    expect(Object.keys(finalServers).sort()).toEqual(["almanac-new", "existing"]);
  });
});
