import assert from "node:assert/strict";
import test, { after } from "node:test";
import { useTempStore } from "./helpers/store";

const store = await useTempStore("content-access");
after(() => store.cleanup());

test("cross-user and viewer mutation attempts are rejected", async () => {
  const { makeUser, makeSearchProject } = await import("./helpers/factories");
  const { HttpError, resolveProjectAccess } = await import("../src/lib/authz");
  const { upsertSpaceMembership, createProjectSpace, assignRunsToSpace } = await import("../src/lib/db");
  const owner = await makeUser();
  const other = await makeUser();
  const viewer = await makeUser();
  const project = await makeSearchProject({ ownerUserId: owner.id });
  const space = await createProjectSpace({ ownerUserId: owner.id, clientName: "Client A" });
  assert.equal(await assignRunsToSpace(space.id, [{ kind: "search", id: project.id }]), 1);
  await upsertSpaceMembership({ spaceId: space.id, userId: viewer.id, role: "viewer", grantedByUserId: owner.id });

  await assert.rejects(() => resolveProjectAccess("search", project.id, other, "view"), HttpError);
  const access = await resolveProjectAccess("search", project.id, viewer, "view");
  assert.equal(access.role, "viewer");
  // Saving the website / undo need edit; building or changing the page needs run.
  await assert.rejects(() => resolveProjectAccess("search", project.id, viewer, "edit"), HttpError);
  await assert.rejects(() => resolveProjectAccess("search", project.id, viewer, "run"), HttpError);
});
