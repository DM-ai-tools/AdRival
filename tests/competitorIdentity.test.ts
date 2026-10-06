import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLookupInput, pickOwnWebsite } from "../src/lib/pipeline/competitorIdentity";
import { sameCompany } from "../src/lib/pipeline/linkedinSearch";

test("lookup input: names, websites and page links are told apart", () => {
  assert.equal(classifyLookupInput("Push Mobility").inputKind, "name");
  assert.deepEqual(
    { kind: classifyLookupInput("pushmobility.com.au").inputKind, domain: classifyLookupInput("pushmobility.com.au").domain },
    { kind: "website", domain: "pushmobility.com.au" },
  );
  assert.equal(classifyLookupInput("https://www.pushmobility.com.au/wheelchairs").domain, "pushmobility.com.au");
  const fb = classifyLookupInput("https://www.facebook.com/PushMobility/");
  assert.deepEqual({ kind: fb.inputKind, handle: fb.facebookHandle }, { kind: "facebook", handle: "PushMobility" });
  const fbId = classifyLookupInput("https://www.facebook.com/profile.php?id=61557977086580");
  assert.equal(fbId.facebookHandle, "61557977086580");
  const li = classifyLookupInput("linkedin.com/company/webfx");
  assert.deepEqual({ kind: li.inputKind, url: li.linkedinUrl }, { kind: "linkedin", url: "https://linkedin.com/company/webfx" });
  assert.equal(classifyLookupInput("https://www.instagram.com/pushmobility/").instagramHandle, "pushmobility");
});

test("LinkedIn ads are kept only from the looked-up company", () => {
  assert.equal(sameCompany("WebFX, Inc.", "WebFX"), true);
  assert.equal(sameCompany("Push Mobility Pty Ltd", "Push Mobility"), true);
  assert.equal(sameCompany("WebFX Marketing", "WebFX"), true);
  assert.equal(sameCompany("HubSpot", "WebFX"), false);
  assert.equal(sameCompany("Smile Dental Studio Sydney", "Smile"), false);
});

test("a name finds the business's own website, not a directory or review site", () => {
  assert.equal(
    pickOwnWebsite("Push Mobility", [
      { url: "https://www.productreview.com.au/listings/push-mobility", title: "Push Mobility reviews" },
      { url: "https://www.facebook.com/PushMobility", title: "Push Mobility | Facebook" },
      { url: "https://pushmobility.com.au/", title: "Push Mobility – Custom wheelchairs Melbourne" },
    ]),
    "pushmobility.com.au",
  );
  assert.equal(
    pickOwnWebsite("Black Tie Classic", [{ url: "https://www.blacktieclassic.com.au/suit-hire", title: "Suit Hire Melbourne | Black Tie Classic" }]),
    "blacktieclassic.com.au",
  );
  assert.equal(
    pickOwnWebsite("Peter Shearer Menswear", [{ url: "https://www.petershearer.com.au", title: "Peter Shearer Menswear Melbourne" }]),
    "petershearer.com.au",
  );
  // Results that do not name the business are not taken.
  assert.equal(pickOwnWebsite("Push Mobility", [{ url: "https://www.mobilitycare.net.au", title: "Mobility aids Melbourne" }]), null);
});
