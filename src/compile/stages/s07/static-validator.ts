/**
 * Stage 7 static validator — catches implementation patterns that pass the
 * generated smoke test by accident but break at runtime.
 *
 * Why this exists: the LlmImplementer's retry loop runs `bun test` against the
 * generated `<tool>.test.ts`. That test typically mocks `ctx.fetch` so the
 * tool runs without network. If the LLM writes a fallback that hits the same
 * mock (e.g. `const attempts = [url1, url2, ...]; for (...) if (ok) break`)
 * the smoke passes because every URL resolves to the same mocked response.
 * At runtime the fallback URL is a real, always-200 page and the tool happily
 * returns its data under any input — a silent false-positive.
 *
 * The empirical case that motivated this check (`/tmp/almanac-rust-v032-smoke
 * /rust/tools/lookup_std_item.ts`):
 *
 *     const attempts = [
 *       `https://doc.rust-lang.org/std/${itemPath}`,
 *       `https://doc.rust-lang.org/std/vec/struct.Vec.html`,
 *       `https://doc.rust-lang.org/std/iter/trait.Iterator.html`,
 *       `https://doc.rust-lang.org/std/sync/struct.Arc.html`,
 *       `https://doc.rust-lang.org/std/macro.println.html`,
 *     ];
 *
 * Asking `lookup_std_item({ item: "Frobnicator" })` returned the Vec docs.
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
 * Run all static checks on a generated tool. Returns the first failure if any;
 * `{ ok: true }` if all pass. Today there is only one rule, but the surface is
 * shaped to let more rules land without changing the LlmImplementer wiring.
 */
export function validateGeneratedTool(input: {
  code: string;
  testCode: string;
}): StaticValidationResult {
  const r1 = detectHardcodedFallbackUrls(input.code);
  if (!r1.ok) return r1;
  return { ok: true };
}
