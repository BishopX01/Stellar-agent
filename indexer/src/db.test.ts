import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore, openDatabase } from "./db.js";

describe("EventStore discovery cache", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("persists cached values across database connections and supports invalidation", () => {
    directory = mkdtempSync(path.join(tmpdir(), "marc-discovery-cache-"));
    const dbPath = path.join(directory, "events.db");
    const firstDb = openDatabase(dbPath);
    const firstStore = new EventStore(firstDb);

    firstStore.setCache("agents", '[{"id":"1"}]', 123);
    firstDb.close();

    const secondDb = openDatabase(dbPath);
    const secondStore = new EventStore(secondDb);
    expect(secondStore.getCache("agents")).toEqual({
      value: '[{"id":"1"}]',
      updatedAt: 123,
    });

    secondStore.deleteCache("agents");
    expect(secondStore.getCache("agents")).toBeNull();
    secondDb.close();
  });
});
