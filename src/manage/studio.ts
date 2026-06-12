import {
  summarizeProviderReadiness,
  type ProviderReadinessReport,
} from "./provider-readiness.ts";

export type StudioHealth =
  | "ok"
  | "attention"
  | "failed"
  | "broken"
  | "needs-validation"
  | "missing"
  | "unknown"
  | string;

export interface StudioCommand {
  label: string;
  command: string;
  reason?: string;
  providerRequired: boolean;
  mutates: boolean;
}

export interface StudioGuidedOperation {
  id: string;
  label: string;
  description: string;
  category: string;
  providerRequired: boolean;
  mutation: string;
  confirmation: boolean;
  command: string;
  studioRunnable: boolean;
  expectedArtifacts: string[];
  blockedReason: string | null;
}

export interface StudioHistorySummary {
  latest: string;
  answer: string;
  refresh: string;
  maintenance: string;
  readError: string | null;
}

export interface StudioSuggestedQuestion {
  intent: string;
  question: string;
  askCommand: string;
  saveCommand: string;
}

export interface StudioActivationSummary {
  status: string;
  milestone: string;
  milestoneLabel: string;
  nextMilestone: string | null;
  nextMilestoneLabel: string | null;
  summary: string;
  evidence: string[];
  gaps: string[];
  nextAction: StudioCommand | null;
}

export interface StudioSourceChecklistSummary {
  status: string;
  summary: string;
  acceptedCount: number;
  rejectedCount: number;
  gaps: string[];
  nextAction: StudioCommand | null;
}

export interface StudioFirstUseSummary {
  status: string;
  stage: string;
  stageLabel: string;
  nextStage: string | null;
  nextStageLabel: string | null;
  summary: string;
  evidence: string[];
  gaps: string[];
  nextAction: StudioCommand | null;
  sourceChecklist: StudioSourceChecklistSummary;
}

export interface StudioFirstAnswerRecoverySummary {
  summary: string;
  nextSteps: string[];
  nextActions: StudioCommand[];
}

export interface StudioAlmanacCard {
  almanacId: string;
  displayName: string;
  almanacDir: string;
  health: StudioHealth;
  usability: {
    status: string;
    reason: string;
  };
  manifest: {
    domain: string;
    version: string;
    profile: string;
    compiledAt: string;
  } | null;
  references: {
    extractedKnowledge: number | null;
    tools: number | null;
    retrieval: string | null;
  };
  checks: {
    validation: string;
    answer: string;
    refresh: string;
    registration: string;
  };
  latestHistory: StudioHistorySummary;
  activation: StudioActivationSummary;
  firstUse: StudioFirstUseSummary;
  firstAnswerRecovery: StudioFirstAnswerRecoverySummary | null;
  suggestedQuestions: StudioSuggestedQuestion[];
  issues: string[];
  recommendedOperation: StudioGuidedOperation | null;
  operations: StudioGuidedOperation[];
  nextBestAction: StudioCommand;
  commands: StudioCommand[];
}

const STUDIO_ACTIVATION_MILESTONES = [
  { id: "oriented", label: "Oriented" },
  { id: "planned", label: "Planned" },
  { id: "compiled", label: "Compiled" },
  { id: "validated", label: "Validated" },
  { id: "answer-ready", label: "Answer Ready" },
  { id: "first-answer", label: "First Answer" },
  { id: "replayable", label: "Replayable" },
  { id: "maintainable", label: "Maintainable" },
] as const;

export interface StudioSetupReference {
  url: string;
  addedAt: string;
  via: string;
}

export interface StudioSetupCompileAction {
  state: "runnable" | "handoff" | "blocked";
  label: string;
  reason: string;
  /** CLI fallback command; always copyable regardless of state. */
  command: string;
}

/**
 * Staged goal and references for the next almanac in this root, plus the
 * source checklist they currently satisfy and the derived compile action.
 * Mirrors the state `almanac start` planning reads.
 */
export interface StudioSetupIntake {
  goal: string | null;
  slug: string | null;
  references: StudioSetupReference[];
  checklist: StudioSourceChecklistSummary;
  compile: StudioSetupCompileAction;
}

export interface StudioSnapshot {
  schemaVersion: "0.1.0";
  root: string;
  generatedAt: string;
  /**
   * Derived per request from the Studio server's process environment.
   * Carries env var names only — never credential values.
   */
  providerReadiness: ProviderReadinessReport;
  setupIntake: StudioSetupIntake;
  counts: {
    total: number;
    ok: number;
    attention: number;
    broken: number;
  };
  almanacs: StudioAlmanacCard[];
}

export interface StudioOperationRequest {
  /** True when the browser collected an explicit user confirmation. */
  confirmed: boolean;
}

export interface StartStudioServerOptions {
  host: string;
  port: number;
  loadSnapshot: () => Promise<StudioSnapshot>;
  loadStatus: (almanacId: string) => Promise<StudioAlmanacCard | null>;
  runOperation?: (
    almanacId: string,
    operationId: string,
    request: StudioOperationRequest,
  ) => Promise<unknown>;
  /** Stage a reference for the next almanac. Staging only — never fetches. */
  addSetupReference?: (url: string) => Promise<unknown>;
  /** Stage the natural-language goal for the next almanac. */
  setSetupGoal?: (goal: string) => Promise<unknown>;
  /**
   * Run (or resume) the provider-backed compile for the staged setup. The
   * handler must enforce confirmation, provider readiness, and
   * single-flight; Studio only transports the request.
   */
  runSetupCompile?: (request: StudioOperationRequest) => Promise<unknown>;
  /** Read derived per-stage compile progress for the staged setup. */
  loadSetupCompileStatus?: () => Promise<unknown>;
  /**
   * Run a provider-backed first answer for an almanac and save the answer
   * artifact. The handler must enforce confirmation, provider readiness,
   * and single-flight; Studio only transports the request.
   */
  runFirstAnswer?: (
    almanacId: string,
    request: { question: string; confirmed: boolean },
  ) => Promise<unknown>;
}

