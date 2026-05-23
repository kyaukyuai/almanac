/**
 * Tiny prompt-template loader for the compile pipeline.
 *
 * Templates live at:
 *
 *   src/compile/prompts/<stageId>/<version>.md
 *
 * Each file is a markdown document with a YAML frontmatter block bounded by
 * `---` lines, followed by `## System` and `## User` sections that hold the
 * two messages to send to the LLM. The body may contain `{{ key }}`
 * placeholders that are substituted from the caller-supplied `vars` map.
 *
 * This module is intentionally minimal:
 *   - Frontmatter is split off but NOT parsed (callers that need fields like
 *     `recommendedModel` should configure their runner directly).
 *   - Only `## System` and `## User` are recognized as section markers.
 *   - Placeholders use `{{name}}` (whitespace permitted around `name`).
 *
 * No external YAML or markdown deps; pure regex + string ops.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPTS_DIR = join(HERE, "prompts");

/** Resolved messages plus the version label echoed from the path. */
export interface LoadedPrompt {
  /** Body of the `## System` section, with placeholders substituted. */
  system: string;
  /** Body of the `## User` section, with placeholders substituted. */
  user: string;
  /** Echo of the supplied `version` argument. */
  version: string;
  /** Echo of the supplied `stageId` argument. */
  stageId: string;
  /** Absolute path to the loaded template file (for diagnostics). */
  path: string;
}

export class PromptTemplateNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`prompt template not found: ${path}`);
    this.name = "PromptTemplateNotFoundError";
  }
}

export class PromptPlaceholderMissingError extends Error {
  constructor(
    public readonly placeholder: string,
    public readonly path: string,
  ) {
    super(
      `prompt template ${path} references {{${placeholder}}} but no value was provided`,
    );
    this.name = "PromptPlaceholderMissingError";
  }
}

export class PromptSectionMissingError extends Error {
  constructor(
    public readonly section: "System" | "User",
    public readonly path: string,
  ) {
    super(`prompt template ${path} is missing required \`## ${section}\` section`);
    this.name = "PromptSectionMissingError";
  }
}

export interface LoadPromptInput {
  stageId: string;
  version: string;
  /** Map of placeholder name → string. Missing placeholders throw. */
  vars?: Record<string, string>;
  /** Override the prompts root (tests). Defaults to `<this-file>/prompts`. */
  promptsDir?: string;
}

/**
 * Load `<promptsDir>/<stageId>/<version>.md`, strip the YAML frontmatter,
 * split into System/User sections, and substitute `{{placeholder}}` tokens.
 *
 * Throws when the file is missing, either section is missing, or a
 * placeholder appears in the template without a corresponding `vars` entry.
 */
export function loadPromptTemplate(input: LoadPromptInput): LoadedPrompt {
  const promptsDir = input.promptsDir ?? DEFAULT_PROMPTS_DIR;
  const path = join(promptsDir, input.stageId, `${input.version}.md`);
  if (!existsSync(path)) {
    throw new PromptTemplateNotFoundError(path);
  }
  const raw = readFileSync(path, "utf8");
  const body = stripFrontmatter(raw);
  const { system, user } = splitSections(body, path);
  const vars = input.vars ?? {};
  return {
    system: substitute(system, vars, path),
    user: substitute(user, vars, path),
    version: input.version,
    stageId: input.stageId,
    path,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers (exported for tests)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Strip a leading `---\n…\n---\n` YAML frontmatter block, if present.
 * Returns the input unchanged when no frontmatter is found.
 */
export function stripFrontmatter(text: string): string {
  // Tolerate optional BOM and leading whitespace before the opening `---`.
  const m = text.match(/^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

/**
 * Split a prompt body into `## System` and `## User` sections. Headings must
 * appear at the start of a line. Content before the first heading is
 * discarded.
 */
export function splitSections(
  body: string,
  path: string,
): { system: string; user: string } {
  const sysMatch = body.match(/^##\s+System\s*$/m);
  const userMatch = body.match(/^##\s+User\s*$/m);
  if (!sysMatch || sysMatch.index === undefined) {
    throw new PromptSectionMissingError("System", path);
  }
  if (!userMatch || userMatch.index === undefined) {
    throw new PromptSectionMissingError("User", path);
  }
  if (userMatch.index < sysMatch.index) {
    // Re-use the same error type; surface the structural issue in the message.
    throw new PromptSectionMissingError("User", path);
  }
  const sysStart = sysMatch.index + sysMatch[0].length;
  const sysEnd = userMatch.index;
  const userStart = userMatch.index + userMatch[0].length;
  return {
    system: body.slice(sysStart, sysEnd).trim(),
    user: body.slice(userStart).trim(),
  };
}

/**
 * Replace every `{{name}}` (whitespace permitted around `name`) in `text`
 * with `vars[name]`. Throws `PromptPlaceholderMissingError` for any
 * placeholder that has no entry in `vars`.
 */
export function substitute(
  text: string,
  vars: Record<string, string>,
  path: string,
): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new PromptPlaceholderMissingError(name, path);
    }
    return vars[name]!;
  });
}
