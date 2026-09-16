import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/server";
import { countActiveAdmins, getAppSettings } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  const settings = getAppSettings();
  return NextResponse.json({
    authenticated: Boolean(user),
    user,
    // Lets the sign-in screen hide the "create account" link when sign-up is
    // off, and prompt for bootstrap on a brand-new deployment.
    publicSignupEnabled: settings.publicSignupEnabled,
    needsBootstrap: countActiveAdmins() === 0,
  });
}
