/**
 * Provider-neutral embedding interface.
 *
 * v0.4 introduces this as an internal seam only: no retrieval behavior changes
 * until vector index artifacts and hybrid search land in later PRs.
 */

import { createHash } from "node:crypto";

export type EmbeddingProviderKind =
  | "voyage"
  | "openai"
  | "local"
  | "deterministic";

export interface EmbeddingModelIdentity {
  provider: EmbeddingProviderKind;
  model: string;
  dimensions: number;
  revision?: string;
}

export interface EmbeddingInput {
  id: string;
  text: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface EmbeddingRequest {
  inputs: readonly EmbeddingInput[];
}

export interface EmbeddingVector {
  inputId: string;
  values: readonly number[];
  dimensions: number;
}

export interface EmbeddingUsage {
  inputCount: number;
  inputCharacters: number;
}

export interface EmbeddingResponse {
  model: EmbeddingModelIdentity;
  vectors: readonly EmbeddingVector[];
  usage: EmbeddingUsage;
}

export interface EmbeddingProvider {
  readonly model: EmbeddingModelIdentity;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export type EmbeddingProviderErrorCode =
  | "bad-input"
  | "provider-unavailable"
  | "rate-limited"
  | "bad-response";

export class EmbeddingProviderError extends Error {
  constructor(
    public readonly code: EmbeddingProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export interface DeterministicEmbeddingProviderOptions {
  model?: string;
  dimensions?: number;
  salt?: string;
}

export function createDeterministicEmbeddingProvider(
  opts: DeterministicEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const dimensions = normalizeDimensions(opts.dimensions ?? 8);
  const model: EmbeddingModelIdentity = {
    provider: "deterministic",
    model: opts.model ?? "deterministic-hash-v1",
    dimensions,
  };
  const salt = opts.salt ?? "almanac-deterministic-embedding";

  return {
    model,
    async embed(request) {
      validateEmbeddingRequest(request);
      return {
        model,
        vectors: request.inputs.map((input) => ({
          inputId: input.id,
          values: deterministicUnitVector({
            id: input.id,
            text: input.text,
            model: model.model,
            dimensions,
            salt,
          }),
          dimensions,
        })),
        usage: {
          inputCount: request.inputs.length,
          inputCharacters: request.inputs.reduce(
            (sum, input) => sum + input.text.length,
            0,
          ),
        },
      };
    },
  };
}

export function validateEmbeddingRequest(request: EmbeddingRequest): void {
  if (!Array.isArray(request.inputs) || request.inputs.length === 0) {
    throw new EmbeddingProviderError(
      "bad-input",
      "embedding request requires at least one input",
      false,
    );
  }
  const seen = new Set<string>();
  for (const input of request.inputs) {
    if (input.id.trim().length === 0) {
      throw new EmbeddingProviderError(
        "bad-input",
        "embedding input id must be non-empty",
        false,
      );
    }
    if (seen.has(input.id)) {
      throw new EmbeddingProviderError(
        "bad-input",
        `duplicate embedding input id: ${input.id}`,
        false,
      );
    }
    seen.add(input.id);
    if (input.text.trim().length === 0) {
      throw new EmbeddingProviderError(
        "bad-input",
        `embedding input ${input.id} has empty text`,
        false,
      );
    }
  }
}

function deterministicUnitVector(args: {
  id: string;
  text: string;
  model: string;
  dimensions: number;
  salt: string;
}): number[] {
  const values: number[] = [];
  let counter = 0;
  while (values.length < args.dimensions) {
    const digest = createHash("sha256")
      .update(JSON.stringify([args.salt, args.model, args.id, args.text, counter]))
      .digest();
    for (const byte of digest) {
      values.push((byte - 127.5) / 127.5);
      if (values.length === args.dimensions) break;
    }
    counter += 1;
  }

  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => Number((value / norm).toFixed(8)));
}

function normalizeDimensions(dimensions: number): number {
  if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 8192) {
    throw new EmbeddingProviderError(
      "bad-input",
      `invalid embedding dimensions: ${dimensions}`,
      false,
    );
  }
  return dimensions;
}