export interface StudioServerHandle {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
}

export class StudioServerError extends Error {
  constructor(
    public readonly code: "invalid-host" | "invalid-port" | "server-start-failed",
    message: string,
  ) {
    super(message);
    this.name = "StudioServerError";
  }
}

const LOCAL_STUDIO_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function parseStudioPort(value: string | number | undefined): number {
  if (value === undefined) return 4631;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new StudioServerError(
      "invalid-port",
      `studio port must be an integer between 0 and 65535: ${String(value)}`,
    );
  }
  return parsed;
}

export function assertStudioHost(host: string): void {
  if (!LOCAL_STUDIO_HOSTS.has(host)) {
    throw new StudioServerError(
      "invalid-host",
      `studio only binds to localhost; got ${host}`,
    );
  }
}

export function startStudioServer(
  options: StartStudioServerOptions,
): StudioServerHandle {
  assertStudioHost(options.host);
  parseStudioPort(options.port);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: options.host,
      port: options.port,
      fetch: (request) => handleStudioRequest(request, options),
    });
  } catch (cause) {
    throw new StudioServerError(
      "server-start-failed",
      `could not start studio server: ${(cause as Error).message}`,
    );
  }
  const url = `http://${formatHostForUrl(options.host)}:${server.port}`;
  return {
    url,
    server,
    stop: () => server.stop(true),
  };
}

