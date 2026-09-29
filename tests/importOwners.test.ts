import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("import-owners");
after(() => store.cleanup());

test("imported history is matched to this server's accounts by username, with a fallback owner", async () => {
  const { createUser, replaceStore, getJob, getLookupJob } = await import("../src/lib/db");
  const alice = createUser({ username: "alice", displayName: "Alice", passwordHash: "x", role: "user" });
  const owner = createUser({ username: "boss", displayName: "Boss", passwordHash: "x", role: "admin" });

  const job = (id: string, ownerUserId: string | null) =>
    ({ id, keyword: id, keywords: [id], status: "completed", createdAt: "2026-01-01", updatedAt: "2026-01-01", competitorIds: [], progress: {}, ownerUserId }) as never;

  const result = replaceStore(
    {
      // Users exported from the other machine: same username, different id.
      users: [
        { id: "local-alice", username: "alice" },
        { id: "local-ghost", username: "ghost" },
      ] as never,
      jobs: [job("a", "local-alice"), job("b", "local-ghost"), job("c", null), job("d", alice.id)],
      competitors: [],
      seenPageIds: [],
      lookupJobs: [{ id: "l1", queryName: "x", status: "completed", createdAt: "2026-01-01", updatedAt: "2026-01-01", ownerUserId: "local-alice" } as never],
    },
    { fallbackOwnerUserId: owner.id },
  );

  assert.equal(getJob("a")?.ownerUserId, alice.id, "matched by username");
  assert.equal(getJob("b")?.ownerUserId, owner.id, "unknown owner goes to the fallback");
  assert.equal(getJob("c")?.ownerUserId, owner.id, "unowned goes to the fallback");
  assert.equal(getJob("d")?.ownerUserId, alice.id, "an owner that exists here is kept");
  assert.equal(getLookupJob("l1")?.ownerUserId, alice.id);
  assert.deepEqual(result.owners, { kept: 1, matchedByUsername: 2, assignedToFallback: 2, unresolved: 0 });
});
