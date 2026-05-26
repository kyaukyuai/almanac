import { describe, expect, test } from "bun:test";

import {
  detectHardcodedFallbackUrls,
  validateGeneratedTool,
} from "./static-validator.ts";

describe("detectHardcodedFallbackUrls", () => {
  test("empirical case: lookup_std_item Vec-fallback array is flagged", () => {
    // Verbatim shape of the offending impl from
    // /tmp/almanac-rust-v032-smoke/rust/tools/lookup_std_item.ts.
    const code = `
const attempts = [
  \`https://doc.rust-lang.org/std/\${itemPath}\`,
  \`https://doc.rust-lang.org/std/vec/struct.Vec.html\`,
  \`https://doc.rust-lang.org/std/iter/trait.Iterator.html\`,
  \`https://doc.rust-lang.org/std/sync/struct.Arc.html\`,
  \`https://doc.rust-lang.org/std/macro.println.html\`
];
`;
    const r = detectHardcodedFallbackUrls(code);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The first array entry has a template interpolation and is skipped;
      // the remaining four are pure literals that get flagged.
      expect(r.diagnostics).toContain("4 URLs");
      expect(r.diagnostics).toContain("struct.Vec.html");
      expect(r.diagnostics).toContain("Build the URL from input");
    }
  });

  test("two adjacent hardcoded URLs are enough to flag", () => {
    const code = `const list = ["https://a.example/x", "https://b.example/y"];`;
    const r = detectHardcodedFallbackUrls(code);
    expect(r.ok).toBe(false);
  });

  test("single hardcoded URL is not flagged", () => {
    const code = `const versionUrl = "https://raw.githubusercontent.com/x/y/master/src/version";`;
    const r = detectHardcodedFallbackUrls(code);
    expect(r.ok).toBe(true);
  });

  test("template-interpolated URLs are not flagged", () => {
    const code = `
const a = \`https://example.com/\${input.id}/page\`;
const b = \`https://example.com/\${input.id}/about\`;
fetch(a); fetch(b);
`;
    const r = detectHardcodedFallbackUrls(code);
    expect(r.ok).toBe(true);
  });

  test("mixed: one template + one hardcoded → not flagged (the hardcoded one is alone)", () => {
    // The pair-detection rule requires two *adjacent* hardcoded URLs.
    // The template URL is skipped, leaving only one hardcoded URL with no
    // adjacent hardcoded sibling. Acceptable false-negative for v1.
    const code = `
const candidates = [
  \`https://example.com/\${slug}\`,
  "https://example.com/fallback",
];
`;
    const r = detectHardcodedFallbackUrls(code);
    expect(r.ok).toBe(true);
  });

  test("URLs spread across the file with intervening code are not flagged", () => {
    // Two hardcoded URLs separated by statements: not a fallback list.
    const code = `
const docs = "https://example.com/docs";
function foo() { return 1; }
const api = "https://example.com/api";
`;
    const r = detectHardcodedFallbackUrls(code);
    expect(r.ok).toBe(true);
  });

  test("function call passing two hardcoded URL args triggers (acceptable false positive)", () => {
    // Documented behavior: f(url1, url2) is rare in generated tool code and
    // cheap to retry. We accept this trade-off.
    const code = `linkPair("https://a.example", "https://b.example");`;
    const r = detectHardcodedFallbackUrls(code);
    expect(r.ok).toBe(false);
  });

  test("strings that look like URLs but are not http(s) are ignored", () => {
    const code = `
const a = "file:///tmp/x";
const b = "file:///tmp/y";
`;
    const r = detectHardcodedFallbackUrls(code);
    expect(r.ok).toBe(true);
  });

  test("empty source is ok", () => {
    expect(detectHardcodedFallbackUrls("").ok).toBe(true);
  });
});

describe("validateGeneratedTool", () => {
  test("delegates to detectHardcodedFallbackUrls on impl code (not test code)", () => {
    const cleanImpl = `const u = \`https://x.com/\${id}\`; fetch(u);`;
    const dirtyTest = `["https://a.example", "https://b.example"]`;
    // Validator only looks at impl, so a fallback-array in *test* code passes.
    expect(
      validateGeneratedTool({ code: cleanImpl, testCode: dirtyTest }).ok,
    ).toBe(true);

    const dirtyImpl = `const a = ["https://a.example", "https://b.example"];`;
    const r = validateGeneratedTool({ code: dirtyImpl, testCode: "" });
    expect(r.ok).toBe(false);
  });
});
