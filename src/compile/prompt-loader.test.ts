/**
 * Tests for the prompt-template loader.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadPromptTemplate,
  PromptPlaceholderMissingError,
  PromptSectionMissingError,
  PromptTemplateNotFoundError,
  splitSections,
  stripFrontmatter,
  substitute,
} from "./prompt-loader.ts";

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

function tmpPromptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "almanac-prompt-loader-"));
  cleanup.push(dir);
  return dir;
}

function writePrompt(
  promptsDir: string,
  stageId: string,
  version: string,
  body: string,
): void {
  const dir = join(promptsDir, stageId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${version}.md`), body, "utf8");
}

const SAMPLE = `---
stage: 99-test
version: v1
---

## System

You are an assistant for {{ thing }}.

## User

Please process: {{thing}} (depth={{depth}}).
`;

describe("stripFrontmatter", () => {
  test("removes a leading --- … --- block", () => {
    const out = stripFrontmatter(SAMPLE);
    expect(out.startsWith("\n## System")).toBe(true);
  });

  test("returns input unchanged when no frontmatter", () => {
    expect(stripFrontmatter("hello\nworld")).toBe("hello\nworld");
  });
});

describe("splitSections", () => {
  test("splits System and User by ## headings", () => {
    const body = stripFrontmatter(SAMPLE);
    const { system, user } = splitSections(body, "/path/to/test.md");
    expect(system).toBe("You are an assistant for {{ thing }}.");
    expect(user).toBe("Please process: {{thing}} (depth={{depth}}).");
  });

  test("throws when System missing", () => {
    expect(() =>
      splitSections("## User\nfoo", "/x.md"),
    ).toThrow(PromptSectionMissingError);
  });

  test("throws when User missing", () => {
    expect(() =>
      splitSections("## System\nfoo", "/x.md"),
    ).toThrow(PromptSectionMissingError);
  });

  test("throws when User precedes System", () => {
    expect(() =>
      splitSections("## User\nfoo\n## System\nbar", "/x.md"),
    ).toThrow(PromptSectionMissingError);
  });
});

describe("substitute", () => {
  test("replaces {{name}} and tolerates whitespace", () => {
    expect(
      substitute("a={{ a }} b={{b}} c={{   c   }}", { a: "1", b: "2", c: "3" }, "/p"),
    ).toBe("a=1 b=2 c=3");
  });

  test("throws when a placeholder has no value", () => {
    expect(() => substitute("{{missing}}", {}, "/p")).toThrow(
      PromptPlaceholderMissingError,
    );
  });

  test("ignores unused vars", () => {
    expect(substitute("hi", { unused: "x" }, "/p")).toBe("hi");
  });
});

describe("loadPromptTemplate", () => {
  test("loads, strips frontmatter, splits sections, and substitutes", () => {
    const promptsDir = tmpPromptsDir();
    writePrompt(promptsDir, "99-test", "v1", SAMPLE);
    const out = loadPromptTemplate({
      stageId: "99-test",
      version: "v1",
      promptsDir,
      vars: { thing: "kubernetes", depth: "standard" },
    });
    expect(out.system).toBe("You are an assistant for kubernetes.");
    expect(out.user).toBe("Please process: kubernetes (depth=standard).");
    expect(out.version).toBe("v1");
    expect(out.stageId).toBe("99-test");
  });

  test("throws PromptTemplateNotFoundError for a missing file", () => {
    const promptsDir = tmpPromptsDir();
    expect(() =>
      loadPromptTemplate({ stageId: "missing", version: "v1", promptsDir }),
    ).toThrow(PromptTemplateNotFoundError);
  });

  test("loads the real Stage 1 v1 prompt with the expected placeholders", () => {
    // Sanity check: the bundled v1.md must accept {{domain}}, {{depth}},
    // {{sourcesHint}}, {{scopeHint}} or Stage 1 will explode at runtime.
    const out = loadPromptTemplate({
      stageId: "01-domain-analysis",
      version: "v1",
      vars: {
        domain: "kubernetes",
        depth: "standard",
        sourcesHint: "[]",
        scopeHint: "(none provided)",
      },
    });
    expect(out.system.length).toBeGreaterThan(100);
    expect(out.user).toContain("domain: kubernetes");
    expect(out.user).toContain("depth: standard");
    expect(out.user).toContain("sourcesHint: []");
    expect(out.user).toContain("scopeHint: (none provided)");
  });
});
