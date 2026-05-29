/**
 * Tests for Stage 5 (fact extraction) zod schemas + `materializeFact()`.
 *
 * The first three tests parse the worked examples embedded in
 *   src/compile/prompts/05-fact-extraction/v1.md
 * (status: extracted / skipped / no-content) so prompt and schema cannot
 * drift.
 *
 * Tests on `materializeFact()` exercise the static/slow validUntil derivation,
 * source binding injection, and round-trip through `FactRecordSchema`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  ExtractedFactDraftSchema,
  ExtractionResultSchema,
  FACT_TYPE_LENIENT_REMAP,
  FactRecordSchema,
  materializeFact,
  normalizeExtractionResult,
  type ExtractedFactDraft,
  type ExtractionResult,
  type FactRecord,
} from "./types.ts";

// A valid 26-char ULID (test fixture).
const ULID_FIXTURE = "01H8Q5Z2QJK4VXNTRWP3M7XYZ0";
// 64-char sha256 hex.
const HASH_FIXTURE =
  "a3f5b1c9e7d4a2b8f6e1c3d5a7b9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5";

// ──────────────────────────────────────────────────────────────────────────────
// Worked example 1: extracted
// ──────────────────────────────────────────────────────────────────────────────

const EXTRACTED_KUBERNETES: unknown = {
  schemaVersion: "0.1.0",
  status: "extracted",
  skipReason: null,
  coverage: {
    extractable:
      "Pod definition, container sharing model, kubectl apply procedure.",
    nonExtractable:
      "Kubernetes 1.30 sidecar stability and restartPolicy field (version-pinned).",
  },
  facts: [
    {
      text: "A Pod is the smallest deployable unit of computing in Kubernetes.",
      type: "definition",
      entities: ["pod", "resource"],
      excerpt:
        "A Pod is the smallest deployable unit of computing that you can create and manage in Kubernetes.",
      freshnessClass: "static",
      validUntilRelative: null,
      confidence: 0.98,
    },
    {
      text: "A Pod represents one or more containers that share network and storage.",
      type: "fact",
      entities: ["pod", "container"],
      excerpt:
        "A Pod represents one or more containers that share network and storage.",
      freshnessClass: "static",
      validUntilRelative: null,
      confidence: 0.97,
    },
    {
      text: "To create a Pod, apply a YAML manifest with `kind: Pod` to the API server using `kubectl apply`.",
      type: "procedure",
      entities: ["pod", "kubectl"],
      excerpt:
        "To create a Pod, apply a YAML manifest with `kind: Pod` to the API server using `kubectl apply`.",
      freshnessClass: "slow",
      validUntilRelative: { days: 365 },
      confidence: 0.92,
      volatilityNotes:
        "Procedure is stable for years; minor flag changes are possible.",
    },
  ],
};

const SKIPPED_RELEASE_NOTES: unknown = {
  schemaVersion: "0.1.0",
  status: "skipped",
  skipReason: "fast-live-dominant",
  coverage: {
    extractable:
      "None — content is entirely about a specific Kubernetes minor release.",
    nonExtractable:
      "All version-pinned features and deprecations for Kubernetes 1.30.",
  },
  facts: [],
};

const NO_CONTENT_EXAMPLE: unknown = {
  schemaVersion: "0.1.0",
  status: "no-content",
  skipReason: "empty-or-unparseable",
  coverage: {
    extractable: "Source content was empty after extraction.",
    nonExtractable: "n/a",
  },
  facts: [],
};

// ──────────────────────────────────────────────────────────────────────────────
// ExtractionResult — worked examples
// ──────────────────────────────────────────────────────────────────────────────

describe("ExtractionResult — prompt v1 worked examples", () => {
  test("EXAMPLE 1 (extracted) parses", () => {
    const result = ExtractionResultSchema.parse(EXTRACTED_KUBERNETES);
    expect(result.status).toBe("extracted");
    expect(result.facts.length).toBe(3);
    expect(result.facts[0]?.freshnessClass).toBe("static");
    expect(result.facts[2]?.freshnessClass).toBe("slow");
    expect(result.facts[2]?.validUntilRelative?.days).toBe(365);
  });

  test("EXAMPLE 2 (skipped) parses", () => {
    const result = ExtractionResultSchema.parse(SKIPPED_RELEASE_NOTES);
    expect(result.status).toBe("skipped");
    expect(result.facts.length).toBe(0);
    expect(result.skipReason).toBe("fast-live-dominant");
  });

  test("EXAMPLE 3 (no-content) parses", () => {
    const result = ExtractionResultSchema.parse(NO_CONTENT_EXAMPLE);
    expect(result.status).toBe("no-content");
    expect(result.facts.length).toBe(0);
  });
});

describe("ExtractionResult — validation rejections", () => {
  test("rejects status=extracted with empty facts", () => {
    const bad = structuredClone(EXTRACTED_KUBERNETES) as ExtractionResult;
    bad.facts = [];
    expect(() => ExtractionResultSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects status=skipped with non-empty facts", () => {
    const bad = structuredClone(SKIPPED_RELEASE_NOTES) as ExtractionResult;
    bad.facts = [
      structuredClone(
        (EXTRACTED_KUBERNETES as ExtractionResult).facts[0]!,
      ),
    ];
    expect(() => ExtractionResultSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects status=skipped with null skipReason", () => {
    const bad = structuredClone(SKIPPED_RELEASE_NOTES) as ExtractionResult;
    bad.skipReason = null;
    expect(() => ExtractionResultSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects facts.length > 50", () => {
    const template = (EXTRACTED_KUBERNETES as ExtractionResult).facts[0]!;
    const bad = {
      ...(EXTRACTED_KUBERNETES as ExtractionResult),
      facts: Array.from({ length: 51 }, () => structuredClone(template)),
    };
    expect(() => ExtractionResultSchema.parse(bad)).toThrow(z.ZodError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ExtractedFactDraft — invariants on freshnessClass × validUntilRelative
// ──────────────────────────────────────────────────────────────────────────────

describe("ExtractedFactDraft — freshness invariants", () => {
  test("rejects static with non-null validUntilRelative", () => {
    const bad: unknown = {
      text: "Pi is approximately 3.14159.",
      type: "fact",
      entities: ["math"],
      excerpt: "Pi is approximately 3.14159.",
      freshnessClass: "static",
      validUntilRelative: { days: 30 },
      confidence: 0.99,
    };
    expect(() => ExtractedFactDraftSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects slow with null validUntilRelative", () => {
    const bad: unknown = {
      text: "Best practice X applies as of 2026.",
      type: "fact",
      entities: ["practice"],
      excerpt: "Best practice X applies as of 2026.",
      freshnessClass: "slow",
      validUntilRelative: null,
      confidence: 0.8,
    };
    expect(() => ExtractedFactDraftSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects freshnessClass='fast' (cacheable=static|slow only)", () => {
    const bad: unknown = {
      text: "Kubernetes 1.30 stabilizes sidecar containers.",
      type: "fact",
      entities: ["version"],
      excerpt: "Kubernetes 1.30 stabilizes sidecar containers.",
      freshnessClass: "fast",
      validUntilRelative: { days: 30 },
      confidence: 0.95,
    };
    expect(() => ExtractedFactDraftSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects confidence < 0.5", () => {
    const bad: unknown = {
      text: "Speculative claim about something.",
      type: "fact",
      entities: [],
      excerpt: "speculative",
      freshnessClass: "static",
      validUntilRelative: null,
      confidence: 0.4,
    };
    expect(() => ExtractedFactDraftSchema.parse(bad)).toThrow(z.ZodError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// materializeFact() — pure conversion + validUntil derivation
// ──────────────────────────────────────────────────────────────────────────────

describe("materializeFact() — happy paths", () => {
  const draftStatic: ExtractedFactDraft = (
    EXTRACTED_KUBERNETES as ExtractionResult
  ).facts[0]!;
  const draftSlow: ExtractedFactDraft = (
    EXTRACTED_KUBERNETES as ExtractionResult
  ).facts[2]!;

  const baseCtx = {
    id: ULID_FIXTURE,
    sourceId: "kubernetes-io-docs",
    contentHash: HASH_FIXTURE,
    url: "https://kubernetes.io/docs/concepts/workloads/pods/",
    extractedAt: new Date("2026-05-08T10:00:00Z"),
    extractor: { model: "claude-sonnet-4", promptVersion: "v1" },
  } as const;

  test("static draft → validUntil=null", () => {
    const rec = materializeFact(draftStatic, baseCtx);
    expect(rec.id).toBe(ULID_FIXTURE);
    expect(rec.freshnessClass).toBe("static");
    expect(rec.validUntil).toBeNull();
    expect(rec.source.contentHash).toBe(HASH_FIXTURE);
    expect(rec.source.sourceId).toBe("kubernetes-io-docs");
    expect(rec.extractedAt).toBe("2026-05-08T10:00:00.000Z");
    expect(rec.extractor.promptVersion).toBe("v1");
  });

  test("slow draft → validUntil = extractedAt + days", () => {
    const rec = materializeFact(draftSlow, baseCtx);
    expect(rec.freshnessClass).toBe("slow");
    // 2026-05-08 + 365 days = 2027-05-08
    expect(rec.validUntil).toBe("2027-05-08T10:00:00.000Z");
    expect(rec.volatilityNotes).toBeDefined();
  });

  test("does not mutate input draft", () => {
    const snapshot = structuredClone(draftStatic);
    materializeFact(draftStatic, baseCtx);
    expect(draftStatic).toEqual(snapshot);
  });

  test("omits volatilityNotes when draft did not provide one", () => {
    const rec = materializeFact(draftStatic, baseCtx);
    expect("volatilityNotes" in rec).toBe(false);
  });

  test("output is round-trippable through FactRecordSchema", () => {
    const rec = materializeFact(draftSlow, baseCtx);
    const reparsed = FactRecordSchema.parse(rec);
    expect(reparsed).toEqual(rec);
  });

  test("two calls with the same id produce identical records (deterministic)", () => {
    const a = materializeFact(draftStatic, baseCtx);
    const b = materializeFact(draftStatic, baseCtx);
    expect(a).toEqual(b);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// FactRecord — direct schema validation rejections
// ──────────────────────────────────────────────────────────────────────────────

describe("FactRecord — validation rejections", () => {
  function valid(): FactRecord {
    return {
      id: ULID_FIXTURE,
      text: "A Pod is the smallest deployable unit of computing in Kubernetes.",
      type: "definition",
      entities: ["pod", "resource"],
      source: {
        sourceId: "kubernetes-io-docs",
        contentHash: HASH_FIXTURE,
        url: "https://kubernetes.io/docs/concepts/workloads/pods/",
        excerpt:
          "A Pod is the smallest deployable unit of computing that you can create and manage in Kubernetes.",
      },
      freshnessClass: "static",
      validUntil: null,
      confidence: 0.98,
      extractedAt: "2026-05-08T10:00:00.000Z",
      extractor: { model: "claude-sonnet-4", promptVersion: "v1" },
    };
  }

  test("baseline parses", () => {
    expect(() => FactRecordSchema.parse(valid())).not.toThrow();
  });

  test("rejects malformed ULID", () => {
    const bad = valid();
    bad.id = "not-a-ulid";
    expect(() => FactRecordSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects malformed contentHash", () => {
    const bad = valid();
    bad.source.contentHash = "abc"; // too short, not 64 hex
    expect(() => FactRecordSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects static fact with non-null validUntil", () => {
    const bad = valid();
    bad.validUntil = "2027-05-08T10:00:00.000Z";
    expect(() => FactRecordSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects slow fact with null validUntil", () => {
    const bad = valid();
    bad.freshnessClass = "slow";
    bad.validUntil = null;
    expect(() => FactRecordSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects entities array longer than 10", () => {
    const bad = valid();
    bad.entities = Array.from({ length: 11 }, (_, i) => `e${i}`);
    expect(() => FactRecordSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects invalid url in source", () => {
    const bad = valid();
    bad.source.url = "not a url";
    expect(() => FactRecordSchema.parse(bad)).toThrow(z.ZodError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// normalizeExtractionResult — lenient pre-parse fixups (regression)
// ──────────────────────────────────────────────────────────────────────────────

describe("normalizeExtractionResult", () => {
  function factWith(type: string, excerpt = "ok"): Record<string, unknown> {
    return {
      text: "A reasonably long fact statement that satisfies the min cap.",
      type,
      entities: ["x"],
      excerpt,
      freshnessClass: "static",
      validUntilRelative: null,
      confidence: 0.9,
    };
  }
  const baseExtractionShape = {
    schemaVersion: "0.1.0",
    status: "extracted",
    skipReason: null,
    coverage: { extractable: "x", nonExtractable: "y" },
  };

  test("remaps known LLM type mistakes to canonical fact types", () => {
    const raw = {
      ...baseExtractionShape,
      facts: [
        factWith("pattern"),
        factWith("antipattern"),
        factWith("practice"),
        factWith("deployment-pattern"),
        factWith("control"),
        factWith("policy"),
        factWith("risk"),
        factWith("vulnerability"),
        factWith("role"),
        factWith("vendor"),
        factWith("platform"),
        factWith("fact"), // canonical — leave alone
      ],
    };
    const normalized = normalizeExtractionResult(raw) as typeof raw;
    expect(normalized.facts.map((f) => (f as { type: string }).type)).toEqual([
      "framework",
      "tradeoff",
      "procedure",
      "framework",
      "principle",
      "principle",
      "fact",
      "fact",
      "reference",
      "reference",
      "reference",
      "fact",
    ]);
    // The result is now schema-valid where the raw form was not.
    expect(() => ExtractionResultSchema.parse(normalized)).not.toThrow();
  });

  test("matches the lenient remap table exactly", () => {
    expect(Object.keys(FACT_TYPE_LENIENT_REMAP).sort()).toEqual([
      "antipattern",
      "control",
      "deployment-pattern",
      "pattern",
      "platform",
      "policy",
      "practice",
      "risk",
      "role",
      "vendor",
      "vulnerability",
    ]);
  });

  test("case-insensitive on type", () => {
    const raw = {
      ...baseExtractionShape,
      facts: [factWith("PATTERN"), factWith("AntiPattern")],
    };
    const normalized = normalizeExtractionResult(raw) as typeof raw;
    expect(normalized.facts.map((f) => (f as { type: string }).type)).toEqual([
      "framework",
      "tradeoff",
    ]);
  });

  test("truncates excerpts longer than 300 chars (regression)", () => {
    const long = "x".repeat(800);
    const raw = {
      ...baseExtractionShape,
      facts: [factWith("fact", long)],
    };
    const normalized = normalizeExtractionResult(raw) as typeof raw;
    const e = (normalized.facts[0] as { excerpt: string }).excerpt;
    expect(e.length).toBe(300);
  });

  test("leaves unknown types alone (schema will reject loud)", () => {
    const raw = {
      ...baseExtractionShape,
      facts: [factWith("totally-unknown-type")],
    };
    const normalized = normalizeExtractionResult(raw) as typeof raw;
    expect((normalized.facts[0] as { type: string }).type).toBe(
      "totally-unknown-type",
    );
    expect(() => ExtractionResultSchema.parse(normalized)).toThrow(z.ZodError);
  });

  test("non-object input is returned unchanged", () => {
    expect(normalizeExtractionResult(null)).toBeNull();
    expect(normalizeExtractionResult("not-an-object")).toBe("not-an-object");
    expect(normalizeExtractionResult([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("truncates coverage.nonExtractable longer than 300 chars (regression)", () => {
    const long = "x".repeat(800);
    const raw = {
      ...baseExtractionShape,
      coverage: { extractable: "ok", nonExtractable: long },
      facts: [factWith("fact")],
    };
    const normalized = normalizeExtractionResult(raw) as typeof raw;
    expect(
      (normalized.coverage as { nonExtractable: string }).nonExtractable.length,
    ).toBe(300);
    expect(() => ExtractionResultSchema.parse(normalized)).not.toThrow();
  });

  test("truncates coverage.extractable longer than 300 chars", () => {
    const long = "y".repeat(800);
    const raw = {
      ...baseExtractionShape,
      coverage: { extractable: long, nonExtractable: "ok" },
      facts: [factWith("fact")],
    };
    const normalized = normalizeExtractionResult(raw) as typeof raw;
    expect(
      (normalized.coverage as { extractable: string }).extractable.length,
    ).toBe(300);
  });
});
