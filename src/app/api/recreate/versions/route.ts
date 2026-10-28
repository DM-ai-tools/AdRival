import { NextResponse } from "next/server";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { getRecreationVersionCounts } from "@/lib/data/competitors";
import { LOOKUP_RECREATE_PREFIX } from "@/lib/pipeline/lookupRecreateBridge";

export const runtime = "nodejs";

/**
 * How many recreations each source page has, for the "View versions" links of
 * a list: GET ?runId=<search> or ?lookupId=<lookup> → { counts: { [sourceId]: n } }.
 * One grouped read per list (a lookup's pages live on its recreation bridge run).
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const runId = (searchParams.get("runId") || "").trim();
    const lookupId = (searchParams.get("lookupId") || "").trim();
    if (runId) {
      await resolveProjectAccess("search", runId, user, "view");
      return NextResponse.json({ counts: await getRecreationVersionCounts(runId) });
    }
    if (lookupId) {
      await resolveProjectAccess("lookup", lookupId, user, "view");
      return NextResponse.json({ counts: await getRecreationVersionCounts(`${LOOKUP_RECREATE_PREFIX}${lookupId}`) });
    }
    return NextResponse.json({ error: "runId or lookupId is required" }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}
