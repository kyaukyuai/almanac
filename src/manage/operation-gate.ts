/**
 * Execution gate for guided operations.
 *
 * The operation runner asks this module two questions before executing
 * anything:
 *
 *   1. Is this request allowed to run at all (confirmation + provider
 *      readiness)?
 *   2. Is another operation already running for the same almanac
 *      (single-flight)?
 *
 * CLI invocations are explicit by construction — the user typed the
 * command — so they count as confirmed. Studio requests must carry an
 * explicit confirmation, which the browser collects before POSTing.
 * Provider-backed operations additionally require a detected provider;
 * the gate never reads credential values, only the derived readiness
 * report.
 */

import type { ProviderReadinessReport } from "./provider-readiness.ts";

export type OperationRunSource = "cli" | "studio";

export interface OperationRunRequest {
  source: OperationRunSource;
  /** True when the request carried an explicit user confirmation. */
  confirmed: boolean;
}

export interface OperationGateInput {
  providerRequired: boolean;
  confirmationRequired: boolean;
  request: OperationRunRequest;
  readiness: ProviderReadinessReport;
}

/**
 * Returns a user-facing block reason, or null when the request may proceed
 * to the runner's own support checks.
 */
export function operationGateBlockReason(
  input: OperationGateInput,
): string | null {
  const confirmed = input.request.source === "cli" || input.request.confirmed;
  if (input.confirmationRequired && !confirmed) {
    return "operation requires explicit confirmation before it runs";
  }
  if (input.providerRequired) {
    if (!confirmed) {
      return "provider-backed operation requires explicit confirmation";
    }
    if (input.readiness.llm.presence === "absent") {
      return (
        "provider-backed operation is locked: set ANTHROPIC_API_KEY in the " +
        "environment that starts the CLI or Studio"
      );
    }
  }
  return null;
}

/**
 * In-process single-flight guard, keyed per almanac. One Studio server (or
 * CLI process) never runs two guided operations against the same almanac
 * concurrently; a second request is blocked instead of queued.
 */
export class AlmanacOperationLocks {
  private readonly running = new Set<string>();

  key(root: string, almanacId: string): string {
    return `${root}::${almanacId}`;
  }

  tryAcquire(key: string): boolean {
    if (this.running.has(key)) return false;
    this.running.add(key);
    return true;
  }

  release(key: string): void {
    this.running.delete(key);
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }
}

export const OPERATION_ALREADY_RUNNING_REASON =
  "another guided operation is already running for this almanac";
