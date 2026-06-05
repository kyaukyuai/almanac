import { afterEach, describe, expect, test } from "bun:test";

import {
  StudioServerError,
  assertStudioHost,
  parseStudioPort,
  renderStudioHtml,
  startStudioServer,
  type StudioAlmanacCard,
  type StudioSnapshot,
  type StudioServerHandle,
} from "./studio.ts";

let server: StudioServerHandle | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

describe("studio server", () => {
  test("allows localhost binds and rejects public binds", () => {
    expect(() => assertStudioHost("127.0.0.1")).not.toThrow();
    expect(() => assertStudioHost("localhost")).not.toThrow();
    expect(() => assertStudioHost("::1")).not.toThrow();
    expect(() => assertStudioHost("0.0.0.0")).toThrow(StudioServerError);
    expect(() => assertStudioHost("192.168.1.2")).toThrow(
      "studio only binds to localhost",
    );
  });

  test("validates port input", () => {
    expect(parseStudioPort(undefined)).toBe(4631);
    expect(parseStudioPort("0")).toBe(0);
    expect(parseStudioPort("65535")).toBe(65535);
    expect(() => parseStudioPort("-1")).toThrow(StudioServerError);
    expect(() => parseStudioPort("65536")).toThrow("between 0 and 65535");
    expect(() => parseStudioPort("abc")).toThrow("studio port");
  });

  test("renders escaped dashboard data and copyable commands", () => {
    const html = renderStudioHtml({
      ...fixtureSnapshot(),
      root: "/tmp/<root>",
      almanacs: [
        {
          ...fixtureCard(),
          displayName: "SQLite <Demo>",
          nextBestAction: {
            label: "Open status",
            command: 'almanac status sqlite-demo --note "<x>"',
            reason: "Review <details>",
            providerRequired: false,
            mutates: false,
          },
        },
      ],
    });

    expect(html).toContain("SQLite &lt;Demo&gt;");
    expect(html).toContain("/tmp/&lt;root&gt;");
    expect(html).toContain("almanac status sqlite-demo --note &quot;&lt;x&gt;&quot;");
    expect(html).not.toContain("SQLite <Demo>");
  });

  test("serves read-only html and status APIs without provider credentials", async () => {
    server = startStudioServer({
      host: "127.0.0.1",
      port: 0,
      loadSnapshot: async () => fixtureSnapshot(),
      loadStatus: async (almanacId) =>
        almanacId === "sqlite-demo" ? fixtureCard() : null,
    });

    const html = await fetch(server.url).then((response) => response.text());
    expect(html).toContain("Almanac");
    expect(html).toContain("SQLite Operations Demo");
    expect(html).toContain("Activation");
    expect(html).toContain("answer ready; next first answer saved");
    expect(html).toContain("Are SQLite transactions atomic?");
    expect(html).toContain("almanac ask sqlite-demo");

    const inventory = await fetch(`${server.url}/api/inventory`).then(
      async (response) => ({
        status: response.status,
        body: (await response.json()) as StudioSnapshot,
      }),
    );
    expect(inventory.status).toBe(200);
    expect(inventory.body.almanacs[0]?.almanacId).toBe("sqlite-demo");
    expect(inventory.body.almanacs[0]?.activation).toEqual(
      expect.objectContaining({
        status: "in-progress",
        milestone: "answer-ready",
        nextMilestone: "first-answer",
      }),
    );
    expect(inventory.body.almanacs[0]?.suggestedQuestions[0]?.question).toBe(
      "Are SQLite transactions atomic?",
    );

    const status = await fetch(`${server.url}/api/status/sqlite-demo`).then(
      async (response) => ({
        status: response.status,
        body: (await response.json()) as StudioAlmanacCard,
      }),
    );
    expect(status.status).toBe(200);
    expect(status.body.checks.validation).toBe("2/2 passed");
    expect(status.body.activation.nextAction?.command).toContain(
      "almanac ask sqlite-demo",
    );
    expect(status.body.recommendedOperation).toEqual(
      expect.objectContaining({
        label: "Ask first question",
        category: "handoff",
        providerRequired: true,
        studioRunnable: false,
      }),
    );
    expect(status.body.operations[0]?.command).toContain(
      "almanac ask sqlite-demo",
    );

    const missing = await fetch(`${server.url}/api/status/missing`);
    expect(missing.status).toBe(404);

    const post = await fetch(`${server.url}/api/inventory`, { method: "POST" });
    expect(post.status).toBe(405);
  });
});

