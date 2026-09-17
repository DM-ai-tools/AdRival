import assert from "node:assert/strict";
import test, { after } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("content-access");
after(() => store.cleanup());

test("cross-user and viewer mutation attempts are rejected", async () => {
  const { makeUser, makeSearchProject } = await import("./helpers/factories");
  const { HttpError, resolveProjectAccess } = await import("../src/lib/authz");
  const { upsertSpaceMembership, createProjectSpace, transaction } = await import("../src/lib/db");
  const { recreationActionPermission } = await import("../src/lib/pipeline/content/permissions");
  const owner = await makeUser();
  const other = await makeUser();
  const viewer = await makeUser();
  const project = makeSearchProject({ ownerUserId: owner.id });
  const space = createProjectSpace({ ownerUserId: owner.id, clientName: "Client A" });
  transaction((db) => {
    const job = db.jobs.find((row) => row.id === project.id);
    if (job) job.spaceId = space.id;
  });
  upsertSpaceMembership({ spaceId: space.id, userId: viewer.id, role: "viewer", grantedByUserId: owner.id });

  assert.throws(() => resolveProjectAccess("search", project.id, other, "view"), HttpError);
  const access = resolveProjectAccess("search", project.id, viewer, "view");
  assert.equal(access.role, "viewer");
  assert.throws(() => resolveProjectAccess("search", project.id, viewer, recreationActionPermission("save_content")), HttpError);
  assert.throws(() => resolveProjectAccess("search", project.id, viewer, recreationActionPermission("generate_content")), HttpError);
  assert.throws(() => resolveProjectAccess("search", project.id, viewer, recreationActionPermission("approve_content")), HttpError);
});
