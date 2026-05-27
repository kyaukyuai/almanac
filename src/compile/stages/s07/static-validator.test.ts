import { describe, expect, test } from "bun:test";

import {
  detectHardcodedFallbackUrls,
  detectUnallowedHostInImpl,
  requireSampleUrlInTestCode,
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

describe("requireSampleUrlInTestCode", () => {
  test("empty sampleUrls always passes (legacy / knowledge-only tools)", () => {
    const r = requireSampleUrlInTestCode({
      testCode: "no urls here",
      sampleUrls: [],
    });
    expect(r.ok).toBe(true);
  });

  test("test code referencing a sampleUrl as exact match passes", () => {
    const sampleUrls = [
      "https://doc.rust-lang.org/std/iter/trait.Iterator.html",
      "https://doc.rust-lang.org/std/sync/struct.Arc.html",
    ];
    const testCode = `
      if (url === "https://doc.rust-lang.org/std/iter/trait.Iterator.html") {
        return new Response(html, { status: 200 });
      }
    `;
    expect(requireSampleUrlInTestCode({ testCode, sampleUrls }).ok).toBe(true);
  });

  test("test code with no sampleUrl reference is flagged", () => {
    const sampleUrls = [
      "https://doc.rust-lang.org/std/iter/trait.Iterator.html",
      "https://doc.rust-lang.org/std/sync/struct.Arc.html",
    ];
    // The mock returns 200 for a URL the LLM confabulated.
    const testCode = `
      if (url.includes("/std/sync/Arc/")) {
        return new Response(html, { status: 200 });
      }
    `;
    const r = requireSampleUrlInTestCode({ testCode, sampleUrls });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics).toContain("sampleUrls");
      expect(r.diagnostics).toContain("Iterator.html");
    }
  });

  test("a single sampleUrl substring is sufficient (one mock anchor is enough)", () => {
    const sampleUrls = [
      "https://doc.rust-lang.org/std/iter/trait.Iterator.html",
      "https://doc.rust-lang.org/std/sync/struct.Arc.html",
      "https://doc.rust-lang.org/std/vec/struct.Vec.html",
    ];
    const testCode = `mock["https://doc.rust-lang.org/std/vec/struct.Vec.html"] = okHtml;`;
    expect(requireSampleUrlInTestCode({ testCode, sampleUrls }).ok).toBe(true);
  });

  test("diagnostics truncate gracefully when many sampleUrls", () => {
    const sampleUrls = [
      "https://a.example/1",
      "https://a.example/2",
      "https://a.example/3",
      "https://a.example/4",
      "https://a.example/5",
    ];
    const r = requireSampleUrlInTestCode({ testCode: "", sampleUrls });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics).toContain("https://a.example/1");
      expect(r.diagnostics).toContain("+2 more");
    }
  });
});

describe("detectUnallowedHostInImpl", () => {
  test("empty allowedHosts skips the check (no network capability)", () => {
    const code = `fetch("https://anywhere.example/x")`;
    expect(detectUnallowedHostInImpl({ code, allowedHosts: [] }).ok).toBe(true);
  });

  test("v0.3.8 empirical case: github.com when allowlist is api.github.com", () => {
    const code = `const url = "https://github.com/rust-lang/rust/releases"; fetch(url);`;
    const r = detectUnallowedHostInImpl({
      code,
      allowedHosts: ["api.github.com", "raw.githubusercontent.com"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics).toContain("github.com");
      expect(r.diagnostics).toContain("api.github.com");
    }
  });

  test("all literal hosts in allowlist passes", () => {
    const code = `
      fetch("https://api.github.com/repos/x/y");
      fetch("https://raw.githubusercontent.com/x/y/master/README.md");
    `;
    const r = detectUnallowedHostInImpl({
      code,
      allowedHosts: ["api.github.com", "raw.githubusercontent.com"],
    });
    expect(r.ok).toBe(true);
  });

  test("template-interpolated host is skipped (input-driven)", () => {
    const code = `const url = \`https://\${host}/path\`; fetch(url);`;
    expect(
      detectUnallowedHostInImpl({ code, allowedHosts: ["only.example"] }).ok,
    ).toBe(true);
  });

  test("interpolation in path with literal host: host is still checked", () => {
    // The v0.3.8 empirical case: github.com host with templated path.
    const code = `fetch(\`https://github.com/rust-lang/rust/releases/tag/\${ver}\`);`;
    const r = detectUnallowedHostInImpl({
      code,
      allowedHosts: ["api.github.com", "raw.githubusercontent.com"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics).toContain("github.com");
  });

  test("interpolation in path with allowlisted host passes", () => {
    const code = `fetch(\`https://api.github.com/repos/\${owner}/\${repo}\`);`;
    expect(
      detectUnallowedHostInImpl({
        code,
        allowedHosts: ["api.github.com"],
      }).ok,
    ).toBe(true);
  });

  test("multiple disallowed hosts are de-duped in diagnostics", () => {
    const code = `
      fetch("https://a.bad/x");
      fetch("https://a.bad/y");
      fetch("https://b.bad/z");
    `;
    const r = detectUnallowedHostInImpl({
      code,
      allowedHosts: ["ok.example"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics).toContain("a.bad");
      expect(r.diagnostics).toContain("b.bad");
    }
  });

  test("malformed URL literal is skipped silently", () => {
    const code = `const u = "https://"; fetch(u);`;
    expect(
      detectUnallowedHostInImpl({ code, allowedHosts: ["x.example"] }).ok,
    ).toBe(true);
  });

  test("exact-match host check: subdomain mismatch is flagged", () => {
    const code = `fetch("https://api.github.com/x");`;
    const r = detectUnallowedHostInImpl({
      code,
      allowedHosts: ["github.com"], // does NOT cover api.github.com
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics).toContain("api.github.com");
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

  test("sampleUrls check runs after the URL-array rule", () => {
    // Clean impl; test that doesn't reference sampleUrls.
    const code = `const u = \`https://x.com/\${id}\`; fetch(u);`;
    const testCode = `if (url.includes("wrong-pattern")) ...`;
    const r = validateGeneratedTool({
      code,
      testCode,
      sampleUrls: ["https://x.com/api/v1/items/42"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics).toContain("sampleUrls");
  });

  test("no sampleUrls supplied → only URL-array rule fires (back-compat)", () => {
    const code = `const u = \`https://x.com/\${id}\`; fetch(u);`;
    const r = validateGeneratedTool({ code, testCode: "" });
    expect(r.ok).toBe(true);
  });

  test("host-allowlist rule runs after sampleUrl check", () => {
    const code = `fetch("https://wrong.host/api");`;
    const r = validateGeneratedTool({
      code,
      testCode: "https://allowed.host/anchor",
      sampleUrls: ["https://allowed.host/anchor"],
      allowedHosts: ["allowed.host"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics).toContain("wrong.host");
  });

  test("no allowedHosts supplied → host check skipped (back-compat)", () => {
    const code = `fetch("https://anywhere.example/x");`;
    const r = validateGeneratedTool({ code, testCode: "" });
    expect(r.ok).toBe(true);
  });
});
