/**
 * Stage 7 static validator — catches implementation patterns that pass the
 * generated smoke test by accident but break at runtime.
 *
 * Why this exists: the LlmImplementer's retry loop runs `bun test` against the
 * generated `<tool>.test.ts`. That test typically mocks `ctx.fetch` so the
 * tool runs without network. Two classes of bugs slip past this:
 *
 *   1. Hardcoded URL fallback list. If the LLM writes
 *      `const attempts = [url1, url2, ...]; for (...) if (ok) break`,
 *      the smoke's url-symmetric mock resolves every URL to the same canned
 *      response. At runtime the fallback URLs are real always-200 pages, so
 *      the tool returns those pages' contents under any input.
 *      Rule: `detectHardcodedFallbackUrls` flags ≥2 adjacent hardcoded URL
 *      literals in the impl.
 *      Empirical: v0.3.2 rust `lookup_std_item({item:"Frobnicator"})` →
 *      Vec docs.
 *
 *   2. Wrong URL template paired with a matching wrong mock. The LLM
 *      confabulates a URL pattern, then writes a test mock against that
 *      same wrong pattern, so the smoke passes — but at runtime real
 *      upstream returns 404 because the URL doesn't exist.
 *      Rule: `requireSampleUrlInTestCode` flags test code that doesn't
 *      reference any `manifest.sampleUrls` substring. Stage 6 populates
 *      sampleUrls with real documented URLs; Stage 7 must mock at least one.
 *      Empirical: v0.3.4 rust `lookup_std_item("std::sync::Arc")` →
 *      not-found (tried `/std/sync/Arc/...` instead of `/std/sync/struct.Arc.html`).
 *
 * Detection contract — high precision, low recall. We accept that some
 * hallucinations slip through; we won't reject legitimate code.
 */

export interface StaticValidationOk {
  readonly ok: true;
}
export interface StaticValidationFailed {
  readonly ok: false;
  readonly diagnostics: string;
}
export type StaticValidationResult = StaticValidationOk | StaticValidationFailed;

// Lookahead so the URL after the comma is observed but not consumed, letting
// `matchAll` walk chains of adjacent URL literals (each member except the last
// shows up as `A`, and the last is captured as `B` of the previous iteration).
const URL_LITERAL_PAIR_RE =
  /(['"`])(https?:\/\/[^'"`\n]+?)\1(?=\s*,\s*(['"`])(https?:\/\/[^'"`\n]+?)\3)/g;

/**
 * Reject implementations that contain adjacent hardcoded URL string literals
 * — the signature of a fallback list that always succeeds at runtime.
 *
 * Rule: if the source contains two or more `https?://...` string literals
 * separated only by `,` and whitespace, and neither side contains a template
 * interpolation (`${...}`), the impl is rejected.
 *
 *   const attempts = [`https://x/a`, `https://x/b`];   // ← flagged
 *   const a = "https://x/a"; const b = "https://x/b";  // ← not flagged
 *   fetch(`https://x/${input}`)                         // ← not flagged
 *   [api, `https://x/fallback`]                         // ← not flagged
 *                                                       //   (api is a variable)
 *
 * False positives we accept: a tool that legitimately passes 2 URLs to a
 * helper (rare in generated tool code; cheap to retry if hit).
 */
export function detectHardcodedFallbackUrls(
  code: string,
): StaticValidationResult {
  const found = new Set<string>();
  for (const m of code.matchAll(URL_LITERAL_PAIR_RE)) {
    const a = m[2]!;
    const b = m[4]!;
    // Skip if either URL contains template interpolation — those are
    // input-driven, not hardcoded.
    if (a.includes("${") || b.includes("${")) continue;
    found.add(a);
    found.add(b);
  }
  if (found.size === 0) return { ok: true };
  const unique = Array.from(found);
  const sample = unique.slice(0, 4).join(", ");
  const tail = unique.length > 4 ? `, +${unique.length - 4} more` : "";
  return {
    ok: false,
    diagnostics:
      `Stage 7 static validator: hardcoded URL fallback detected. ` +
      `The implementation contains adjacent hardcoded URL string literals ` +
      `(${unique.length} URL${unique.length === 1 ? "" : "s"}: ${sample}${tail}). ` +
      `This pattern (a fixed list of full URLs tried in sequence) passes the ` +
      `smoke test because the mock fetch resolves every URL to the same ` +
      `canned response, but at runtime the fallback URLs are real pages that ` +
      `always return 200 — so the tool returns those pages' contents under any ` +
      `input (e.g., lookup_std_item("Frobnicator") returns Vec's docs). ` +
      `Build the URL from input parameters and return ok:false on 404; do not ` +
      `fall back to fixed URLs.`,
  };
}

/**
 * Reject test code that doesn't reference any of the manifest's sampleUrls
 * — the ground-truth check.
 *
 * Stage 6 populates `sampleUrls` with real documented URLs the tool will
 * plausibly fetch. Stage 7's prompt requires the generated test mock to
 * register at least one of those URLs as a 200 response. If the LLM-generated
 * test does not mention any sampleUrl, the test is operating against
 * confabulated URLs and the smoke will pass without checking the impl
 * against reality.
 *
 * Match is a simple `testCode.includes(url)` substring scan — the LLM can
 * write the URL inside a string literal in the mock fetch handler, in a
 * `Record<string, ...>` key, in an `expect(...).toContain(...)` arg, etc.
 *
 * Skipped (returns `ok:true`) when:
 *   - `sampleUrls.length === 0` — tool doesn't fetch (e.g., knowledge-only)
 *     OR Stage 6 didn't populate them (legacy / earlier-version manifest).
 */
export function requireSampleUrlInTestCode(input: {
  testCode: string;
  sampleUrls: readonly string[];
}): StaticValidationResult {
  if (input.sampleUrls.length === 0) return { ok: true };
  const matched = input.sampleUrls.some((u) => input.testCode.includes(u));
  if (matched) return { ok: true };
  const sample = input.sampleUrls.slice(0, 3).join(", ");
  const tail =
    input.sampleUrls.length > 3
      ? `, +${input.sampleUrls.length - 3} more`
      : "";
  return {
    ok: false,
    diagnostics:
      `Stage 7 static validator: generated smoke test does not reference ` +
      `any of the manifest's sampleUrls. Expected at least one of ` +
      `[${sample}${tail}] to appear in the test source (as a mock fetch ` +
      `key, in an includes() argument, etc.). Without this anchor the smoke ` +
      `runs against confabulated URLs and won't catch a runtime URL-template ` +
      `bug. Update mkCtx (or equivalent) so ctx.fetch returns a 200 for at ` +
      `least one sampleUrl, and ensure one example input drives the impl to ` +
      `fetch that URL.`,
  };
}

/**
 * Run all static checks on a generated tool. Returns the first failure if any;
 * `{ ok: true }` if all pass. The surface accepts the full input each rule
 * might need so new rules can land without changing the LlmImplementer wiring.
 */
export function validateGeneratedTool(input: {
  code: string;
  testCode: string;
  sampleUrls?: readonly string[];
}): StaticValidationResult {
  const r1 = detectHardcodedFallbackUrls(input.code);
  if (!r1.ok) return r1;
  const r2 = requireSampleUrlInTestCode({
    testCode: input.testCode,
    sampleUrls: input.sampleUrls ?? [],
  });
  if (!r2.ok) return r2;
  return { ok: true };
}
