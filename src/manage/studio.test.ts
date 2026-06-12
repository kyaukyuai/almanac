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
import { deriveProviderReadiness } from "./provider-readiness.ts";

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

  test("renders provider readiness without leaking credential values", () => {
    const secret = "sk-ant-studio-secret-0123456789";
    const html = renderStudioHtml({
      ...fixtureSnapshot(),
      providerReadiness: deriveProviderReadiness({ ANTHROPIC_API_KEY: secret }),
    });

    expect(html).toContain("Provider readiness");
    expect(html).toContain("compile and answer unlocked");
    expect(html).toContain('data-capability-status="unlocked"');
    expect(html).not.toContain(secret);

    const lockedHtml = renderStudioHtml(fixtureSnapshot());
    expect(lockedHtml).toContain("compile and answer locked");
    expect(lockedHtml).toContain('data-capability-status="locked"');
  });

  test("renders setup intake with staged references and escapes them", () => {
    const html = renderStudioHtml({
      ...fixtureSnapshot(),
      setupIntake: {
        references: [
          {
            url: "https://docs.example.com/<guide>",
            addedAt: "2026-06-12T00:00:00.000Z",
            via: "studio",
          },
        ],
        checklist: {
          status: "ready",
          summary: "1 reviewed reference(s) ready for compile handoff",
          acceptedCount: 1,
          rejectedCount: 0,
          gaps: [],
          nextAction: null,
        },
      },
    });

    expect(html).toContain("Plan a new almanac");
    expect(html).toContain("data-setup-reference-form");
    expect(html).toContain("https://docs.example.com/&lt;guide&gt;");
    expect(html).not.toContain("https://docs.example.com/<guide>");
    expect(html).toContain("ready for compile handoff");
    expect(html).toContain("/api/setup/references");

    const emptyHtml = renderStudioHtml(fixtureSnapshot());
    expect(emptyHtml).toContain("No references staged yet");
  });

  test("setup reference POST validates the body and forwards to the handler", async () => {
    const submitted: string[] = [];
    server = startStudioServer({
      host: "127.0.0.1",
      port: 0,
      loadSnapshot: async () => fixtureSnapshot(),
      loadStatus: async () => null,
      addSetupReference: async (url) => {
        submitted.push(url);
        return { status: "accepted", reference: { url } };
      },
    });

    const accepted = await fetch(`${server.url}/api/setup/references`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://docs.example.com" }),
    }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as { status: string },
    }));
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("accepted");
    expect(submitted).toEqual(["https://docs.example.com"]);

    for (const body of [undefined, "not-json", JSON.stringify({ url: 7 }), "{}"]) {
      const invalid = await fetch(`${server.url}/api/setup/references`, {
        method: "POST",
        ...(body === undefined ? {} : { body }),
      });
      expect(invalid.status).toBe(400);
      expect(((await invalid.json()) as { error: string }).error).toBe(
        "invalid-reference-request",
      );
    }
    expect(submitted).toHaveLength(1);
  });

  test("setup reference POST without a handler reports unavailable", async () => {
    server = startStudioServer({
      host: "127.0.0.1",
      port: 0,
      loadSnapshot: async () => fixtureSnapshot(),
      loadStatus: async () => null,
    });
    const response = await fetch(`${server.url}/api/setup/references`, {
      method: "POST",
      body: JSON.stringify({ url: "https://docs.example.com" }),
    });
    expect(response.status).toBe(501);
  });

  test("renders answer recovery details", () => {
    const html = renderStudioHtml({
      ...fixtureSnapshot(),
      almanacs: [
        {
          ...fixtureCard(),
          firstAnswerRecovery: {
            summary: "No cited evidence was available.",
            nextSteps: ["Do not fabricate or force an unsupported answer."],
            nextActions: [
              {
                label: "Inspect saved answer",
                command:
                  "almanac runs sqlite-demo answer-2026-01-01T00-00-00-000Z-00000001 --root /tmp/almanac-root",
                reason: "inspect the saved answer trace",
                providerRequired: false,
                mutates: false,
              },
            ],
          },
        },
      ],
    });

    expect(html).toContain("Answer Recovery");
    expect(html).toContain("No cited evidence was available.");
    expect(html).toContain("Do not fabricate or force an unsupported answer.");
    expect(html).toContain("Inspect saved answer");
  });

  test("renders run controls only for runnable guided operations", () => {
    const html = renderStudioHtml({
      ...fixtureSnapshot(),
      almanacs: [
        {
          ...fixtureCard(),
          recommendedOperation: fixtureOperation(),
          operations: [
            fixtureOperation("op-handoff-1111111111"),
            fixtureOperation("op-handoff-2222222222"),
            fixtureOperation("op-handoff-3333333333"),
            fixtureOperation("op-handoff-4444444444"),
            fixtureRunnableOperation(),
          ],
        },
      ],
    });

    expect(html).toContain('data-run-operation="op-refresh-abcdef1234"');
    expect(html).toContain('data-almanac-id="sqlite-demo"');
    expect(html).toContain('data-confirmation="true"');
    expect(html).toContain('data-operation-result="op-refresh-abcdef1234"');
    expect(html).toContain("Fallback command");
    expect(html).toContain("/api/operations/");
    expect(html).not.toContain('data-run-operation="op-handoff-1234567890"');
    expect(html).toContain("provider-backed operation uses CLI handoff");
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
    expect(html).toContain("First Use");
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
    expect(inventory.body.providerReadiness.llm).toEqual({
      presence: "absent",
      detectedEnv: [],
    });
    expect(inventory.body.almanacs[0]?.almanacId).toBe("sqlite-demo");
    expect(inventory.body.almanacs[0]?.activation).toEqual(
      expect.objectContaining({
        status: "in-progress",
        milestone: "answer-ready",
        nextMilestone: "first-answer",
      }),
    );
    expect(inventory.body.almanacs[0]?.firstUse).toEqual(
      expect.objectContaining({
        status: "useful",
        stage: "answer-ready",
        nextStage: "first-answer",
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
    expect(status.body.firstUse.nextAction?.command).toContain(
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

    const unavailableAction = await fetch(
      `${server.url}/api/operations/sqlite-demo/op-validate-1234567890/run`,
      { method: "POST" },
    ).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as { error: string },
    }));
    expect(unavailableAction).toEqual({
      status: 501,
      body: { error: "operation-runner-unavailable" },
    });
  });

  test("serves localhost POST action API through injected runner", async () => {
    const calls: Array<{
      almanacId: string;
      operationId: string;
      confirmed: boolean;
    }> = [];
    server = startStudioServer({
      host: "127.0.0.1",
      port: 0,
      loadSnapshot: async () => fixtureSnapshot(),
      loadStatus: async (almanacId) =>
        almanacId === "sqlite-demo" ? fixtureCard() : null,
      runOperation: async (almanacId, operationId, request) => {
        calls.push({ almanacId, operationId, confirmed: request.confirmed });
        if (operationId === "op-fail") {
          throw new Error("operation exploded");
        }
        return {
          schemaVersion: "0.1.0",
          almanacId,
          operationId,
          status: "ok",
          exitCode: 0,
          provider: { expected: false, actual: false },
          artifactsWritten: [".runs/refresh-test.json"],
          summary: "readiness evidence saved",
          reasons: [],
          nextOperation: null,
        };
      },
    });

    const action = await fetch(
      `${server.url}/api/operations/sqlite-demo/op-refresh-abcdef1234/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    ).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as {
        almanacId: string;
        operationId: string;
        status: string;
        artifactsWritten: string[];
      },
    }));

    expect(action.status).toBe(200);
    expect(action.body).toEqual(
      expect.objectContaining({
        almanacId: "sqlite-demo",
        operationId: "op-refresh-abcdef1234",
        status: "ok",
        artifactsWritten: [".runs/refresh-test.json"],
      }),
    );
    expect(calls).toEqual([
      {
        almanacId: "sqlite-demo",
        operationId: "op-refresh-abcdef1234",
        confirmed: true,
      },
    ]);

    const unconfirmedBodies: Array<RequestInit | undefined> = [
      undefined,
      { body: JSON.stringify({ confirm: false }) },
      { body: "not-json" },
      { body: JSON.stringify({ confirm: "yes" }) },
    ];
    for (const init of unconfirmedBodies) {
      calls.length = 0;
      await fetch(
        `${server.url}/api/operations/sqlite-demo/op-refresh-abcdef1234/run`,
        { method: "POST", ...init },
      );
      expect(calls[0]?.confirmed).toBe(false);
    }

    const failedAction = await fetch(
      `${server.url}/api/operations/sqlite-demo/op-fail/run`,
      { method: "POST" },
    ).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as { error?: string; message?: string },
    }));
    expect(failedAction.status).toBe(500);
    expect(failedAction.body).toEqual({
      error: "operation-run-failed",
      message: "operation exploded",
    });
  });
});

function fixtureSnapshot(): StudioSnapshot {
  return {
    schemaVersion: "0.1.0",
    root: "/tmp/almanac-root",
    generatedAt: "2026-01-01T00:00:00.000Z",
    providerReadiness: deriveProviderReadiness({}),
    setupIntake: {
      references: [],
      checklist: {
        status: "missing",
        summary: "no reviewed references yet",
        acceptedCount: 0,
        rejectedCount: 0,
        gaps: ["trusted references have not been reviewed yet"],
        nextAction: null,
      },
    },
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
    firstUse: {
      status: "useful",
      stage: "answer-ready",
      stageLabel: "answer ready",
      nextStage: "first-answer",
      nextStageLabel: "first answer saved",
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
      sourceChecklist: {
        status: "ready",
        summary: "3 accepted trusted reference(s)",
        acceptedCount: 3,
        rejectedCount: 0,
        gaps: [],
        nextAction: null,
      },
    },
    firstAnswerRecovery: null,
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

function fixtureOperation(id = "op-handoff-1234567890") {
  return {
    id,
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

function fixtureRunnableOperation() {
  return {
    id: "op-refresh-abcdef1234",
    label: "Save readiness evidence",
    description: "Persist answer-readiness evidence through a refresh artifact.",
    category: "refresh",
    providerRequired: false,
    mutation: "artifact-write",
    confirmation: true,
    command:
      "almanac refresh run sqlite-demo --from-stage 12-benchmark-run --ask-suite --save --root /tmp/almanac-root",
    studioRunnable: true,
    expectedArtifacts: [".runs/refresh-*.json"],
    blockedReason: null,
  };
}
