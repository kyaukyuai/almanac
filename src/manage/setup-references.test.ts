import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addSetupReference,
  readSetupReferences,
  setupReferenceRejectionReason,
  setupReferencesPath,
} from "./setup-references.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "almanac-setup-refs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("setup references", () => {
  test("validation accepts URLs and local paths and rejects malformed input", () => {
    expect(setupReferenceRejectionReason("https://docs.example.com/guide")).toBeNull();
    expect(setupReferenceRejectionReason("http://example.com")).toBeNull();
    expect(setupReferenceRejectionReason("/Users/me/notes.md")).toBeNull();
    expect(setupReferenceRejectionReason("./relative/notes.md")).toBeNull();
    expect(setupReferenceRejectionReason("file:///tmp/runbook.md")).toBeNull();

    expect(setupReferenceRejectionReason("")).toContain("empty");
    expect(setupReferenceRejectionReason("   ")).toContain("empty");
    expect(setupReferenceRejectionReason("not a url")).toContain("without spaces");
    expect(setupReferenceRejectionReason("just-words")).toContain(
      "not a recognizable URL",
    );
    expect(setupReferenceRejectionReason("ftp://example.com/x")).toContain(
      "unsupported URL scheme: ftp",
    );
  });

  test("accepted references persist and read back in order", async () => {
    const first = await addSetupReference({
      root,
      url: "https://docs.example.com/guide",
      via: "studio",
      now: new Date("2026-06-12T00:00:00.000Z"),
    });
    expect(first.status).toBe("accepted");
    const second = await addSetupReference({
      root,
      url: "https://github.com/example/repo",
      via: "cli",
      now: new Date("2026-06-12T00:01:00.000Z"),
    });
    expect(second.status).toBe("accepted");

    const file = await readSetupReferences(root);
    expect(file.references).toEqual([
      {
        url: "https://docs.example.com/guide",
        addedAt: "2026-06-12T00:00:00.000Z",
        via: "studio",
      },
      {
        url: "https://github.com/example/repo",
        addedAt: "2026-06-12T00:01:00.000Z",
        via: "cli",
      },
    ]);
    const raw = await readFile(setupReferencesPath(root), "utf8");
    expect(JSON.parse(raw).schemaVersion).toBe("0.1.0");
  });

  test("duplicates are reported and not re-persisted", async () => {
    await addSetupReference({ root, url: "https://docs.example.com", via: "studio" });
    const duplicate = await addSetupReference({
      root,
      url: "  https://docs.example.com  ",
      via: "studio",
    });
    expect(duplicate.status).toBe("duplicate");
    expect((await readSetupReferences(root)).references).toHaveLength(1);
  });

  test("rejected references are not persisted", async () => {
    const rejected = await addSetupReference({ root, url: "nope", via: "studio" });
    expect(rejected).toEqual({
      status: "rejected",
      url: "nope",
      reason: expect.stringContaining("not a recognizable URL"),
    });
    expect((await readSetupReferences(root)).references).toEqual([]);
  });

  test("missing root and malformed files read as empty state", async () => {
    expect(await readSetupReferences(join(root, "missing"))).toEqual({
      schemaVersion: "0.1.0",
      references: [],
    });
    await writeFile(setupReferencesPath(root), "{not json", "utf8");
    expect((await readSetupReferences(root)).references).toEqual([]);
    await writeFile(
      setupReferencesPath(root),
      JSON.stringify({ schemaVersion: "0.1.0", references: [{ bogus: true }, { url: "https://ok.example.com", addedAt: "x", via: "studio" }] }),
      "utf8",
    );
    expect((await readSetupReferences(root)).references).toEqual([
      { url: "https://ok.example.com", addedAt: "x", via: "studio" },
    ]);
  });

  test("adding into a missing root creates it", async () => {
    const nested = join(root, "fresh-root");
    const result = await addSetupReference({
      root: nested,
      url: "https://docs.example.com",
      via: "studio",
    });
    expect(result.status).toBe("accepted");
    expect((await readSetupReferences(nested)).references).toHaveLength(1);
  });
});