function fixtureSnapshot(): StudioSnapshot {
  return {
    schemaVersion: "0.1.0",
    root: "/tmp/almanac-root",
    generatedAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 1, ok: 1, attention: 0, broken: 0 },
    almanacs: [fixtureCard()],
  };
}

function fixtureCard(): StudioAlmanacCard {
  return {
    almanacId: "sqlite-demo",
    displayName: "SQLite Operations Demo",
    almanacDir: "/tmp/almanac-root/sqlite-demo",
    health: "ok",
    usability: {
      status: "usable",
      reason: "compile, knowledge, benchmark, and answer readiness are usable",
    },
    manifest: {
      domain: "sqlite operations demo",
      version: "0.1.0",
      profile: "static-heavy",
      compiledAt: "2026-01-01T00:00:00.000Z",
    },
    references: {
      extractedKnowledge: 3,
      tools: 4,
      retrieval: "fts-only",
    },
    checks: {
      validation: "2/2 passed",
      answer: "ready",
      refresh: "due",
      registration: "not registered",
    },
    latestHistory: {
      latest: "none",
      answer: "none",
      refresh: "none",
      maintenance: "none",
      readError: null,
    },
    activation: {
      status: "in-progress",
      milestone: "answer-ready",
      milestoneLabel: "answer ready",
      nextMilestone: "first-answer",
      nextMilestoneLabel: "first answer saved",
      summary: "answer ready; next first answer saved",
      evidence: ["answer readiness is ready"],
      gaps: ["no saved answer history yet"],
      nextAction: {
        label: "Ask first question",
        command:
          "almanac ask sqlite-demo 'Are SQLite transactions atomic?' --save --root /tmp/almanac-root",
        reason: "save the first cited answer or valid abstention",
        providerRequired: true,
        mutates: true,
      },
    },
    suggestedQuestions: [
      {
        intent: "lookup",
        question: "Are SQLite transactions atomic?",
        askCommand:
          "almanac ask sqlite-demo 'Are SQLite transactions atomic?' --root /tmp/almanac-root",
        saveCommand:
          "almanac ask sqlite-demo 'Are SQLite transactions atomic?' --save --root /tmp/almanac-root",
      },
    ],
    issues: [],
    recommendedOperation: fixtureOperation(),
    operations: [fixtureOperation()],
    nextBestAction: {
      label: "Open status",
      command: "almanac status sqlite-demo --root /tmp/almanac-root",
      reason: "This almanac is ready; status shows references and checks.",
      providerRequired: false,
      mutates: false,
    },
    commands: [
      {
        label: "Run validation",
        command: "almanac benchmark sqlite-demo --root /tmp/almanac-root",
        providerRequired: false,
        mutates: false,
      },
    ],
  };
}

function fixtureOperation() {
  return {
    id: "op-handoff-1234567890",
    label: "Ask first question",
    description: "Save the first cited answer or valid abstention.",
    category: "handoff",
    providerRequired: true,
    mutation: "artifact-write",
    confirmation: true,
    command:
      "almanac ask sqlite-demo 'Are SQLite transactions atomic?' --save --root /tmp/almanac-root",
    studioRunnable: false,
    expectedArtifacts: [".runs/answer-*.json"],
    blockedReason: "provider-backed operation uses CLI handoff",
  };
}
