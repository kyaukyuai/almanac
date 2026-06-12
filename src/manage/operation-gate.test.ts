import { describe, expect, test } from "bun:test";

import {
  AlmanacOperationLocks,
  operationGateBlockReason,
} from "./operation-gate.ts";
import { deriveProviderReadiness } from "./provider-readiness.ts";

const noProvider = deriveProviderReadiness({});
const anthropic = deriveProviderReadiness({ ANTHROPIC_API_KEY: "sk-ant-test" });
const mock = deriveProviderReadiness({ ALMANAC_LLM: "mock" });

describe("operation gate", () => {
  test("cli requests count as confirmed", () => {
    expect(
      operationGateBlockReason({
        providerRequired: false,
        confirmationRequired: true,
        request: { source: "cli", confirmed: false },
        readiness: noProvider,
      }),
    ).toBeNull();
  });

  test("studio requests need explicit confirmation for confirmation-required operations", () => {
    expect(
      operationGateBlockReason({
        providerRequired: false,
        confirmationRequired: true,
        request: { source: "studio", confirmed: false },
        readiness: noProvider,
      }),
    ).toContain("explicit confirmation");
    expect(
      operationGateBlockReason({
        providerRequired: false,
        confirmationRequired: true,
        request: { source: "studio", confirmed: true },
        readiness: noProvider,
      }),
    ).toBeNull();
    expect(
      operationGateBlockReason({
        providerRequired: false,
        confirmationRequired: false,
        request: { source: "studio", confirmed: false },
        readiness: noProvider,
      }),
    ).toBeNull();
  });

  test("provider-backed operations require both confirmation and readiness", () => {
    expect(
      operationGateBlockReason({
        providerRequired: true,
        confirmationRequired: false,
        request: { source: "studio", confirmed: false },
        readiness: anthropic,
      }),
    ).toContain("explicit confirmation");
    expect(
      operationGateBlockReason({
        providerRequired: true,
        confirmationRequired: true,
        request: { source: "studio", confirmed: true },
        readiness: noProvider,
      }),
    ).toContain("set ANTHROPIC_API_KEY");
    expect(
      operationGateBlockReason({
        providerRequired: true,
        confirmationRequired: true,
        request: { source: "cli", confirmed: false },
        readiness: noProvider,
      }),
    ).toContain("set ANTHROPIC_API_KEY");
    expect(
      operationGateBlockReason({
        providerRequired: true,
        confirmationRequired: true,
        request: { source: "studio", confirmed: true },
        readiness: anthropic,
      }),
    ).toBeNull();
    expect(
      operationGateBlockReason({
        providerRequired: true,
        confirmationRequired: true,
        request: { source: "cli", confirmed: true },
        readiness: mock,
      }),
    ).toBeNull();
  });

  test("locks are single-flight per key and release cleanly", () => {
    const locks = new AlmanacOperationLocks();
    const key = locks.key("/tmp/root", "sqlite-demo");
    const other = locks.key("/tmp/root", "other-almanac");

    expect(locks.tryAcquire(key)).toBe(true);
    expect(locks.isRunning(key)).toBe(true);
    expect(locks.tryAcquire(key)).toBe(false);
    expect(locks.tryAcquire(other)).toBe(true);

    locks.release(key);
    expect(locks.isRunning(key)).toBe(false);
    expect(locks.tryAcquire(key)).toBe(true);
  });
});