export function renderStudioHtml(snapshot: StudioSnapshot): string {
  const askRunnable = snapshot.providerReadiness.llm.presence !== "absent";
  const cards =
    snapshot.almanacs.length === 0
      ? `<section class="empty"><h2>No almanacs found</h2><pre>${escapeHtml(
          `almanac demo --root ${snapshot.root}`,
        )}</pre></section>`
      : snapshot.almanacs
          .map((card) => renderAlmanacCard(card, askRunnable))
          .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Almanac Studio</title>
  <style>${studioCss()}</style>
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">Local Studio</p>
      <h1>Almanac</h1>
    </div>
    <div class="root">${escapeHtml(snapshot.root)}</div>
  </header>
  <main>
    <section class="summary" aria-label="Root summary">
      <div><span>${snapshot.counts.total}</span><label>Almanacs</label></div>
      <div><span>${snapshot.counts.ok}</span><label>OK</label></div>
      <div><span>${snapshot.counts.attention}</span><label>Attention</label></div>
      <div><span>${snapshot.counts.broken}</span><label>Broken</label></div>
    </section>
    ${renderProviderReadiness(snapshot.providerReadiness)}
    ${renderSetupIntake(snapshot.setupIntake)}
    <section class="grid" aria-label="Installed almanacs">
      ${cards}
    </section>
  </main>
  <script>${studioJs()}</script>
</body>
</html>`;
}

async function handleStudioRequest(
  request: Request,
  options: StartStudioServerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST") {
    if (url.pathname === "/api/setup/references") {
      if (options.addSetupReference === undefined) {
        return jsonResponse({ error: "setup-intake-unavailable" }, 501);
      }
      const referenceUrl = await readStudioStringField(request, "url");
      if (referenceUrl === null) {
        return jsonResponse(
          {
            error: "invalid-reference-request",
            message: 'request body must be JSON like {"url": "https://..."}',
          },
          400,
        );
      }
      try {
        return jsonResponse(await options.addSetupReference(referenceUrl));
      } catch (cause) {
        return jsonResponse(
          {
            error: "reference-intake-failed",
            message: (cause as Error).message,
          },
          500,
        );
      }
    }
    if (url.pathname === "/api/setup/goal") {
      if (options.setSetupGoal === undefined) {
        return jsonResponse({ error: "setup-intake-unavailable" }, 501);
      }
      const goal = await readStudioStringField(request, "goal");
      if (goal === null) {
        return jsonResponse(
          {
            error: "invalid-goal-request",
            message: 'request body must be JSON like {"goal": "Build an almanac for ..."}',
          },
          400,
        );
      }
      try {
        return jsonResponse(await options.setSetupGoal(goal));
      } catch (cause) {
        return jsonResponse(
          { error: "goal-intake-failed", message: (cause as Error).message },
          500,
        );
      }
    }
    if (url.pathname === "/api/setup/compile") {
      if (options.runSetupCompile === undefined) {
        return jsonResponse({ error: "setup-compile-unavailable" }, 501);
      }
      const operationRequest = await readStudioOperationRequest(request);
      try {
        return jsonResponse(await options.runSetupCompile(operationRequest));
      } catch (cause) {
        return jsonResponse(
          {
            error: "setup-compile-failed",
            message: (cause as Error).message,
          },
          500,
        );
      }
    }
    const askMatch = url.pathname.match(/^\/api\/almanacs\/([^/]+)\/ask$/);
    if (askMatch !== null) {
      if (options.runFirstAnswer === undefined) {
        return jsonResponse({ error: "ask-unavailable" }, 501);
      }
      const almanacId = decodeURIComponent(askMatch[1] ?? "");
      const askRequest = await readStudioAskRequest(request);
      if (askRequest === null) {
        return jsonResponse(
          {
            error: "invalid-ask-request",
            message:
              'request body must be JSON like {"question": "...", "confirm": true}',
          },
          400,
        );
      }
      try {
        return jsonResponse(await options.runFirstAnswer(almanacId, askRequest));
      } catch (cause) {
        return jsonResponse(
          { error: "ask-failed", message: (cause as Error).message },
          500,
        );
      }
    }
    const operationMatch = url.pathname.match(
      /^\/api\/operations\/([^/]+)\/([^/]+)\/run$/,
    );
    if (operationMatch === null) {
      return jsonResponse({ error: "method-not-allowed" }, 405);
    }
    if (options.runOperation === undefined) {
      return jsonResponse({ error: "operation-runner-unavailable" }, 501);
    }
    const almanacId = decodeURIComponent(operationMatch[1] ?? "");
    const operationId = decodeURIComponent(operationMatch[2] ?? "");
    const operationRequest = await readStudioOperationRequest(request);
    try {
      return jsonResponse(
        await options.runOperation(almanacId, operationId, operationRequest),
      );
    } catch (cause) {
      return jsonResponse(
        {
          error: "operation-run-failed",
          message: (cause as Error).message,
        },
        500,
      );
    }
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "method-not-allowed" }, 405);
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const snapshot = await options.loadSnapshot();
    return new Response(renderStudioHtml(snapshot), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/api/inventory") {
    return jsonResponse(await options.loadSnapshot());
  }
  if (url.pathname === "/api/setup/compile/status") {
    if (options.loadSetupCompileStatus === undefined) {
      return jsonResponse({ error: "setup-compile-unavailable" }, 501);
    }
    return jsonResponse(await options.loadSetupCompileStatus());
  }
  const statusMatch = url.pathname.match(/^\/api\/status\/([^/]+)$/);
  if (statusMatch !== null) {
    const almanacId = decodeURIComponent(statusMatch[1] ?? "");
    const status = await options.loadStatus(almanacId);
    if (status === null) {
      return jsonResponse({ error: "almanac-not-found", almanacId }, 404);
    }
    return jsonResponse(status);
  }
  return jsonResponse({ error: "not-found" }, 404);
}

/**
 * Parse the optional JSON body of an operation POST. A missing, empty, or
 * malformed body counts as unconfirmed — confirmation must be explicit.
 */
async function readStudioOperationRequest(
  request: Request,
): Promise<StudioOperationRequest> {
  try {
    const body = (await request.json()) as { confirm?: unknown } | null;
    return { confirmed: body !== null && body.confirm === true };
  } catch {
    return { confirmed: false };
  }
}

/** Parse an ask submission body; null when it is not a usable request. */
async function readStudioAskRequest(
  request: Request,
): Promise<{ question: string; confirmed: boolean } | null> {
  try {
    const body = (await request.json()) as {
      question?: unknown;
      confirm?: unknown;
    } | null;
    if (body === null || typeof body.question !== "string") return null;
    return { question: body.question, confirmed: body.confirm === true };
  } catch {
    return null;
  }
}

/** Parse a string field from a JSON body; null when it is not usable. */
async function readStudioStringField(
  request: Request,
  field: string,
): Promise<string | null> {
  try {
    const body = (await request.json()) as Record<string, unknown> | null;
    if (body === null) return null;
    const value = body[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function renderAlmanacCard(
  card: StudioAlmanacCard,
  askRunnable = false,
): string {
  const issueList =
    card.issues.length === 0
      ? `<li class="muted">No issues</li>`
      : card.issues
          .slice(0, 4)
          .map((issue) => `<li>${escapeHtml(issue)}</li>`)
          .join("");
  const commands = [card.nextBestAction, ...card.commands]
    .filter(uniqueCommand)
    .slice(0, 5)
    .map(renderCommand)
    .join("\n");
  const operations =
    card.operations.length === 0
      ? `<p class="muted">No guided operations available</p>`
      : card.operations
          .slice(0, 6)
          .map((operation) => renderGuidedOperation(card.almanacId, operation))
          .join("\n");
  const suggestedQuestions =
    card.suggestedQuestions.length === 0
      ? `<p class="muted">No suggested questions available</p>`
      : card.suggestedQuestions
          .slice(0, 3)
          .map((question) =>
            renderSuggestedQuestion(card.almanacId, question, askRunnable),
          )
          .join("\n");
  const activation = renderActivation(card.activation);
  const firstUse = renderFirstUse(card.firstUse);
  const firstAnswerRecovery = renderFirstAnswerRecovery(
    card.firstAnswerRecovery,
  );
  return `<article class="card" data-health="${escapeHtml(card.health)}">
  <div class="card-header">
    <div>
      <h2>${escapeHtml(card.displayName)}</h2>
      <p>${escapeHtml(card.almanacId)}</p>
    </div>
    <span class="badge">${escapeHtml(card.health)}</span>
  </div>
  <dl class="meta">
    <div><dt>Domain</dt><dd>${escapeHtml(card.manifest?.domain ?? "-")}</dd></div>
    <div><dt>Knowledge</dt><dd>${formatCount(card.references.extractedKnowledge)} / ${formatCount(card.references.tools)} tools</dd></div>
    <div><dt>Retrieval</dt><dd>${escapeHtml(card.references.retrieval ?? "unknown")}</dd></div>
    <div><dt>Validation</dt><dd>${escapeHtml(card.checks.validation)}</dd></div>
    <div><dt>Answer</dt><dd>${escapeHtml(card.checks.answer)}</dd></div>
    <div><dt>Refresh</dt><dd>${escapeHtml(card.checks.refresh)}</dd></div>
    <div><dt>Registration</dt><dd>${escapeHtml(card.checks.registration)}</dd></div>
    <div><dt>Activation</dt><dd>${escapeHtml(card.activation.summary)}</dd></div>
    <div><dt>First Use</dt><dd>${escapeHtml(card.firstUse.summary)}</dd></div>
    <div><dt>Latest</dt><dd>${escapeHtml(card.latestHistory.latest)}</dd></div>
  </dl>
  <section>
    <h3>Activation</h3>
    ${activation}
  </section>
  <section>
    <h3>First Use</h3>
    ${firstUse}
  </section>
  <section>
    <h3>Answer Recovery</h3>
    ${firstAnswerRecovery}
  </section>
  <section>
    <h3>Next Action</h3>
    ${renderCommand(card.nextBestAction)}
  </section>
  <section>
    <h3>Guided Operations</h3>
    ${operations}
  </section>
  <section>
    <h3>Suggested Questions</h3>
    ${suggestedQuestions}
  </section>
  <section>
    <h3>Issues</h3>
    <ul>${issueList}</ul>
  </section>
  <section>
    <h3>Commands</h3>
    ${commands}
  </section>
</article>`;
}

function renderProviderReadiness(readiness: ProviderReadinessReport): string {
  const chips = readiness.capabilities
    .map(
      (capability) =>
        `<li data-capability-status="${escapeAttribute(capability.status)}" title="${escapeAttribute(capability.detail)}">${escapeHtml(capability.label)}: ${escapeHtml(capability.status)}</li>`,
    )
    .join("");
  return `<section class="providers" aria-label="Provider readiness">
  <div class="providers-head">
    <strong>Providers</strong>
    <span>${escapeHtml(summarizeProviderReadiness(readiness))}</span>
  </div>
  <ul class="capabilities">${chips}</ul>
  <p class="muted">Detected from the Studio server environment. Keys are never shown or stored; locked operations stay copyable CLI handoff.</p>
</section>`;
}

function renderSetupIntake(intake: StudioSetupIntake): string {
  const references =
    intake.references.length === 0
      ? `<li class="muted">No references staged yet</li>`
      : intake.references
          .map(
            (reference) =>
              `<li><code>${escapeHtml(reference.url)}</code> <span class="muted">(${escapeHtml(reference.via)})</span></li>`,
          )
          .join("");
  const gaps =
    intake.checklist.gaps.length === 0
      ? ""
      : `<ul>${intake.checklist.gaps
          .slice(0, 3)
          .map((gap) => `<li>${escapeHtml(gap)}</li>`)
          .join("")}</ul>`;
  const compileButton =
    intake.compile.state === "runnable"
      ? `<button type="button" data-setup-compile data-compile-label="${escapeAttribute(intake.compile.label)}">${escapeHtml(intake.compile.label)}</button>`
      : "";
  return `<section class="providers setup-intake" aria-label="Reference intake">
  <div class="providers-head">
    <strong>Plan a new almanac</strong>
    <span data-setup-checklist-status="${escapeAttribute(intake.checklist.status)}">${escapeHtml(intake.checklist.summary)}</span>
  </div>
  <form data-setup-goal-form>
    <input type="text" name="goal" placeholder="Build an almanac for ..." aria-label="Almanac goal" value="${escapeAttribute(intake.goal ?? "")}" required>
    <button type="submit">${intake.goal === null ? "Set goal" : "Update goal"}</button>
  </form>
  <form data-setup-reference-form>
    <input type="url" name="url" placeholder="https://docs.example.com/... or /path/to/notes.md" aria-label="Reference URL or file path" required>
    <button type="submit">Add reference</button>
  </form>
  <div class="setup-intake-result" data-setup-reference-result role="status" aria-live="polite"></div>
  <ul class="setup-references">${references}</ul>
  ${gaps}
  <div class="setup-compile" data-compile-state="${escapeAttribute(intake.compile.state)}">
    <div class="command-meta">
      <strong>${escapeHtml(intake.compile.label)}</strong>
      <span>provider key</span>
      <span>${escapeHtml(intake.compile.state)}</span>
    </div>
    <p>${escapeHtml(intake.compile.reason)}</p>
    <pre><code>${escapeHtml(intake.compile.command)}</code></pre>
    <div class="command-actions">
      ${compileButton}
      <button type="button" data-copy="${escapeAttribute(intake.compile.command)}">Copy</button>
    </div>
    <div class="setup-intake-result" data-setup-compile-result role="status" aria-live="polite"></div>
  </div>
  <p class="muted">Staged references feed the source checklist that <code>almanac start</code> reads. Nothing is fetched until a provider-backed compile runs.</p>
</section>`;
}

function renderActivation(activation: StudioActivationSummary): string {
  const currentIndex = STUDIO_ACTIVATION_MILESTONES.findIndex(
    (milestone) => milestone.id === activation.milestone,
  );
  const milestones = STUDIO_ACTIVATION_MILESTONES.map((milestone, index) => {
    const state =
      currentIndex >= 0 && index <= currentIndex
        ? "done"
        : milestone.id === activation.nextMilestone
          ? "next"
          : "todo";
    return `<li data-state="${state}">${escapeHtml(milestone.label)}</li>`;
  }).join("");
  const details = [
    ...activation.gaps.slice(0, 2).map((gap) => `Gap: ${gap}`),
    ...activation.evidence.slice(0, 1).map((item) => `Evidence: ${item}`),
  ];
  const detailList =
    details.length === 0
      ? `<li class="muted">No activation details</li>`
      : details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("");
  const next =
    activation.nextAction === null
      ? `<p class="muted">No activation command needed</p>`
      : renderCommand(activation.nextAction);
  return `<div class="activation">
  <div class="activation-head">
    <strong>${escapeHtml(activation.milestoneLabel)}</strong>
    <span>${escapeHtml(activation.status)}</span>
  </div>
  <p>${escapeHtml(activation.summary)}</p>
  <ol class="milestones">${milestones}</ol>
  <ul>${detailList}</ul>
  ${next}
</div>`;
}

function renderFirstAnswerRecovery(
  recovery: StudioFirstAnswerRecoverySummary | null,
): string {
  if (recovery === null) {
    return `<p class="muted">No answer recovery needed</p>`;
  }
  const steps =
    recovery.nextSteps.length === 0
      ? `<li class="muted">No recovery steps</li>`
      : recovery.nextSteps
          .slice(0, 4)
          .map((step) => `<li>${escapeHtml(step)}</li>`)
          .join("");
  const commands =
    recovery.nextActions.length === 0
      ? ""
      : recovery.nextActions
          .slice(0, 2)
          .map((command) => `<div class="secondary-action">${renderCommand(command)}</div>`)
          .join("");
  return `<div class="activation">
  <p>${escapeHtml(recovery.summary)}</p>
  <ul>${steps}</ul>
  ${commands}
</div>`;
}

function renderFirstUse(firstUse: StudioFirstUseSummary): string {
  const details = [
    `References: ${firstUse.sourceChecklist.summary}`,
    ...firstUse.gaps.slice(0, 2).map((gap) => `Gap: ${gap}`),
    ...firstUse.evidence.slice(0, 1).map((item) => `Evidence: ${item}`),
  ];
  const detailList =
    details.length === 0
      ? `<li class="muted">No first-use details</li>`
      : details.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const next =
    firstUse.nextAction === null
      ? `<p class="muted">No first-use command needed</p>`
      : renderCommand(firstUse.nextAction);
  const referenceNext =
    firstUse.sourceChecklist.nextAction === null
      ? ""
      : `<div class="secondary-action">${renderCommand(firstUse.sourceChecklist.nextAction)}</div>`;
  const nextStage =
    firstUse.nextStageLabel === null
      ? "Complete"
      : `Next: ${firstUse.nextStageLabel}`;
  return `<div class="activation">
  <div class="activation-head">
    <strong>${escapeHtml(firstUse.stageLabel)}</strong>
    <span>${escapeHtml(firstUse.status)}</span>
  </div>
  <p>${escapeHtml(firstUse.summary)} (${escapeHtml(nextStage)})</p>
  <ul>${detailList}</ul>
  ${referenceNext}
  ${next}
</div>`;
}

function renderGuidedOperation(
  almanacId: string,
  operation: StudioGuidedOperation,
): string {
  const runnable = operation.studioRunnable ? "studio runnable" : "CLI handoff";
  const provider = operation.providerRequired ? "provider key" : "no key";
  const blocked =
    operation.blockedReason === null
      ? ""
      : `<p>${escapeHtml(operation.blockedReason)}</p>`;
  const runButton = operation.studioRunnable
    ? `<button type="button" data-run-operation="${escapeAttribute(operation.id)}" data-almanac-id="${escapeAttribute(almanacId)}" data-confirmation="${operation.confirmation ? "true" : "false"}" data-command="${escapeAttribute(operation.command)}" data-operation-label="${escapeAttribute(operation.label)}">Run</button>`
    : "";
  return `<div class="command" data-operation="${escapeAttribute(operation.id)}">
  <div class="command-meta">
    <strong>${escapeHtml(operation.label)}</strong>
    <span>${escapeHtml(operation.category)}</span>
    <span>${escapeHtml(operation.mutation)}</span>
    <span>${provider}</span>
    <span>${runnable}</span>
  </div>
  <p>${escapeHtml(operation.description)}</p>
  ${blocked}
  <pre><code>${escapeHtml(operation.command)}</code></pre>
  <div class="command-actions">
    ${runButton}
    <button type="button" data-copy="${escapeAttribute(operation.command)}">Copy</button>
  </div>
  <div class="operation-result" data-operation-result="${escapeAttribute(operation.id)}" role="status" aria-live="polite"></div>
</div>`;
}

function renderSuggestedQuestion(
  almanacId: string,
  question: StudioSuggestedQuestion,
  askRunnable: boolean,
): string {
  const askButton = askRunnable
    ? `<button type="button" data-ask-question="${escapeAttribute(question.question)}" data-almanac-id="${escapeAttribute(almanacId)}">Ask</button>`
    : "";
  return `<div class="question">
  <div class="command-meta">
    <strong>${escapeHtml(question.intent)}</strong>
    <span>provider key</span>
    <span>${askRunnable ? "studio runnable" : "CLI handoff"}</span>
  </div>
  <p>${escapeHtml(question.question)}</p>
  <pre><code>${escapeHtml(question.saveCommand)}</code></pre>
  <div class="command-actions">
    ${askButton}
    <button type="button" data-copy="${escapeAttribute(question.saveCommand)}">Copy</button>
  </div>
  <div class="operation-result" data-ask-result role="status" aria-live="polite"></div>
</div>`;
}

function renderCommand(command: StudioCommand): string {
  const mutation = command.mutates ? "mutating" : "read-only";
  const provider = command.providerRequired ? "provider key" : "no key";
  return `<div class="command">
  <div class="command-meta">
    <strong>${escapeHtml(command.label)}</strong>
    <span>${mutation}</span>
    <span>${provider}</span>
  </div>
  ${
    command.reason === undefined
      ? ""
      : `<p>${escapeHtml(command.reason)}</p>`
  }
  <pre><code>${escapeHtml(command.command)}</code></pre>
  <div class="command-actions">
    <button type="button" data-copy="${escapeAttribute(command.command)}">Copy</button>
  </div>
</div>`;
}

function uniqueCommand(
  command: StudioCommand,
  index: number,
  commands: StudioCommand[],
): boolean {
  return commands.findIndex((item) => item.command === command.command) === index;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function formatHostForUrl(host: string): string {
  return host === "::1" ? "[::1]" : host;
}

function formatCount(value: number | null): string {
  return value === null ? "-" : String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function studioCss(): string {
  return `
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f8;color:#1c2528}
body{margin:0}
header{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;padding:28px 32px;border-bottom:1px solid #d9dedf;background:#ffffff}
h1,h2,h3,p{margin:0}
h1{font-size:30px;font-weight:700}
h2{font-size:18px}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#526064;margin-bottom:10px}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#526064;margin-bottom:4px}
.root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#526064;word-break:break-all;text-align:right}
main{padding:24px 32px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.summary div{background:#ffffff;border:1px solid #d9dedf;border-radius:8px;padding:14px}
.summary span{display:block;font-size:26px;font-weight:700}
.summary label{font-size:12px;color:#526064}
.providers{background:#ffffff;border:1px solid #d9dedf;border-radius:8px;padding:14px;margin-bottom:20px}
.providers-head{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.providers-head span{font-size:12px;color:#526064}
.providers .muted{font-size:12px;margin-top:8px}
.capabilities{display:flex;gap:6px;flex-wrap:wrap;list-style:none;margin:10px 0 0;padding:0}
.capabilities li{border:1px solid #b8c1c4;border-radius:999px;padding:3px 9px;font-size:12px;color:#526064}
.capabilities [data-capability-status="unlocked"]{border-color:#5e8f63;color:#27632d;background:#edf7ee}
.capabilities [data-capability-status="mock-only"]{border-color:#9d8358;color:#704d18;background:#fff7e8}
.setup-intake form{display:flex;gap:8px;margin-top:10px}
.setup-intake input{flex:1;border:1px solid #9aa7aa;border-radius:6px;padding:5px 8px;font-size:13px;background:#ffffff;color:inherit}
.setup-references{list-style:none;margin:10px 0 0;padding:0;font-size:13px}
.setup-references li{margin-bottom:4px;word-break:break-all}
.setup-intake-result:empty{display:none}
.setup-intake-result{border:1px solid #d9dedf;border-radius:6px;margin-top:8px;padding:8px;font-size:12px}
.setup-intake-result[data-status="rejected"],.setup-intake-result[data-status="error"]{border-color:#b66a67;background:#fff0ef}
.setup-intake-result[data-status="duplicate"]{border-color:#9d8358;background:#fff7e8}
.setup-intake-result[data-status="failed"],.setup-intake-result[data-status="blocked"]{border-color:#b66a67;background:#fff0ef}
.setup-compile{border:1px solid #d9dedf;border-radius:8px;padding:10px;background:#fbfcfc;margin-top:10px}
.setup-compile[data-compile-state="runnable"]{border-color:#5e8f63}
.setup-compile p{font-size:12px;color:#526064;margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
.card{background:#ffffff;border:1px solid #d9dedf;border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:16px}
.card-header{display:flex;justify-content:space-between;gap:12px}
.card-header p{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#526064;font-size:12px;margin-top:2px}
.badge{border:1px solid #b8c1c4;border-radius:999px;padding:3px 9px;font-size:12px;height:max-content}
[data-health="ok"] .badge{border-color:#5e8f63;color:#27632d;background:#edf7ee}
[data-health="broken"] .badge,[data-health="failed"] .badge{border-color:#b66a67;color:#8d2924;background:#fff0ef}
.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0}
.meta div{min-width:0}
dt{font-size:11px;color:#526064;text-transform:uppercase;letter-spacing:.06em}
dd{margin:2px 0 0;font-size:13px;word-break:break-word}
ul{margin:0;padding-left:18px;font-size:13px}
.muted{color:#526064}
.activation{border:1px solid #d9dedf;border-radius:8px;padding:10px;background:#fbfcfc}
.activation-head{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:13px}
.activation-head span{border:1px solid #b8c1c4;border-radius:999px;padding:2px 8px;font-size:12px;color:#526064}
.activation p{font-size:12px;color:#526064;margin-top:6px}
.milestones{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;list-style:none;margin:10px 0;padding:0}
.milestones li{border:1px solid #d9dedf;border-radius:6px;padding:5px 6px;font-size:11px;text-align:center;color:#526064}
.milestones [data-state="done"]{border-color:#5e8f63;color:#27632d;background:#edf7ee}
.milestones [data-state="next"]{border-color:#9d8358;color:#704d18;background:#fff7e8}
.command,.question{position:relative;border:1px solid #d9dedf;border-radius:8px;padding:10px;background:#fbfcfc;margin-bottom:8px}
.command-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:#526064}
.command-meta strong{color:#1c2528}
.command p,.question p{font-size:12px;color:#526064;margin-top:6px}
pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.45;background:#eef1f2;border-radius:6px;padding:9px}
.command-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
button{border:1px solid #9aa7aa;background:#ffffff;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer}
button[disabled]{cursor:not-allowed;opacity:.65}
.operation-result:empty{display:none}
.operation-result{border:1px solid #d9dedf;border-radius:8px;background:#ffffff;margin-top:8px;padding:9px;font-size:12px}
.operation-result strong{display:block;margin-bottom:4px}
.operation-result p{margin-top:4px}
.operation-result ul{margin-top:4px}
.operation-result[data-status="ok"]{border-color:#5e8f63;background:#f5fbf6}
.operation-result[data-status="attention"]{border-color:#9d8358;background:#fff9ed}
.operation-result[data-status="failed"],.operation-result[data-status="blocked"]{border-color:#b66a67;background:#fff5f4}
.empty{background:#ffffff;border:1px solid #d9dedf;border-radius:8px;padding:18px}
@media (max-width:720px){header{align-items:flex-start;flex-direction:column;padding:22px 18px}.root{text-align:left}main{padding:18px}.grid{grid-template-columns:1fr}.meta{grid-template-columns:1fr}}
@media (prefers-color-scheme:dark){:root{background:#111618;color:#edf1f2}header,.summary div,.card,.empty,.providers{background:#182023;border-color:#334044}.providers-head span{color:#a8b4b8}.capabilities li{border-color:#334044;color:#a8b4b8}.capabilities [data-capability-status="unlocked"]{background:#152916;color:#8dd394;border-color:#47794d}.capabilities [data-capability-status="mock-only"]{background:#2c2415;color:#e4c07d;border-color:#8b6b35}.root,.eyebrow,.summary label,h3,dt,.muted,.card-header p,.command-meta,.command p,.question p,.activation p,.activation-head span{color:#a8b4b8}.command,.question,.activation{background:#151c1f;border-color:#334044}.command-meta strong,.activation-head strong{color:#edf1f2}.milestones li{border-color:#334044;color:#a8b4b8}.milestones [data-state="done"]{background:#152916;color:#8dd394;border-color:#47794d}.milestones [data-state="next"]{background:#2c2415;color:#e4c07d;border-color:#8b6b35}pre{background:#0e1315}button{background:#1d272a;color:#edf1f2;border-color:#59686d}.operation-result{background:#182023;border-color:#334044}.operation-result[data-status="ok"]{background:#142417;border-color:#47794d}.operation-result[data-status="attention"]{background:#2b2416;border-color:#8b6b35}.operation-result[data-status="failed"],.operation-result[data-status="blocked"]{background:#2d1716;border-color:#8c4e4a}[data-health="ok"] .badge{background:#152916;color:#8dd394;border-color:#47794d}[data-health="broken"] .badge,[data-health="failed"] .badge{background:#321a19;color:#e19a96;border-color:#8c4e4a}}
`;
}

function studioJs(): string {
  return `
document.addEventListener("submit", async (event) => {
  const referenceForm = event.target.closest("form[data-setup-reference-form]");
  const goalForm = event.target.closest("form[data-setup-goal-form]");
  if (!referenceForm && !goalForm) return;
  event.preventDefault();
  const result = document.querySelector("[data-setup-reference-result]");
  const endpoint = referenceForm ? "/api/setup/references" : "/api/setup/goal";
  const field = referenceForm ? "url" : "goal";
  const form = referenceForm || goalForm;
  const input = form.querySelector("input[name=" + field + "]");
  const value = input && input.value ? input.value.trim() : "";
  if (!value) return;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: value })
    });
    const body = await response.json();
    if (body.status === "accepted" || body.status === "saved") {
      window.location.reload();
      return;
    }
    setSetupResult(result, body.status || "error",
      body.reason || body.message || "Input was not staged.");
  } catch (error) {
    setSetupResult(result, "error",
      error && error.message ? error.message : "Setup intake failed.");
  }
});

function setSetupResult(container, status, message) {
  if (!container) return;
  container.setAttribute("data-status", status);
  container.textContent = status + ": " + message;
}

async function runSetupCompile(button) {
  const label = button.getAttribute("data-compile-label") || "Compile";
  const confirmed = window.confirm(
    label + "?\\n\\nThis calls your configured AI provider (it may incur cost), " +
    "reads the staged references through the compile pipeline, and writes " +
    "almanac files under this root."
  );
  if (!confirmed) return;
  const result = document.querySelector("[data-setup-compile-result]");
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Compiling";
  setSetupResult(result, "running", "Compile started; watching stage progress.");
  const progress = setInterval(async () => {
    try {
      const response = await fetch("/api/setup/compile/status");
      const body = await response.json();
      if (body && body.exists && body.counts) {
        setSetupResult(result, "running",
          "stage progress: " + body.counts.completed + "/" + body.counts.total +
          " completed" + (body.currentStage ? ", running " + body.currentStage : ""));
      }
    } catch {}
  }, 2000);
  try {
    const response = await fetch("/api/setup/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    const body = await response.json();
    if (body.status === "ok") {
      window.location.reload();
      return;
    }
    setSetupResult(result, body.status || "error",
      (body.summary || body.message || "Compile did not complete.") +
      (body.recovery && body.recovery.resumeCommand
        ? " — resume: " + body.recovery.resumeCommand
        : ""));
  } catch (error) {
    setSetupResult(result, "error",
      error && error.message ? error.message : "Compile request failed.");
  } finally {
    clearInterval(progress);
    button.disabled = false;
    button.textContent = originalText;
  }
}

document.addEventListener("click", async (event) => {
  const compileButton = event.target.closest("button[data-setup-compile]");
  if (compileButton) {
    await runSetupCompile(compileButton);
    return;
  }
  const askButton = event.target.closest("button[data-ask-question]");
  if (askButton) {
    await askQuestion(askButton);
    return;
  }
  const runButton = event.target.closest("button[data-run-operation]");
  if (runButton) {
    await runOperation(runButton);
    return;
  }
  const button = event.target.closest("button[data-copy]");
  if (!button) return;
  const command = button.getAttribute("data-copy");
  try {
    await navigator.clipboard.writeText(command);
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1200);
  } catch {
    button.textContent = "Select";
  }
});

async function askQuestion(button) {
  const question = button.getAttribute("data-ask-question") || "";
  const almanacId = button.getAttribute("data-almanac-id") || "";
  if (!question || !almanacId) return;
  const confirmed = window.confirm(
    "Ask \\"" + question + "\\"?\\n\\nThis calls your configured AI provider " +
    "(it may incur cost) and saves the answer artifact for replay and checks."
  );
  if (!confirmed) return;
  const panel = button.closest(".question");
  const result = panel ? panel.querySelector("[data-ask-result]") : null;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Asking";
  try {
    const response = await fetch(
      "/api/almanacs/" + encodeURIComponent(almanacId) + "/ask",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, confirm: true })
      }
    );
    const body = await response.json();
    renderAskResult(result, body);
  } catch (error) {
    renderAskResult(result, {
      status: "failed",
      summary: error && error.message ? error.message : "Ask request failed."
    });
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function renderAskResult(container, body) {
  if (!container) return;
  const status = body.status || "unknown";
  container.setAttribute("data-status",
    status === "ok" ? "ok" : status === "abstained" ? "attention" : "failed");
  const parts = ['<strong>Status: ' + escapeHtml(status) + '</strong>'];
  if (body.answer) {
    parts.push('<p>' + escapeHtml(body.answer) + '</p>');
  }
  if (body.abstentionReason) {
    parts.push('<p>Abstained: ' + escapeHtml(body.abstentionReason) + '</p>');
  }
  if (body.summary && !body.answer && !body.abstentionReason) {
    parts.push('<p>' + escapeHtml(body.summary) + '</p>');
  }
  if (Array.isArray(body.citations) && body.citations.length > 0) {
    parts.push('<ul>' + body.citations.map((citation) =>
      '<li>' + escapeHtml(citation.sourceId + ': ' + citation.url) + '</li>'
    ).join("") + '</ul>');
  }
  if (body.freshness) {
    parts.push('<p class="muted">Freshness: ' +
      escapeHtml(body.freshness.class + '/' + body.freshness.staleness) + '</p>');
  }
  if (body.guidance && body.guidance.recovery) {
    parts.push('<p>' + escapeHtml(body.guidance.recovery.summary) + '</p>');
    const steps = body.guidance.recovery.nextSteps || [];
    if (steps.length > 0) {
      parts.push('<ul>' + steps.map((step) =>
        '<li>' + escapeHtml(step) + '</li>').join("") + '</ul>');
    }
  }
  if (body.artifactRelPath) {
    parts.push('<p class="muted">Saved: ' + escapeHtml(body.artifactRelPath) +
      ' — refresh the page to see promotion operations.</p>');
  }
  container.innerHTML = parts.join("");
}

async function runOperation(button) {
  const operationId = button.getAttribute("data-run-operation");
  const almanacId = button.getAttribute("data-almanac-id");
  const command = button.getAttribute("data-command") || "";
  const label = button.getAttribute("data-operation-label") || operationId;
  const needsConfirmation = button.getAttribute("data-confirmation") === "true";
  if (needsConfirmation && !window.confirm("Run " + label + "?")) return;

  const panel = button.closest("[data-operation]");
  const result = panel ? panel.querySelector("[data-operation-result]") : null;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Running";
  setOperationResult(result, {
    status: "running",
    summary: "Operation is running.",
    artifactsWritten: [],
    nextOperation: null
  }, command);

  try {
    const response = await fetch(
      "/api/operations/" + encodeURIComponent(almanacId) + "/" +
        encodeURIComponent(operationId) + "/run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: needsConfirmation })
      }
    );
    const body = await response.json();
    if (!response.ok && body.status === undefined) {
      body.status = "failed";
      body.summary = body.message || body.error || "Operation failed.";
    }
    setOperationResult(result, body, command);
  } catch (error) {
    setOperationResult(result, {
      status: "failed",
      summary: error && error.message ? error.message : "Operation failed.",
      artifactsWritten: [],
      nextOperation: null
    }, command);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function setOperationResult(container, result, fallbackCommand) {
  if (!container) return;
  const status = result.status || "unknown";
  const artifacts = Array.isArray(result.artifactsWritten)
    ? result.artifactsWritten
    : [];
  const artifactHtml = artifacts.length === 0
    ? '<p class="muted">No artifacts written</p>'
    : '<ul>' + artifacts.map((item) => '<li>' + escapeHtml(String(item)) + '</li>').join("") + '</ul>';
  const nextOperation = result.nextOperation
    ? '<p>Next: ' + escapeHtml(result.nextOperation.label || result.nextOperation.id || "guided operation") + '</p>'
    : '<p class="muted">No next operation returned</p>';
  container.setAttribute("data-status", status);
  container.innerHTML =
    '<strong>Status: ' + escapeHtml(status) + '</strong>' +
    '<p>' + escapeHtml(result.summary || "Operation completed.") + '</p>' +
    artifactHtml +
    nextOperation +
    '<p class="muted">Fallback command</p>' +
    '<pre><code>' + escapeHtml(fallbackCommand) + '</code></pre>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
`;
}
