/**
 * MCP-config file IO across JSON and TOML.
 *
 * `register` and `remove` write to per-client MCP config files:
 *
 *   claude-code     → ~/.claude.json                       JSON
 *   claude-desktop  → ~/Library/.../claude_desktop_config.json   JSON
 *   cursor          → ~/.cursor/mcp.json                   JSON
 *   codex           → ~/.codex/config.toml                 TOML
 *
 * The cli's `cmdRegister` and `cmdRemove` read-modify-write these files;
 * this module provides the format-agnostic parse / serialize / atomic-write
 * primitives so the CLI flow stays a flat top-level orchestration.
 */

import { writeFile } from "node:fs/promises";

import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";

export type McpConfigFormat = "json" | "toml";

/**
 * Parse a raw MCP config string into a JS object. Throws (not returns) on
 * malformed input so the caller can surface a clear "config at <path> is
 * not valid <format>" message.
 */
export function parseMcpConfig(
  raw: string,
  format: McpConfigFormat,
): Record<string, unknown> {
  let parsed: unknown;
  if (format === "json") {
    parsed = JSON.parse(raw);
  } else {
    parsed = tomlParse(raw);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `expected a top-level ${format === "json" ? "object" : "table"} (got ${
        Array.isArray(parsed) ? "array" : typeof parsed
      })`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Serialize a JS object back to the on-disk format. Always trailing-newline.
 */
export function serializeMcpConfig(
  config: Record<string, unknown>,
  format: McpConfigFormat,
): string {
  if (format === "json") {
    return JSON.stringify(config, null, 2) + "\n";
  }
  return tomlStringify(config) + "\n";
}

/**
 * Write-via-rename: serialize the config, write to a sibling temp, rename
 * over the target. `rename` is atomic on the same filesystem (POSIX
 * guarantee), so concurrent readers see either the old or the new file —
 * never a half-written one. Both paths share the filesystem here because
 * the temp lives next to the target.
 */
export async function writeMcpConfigAtomic(args: {
  path: string;
  config: Record<string, unknown>;
  format: McpConfigFormat;
}): Promise<void> {
  const tmp = `${args.path}.almanac-tmp`;
  await writeFile(tmp, serializeMcpConfig(args.config, args.format), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, args.path);
}
