import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { useTempStore } from "./helpers/store";

const store = await useTempStore("recreate-scope");
after(() => store.cleanup());

const { makeUser } = await import("./helpers/factories");
const { reserveCredits, countOpenReservations } = await import(
  "@/lib/accounting/service"
);
const { creditsToSubunits } = await import("@/lib/accounting/units");
const { RECREATE_BUILD_OPERATION, scopeOf } = await import("@/lib/accounting/scope");

async function hold(userId: string, operation: string, limit: number) {
  const scope = scopeOf(operation);
  return reserveCredits({
    userId,
    amountSubunits: creditsToSubunits(1),
    operation,
    maxOpenReservations: limit,
    scope,
  });
}

async function fundedUser(name: string) {
  return makeUser({ username: name, credits: 1000 });
}

describe("recreate concurrency scope", () => {
  test("scopeOf maps only the page build to recreate", () => {
    assert.equal(RECREATE_BUILD_OPERATION, "recreate.generate_page");
    assert.equal(scopeOf("recreate.generate_page"), "recreate");
    assert.equal(scopeOf("recreate.edit_page"), "other");
    assert.equal(scopeOf("search.run"), "other");
  });

  test("three recreate holds do not block a search", async () => {
    const user = await fundedUser("scope-a");
    for (let i = 0; i < 3; i++) {
      assert.equal((await hold(user.id, RECREATE_BUILD_OPERATION, 3)).ok, true);
    }
    const search = await hold(user.id, "search.run", 1);
    assert.equal(search.ok, true);
    assert.equal(await countOpenReservations(user.id, "recreate"), 3);
    assert.equal(await countOpenReservations(user.id, "other"), 1);
    assert.equal(await countOpenReservations(user.id), 4);
  });

  test("a fourth recreate hold is refused with too_many_concurrent_runs and limit 3", async () => {
    const user = await fundedUser("scope-b");
    for (let i = 0; i < 3; i++) {
      assert.equal((await hold(user.id, RECREATE_BUILD_OPERATION, 3)).ok, true);
    }
    const fourth = await hold(user.id, RECREATE_BUILD_OPERATION, 3);
    assert.equal(fourth.ok, false);
    assert.equal(fourth.ok === false && fourth.reason, "too_many_concurrent_runs");
    assert.equal(fourth.ok === false && fourth.reason === "too_many_concurrent_runs" && fourth.limit, 3);
  });

  test("three search-type holds do not block a recreate", async () => {
    const user = await fundedUser("scope-c");
    for (let i = 0; i < 3; i++) {
      assert.equal((await hold(user.id, "search.run", 3)).ok, true);
    }
    assert.equal((await hold(user.id, RECREATE_BUILD_OPERATION, 3)).ok, true);
  });

  test("edit_page counts as other (shared limit)", async () => {
    const user = await fundedUser("scope-d");
    for (let i = 0; i < 3; i++) {
      assert.equal((await hold(user.id, "recreate.edit_page", 3)).ok, true);
    }
    const next = await hold(user.id, "search.run", 3);
    assert.equal(next.ok, false);
    assert.equal(next.ok === false && next.reason, "too_many_concurrent_runs");
    // and a build is not blocked by them
    assert.equal((await hold(user.id, RECREATE_BUILD_OPERATION, 3)).ok, true);
  });
});
