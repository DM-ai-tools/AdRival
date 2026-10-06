import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchRings,
  placesUpToRing,
  ringSearchQueries,
  serviceAnchors,
} from "../src/lib/pipeline/searchRings";
import { cheapLocationFromText, matchPlaceToTargets } from "../src/lib/pipeline/competitorLocation";
import { ownBusinessCheck } from "../src/lib/pipeline/ownBusiness";
import type { BusinessLocation, BusinessProfile } from "../src/lib/types";

const home: BusinessLocation = {
  label: "Richmond, Melbourne, VIC",
  city: "Melbourne",
  suburb: "Richmond",
  region: "Victoria",
  countryCode: "AU",
  isPrimary: true,
};

const profile = {
  url: "https://example-dental.com.au",
  businessName: "Example Dental",
  industry: "Dental",
  description: "",
  offerings: ["Dental implants"],
  competitorKeywords: [],
  positioningSummary: "",
  locations: [home],
  primaryMarketCountry: "AU",
  serviceArea: {
    radiusKm: 5,
    nearbyAreas: ["Cremorne", "Abbotsford", "South Yarra"],
    widerRadiusKm: 15,
    widerAreas: ["Hawthorn", "Brunswick"],
    metro: "Melbourne",
    region: "Victoria",
  },
} satisfies BusinessProfile;

test("rings run nearby suburbs, then the wider area and metro, then the state", () => {
  const rings = buildSearchRings(profile, [home]);
  assert.deepEqual(
    rings.map((r) => r.places.map((p) => p.city)),
    [
      ["Richmond", "Cremorne", "Abbotsford", "South Yarra"],
      ["Hawthorn", "Brunswick", "Melbourne"],
      ["Victoria"],
    ],
  );
  assert.equal(rings[0].label, "within ~5 km of Richmond");
});

test("the nearest ring does not count the whole metro or state as local", () => {
  const rings = buildSearchRings(profile, [home]);
  const near = cheapLocationFromText({
    pageName: "Smile Co",
    adText: "Book your Melbourne dental check-up today",
    targets: placesUpToRing(rings, 0),
    geoMode: "company_locations",
  });
  assert.notEqual(near.locationStatus, "matched");
  const wider = cheapLocationFromText({
    pageName: "Smile Co",
    adText: "Book your Melbourne dental check-up today",
    targets: placesUpToRing(rings, 1),
    geoMode: "company_locations",
  });
  assert.equal(wider.locationStatus, "matched");
});

test("queries put the service in each place of the ring", () => {
  const rings = buildSearchRings(profile, [home]);
  const anchors = serviceAnchors(
    ["dental implants Richmond", "dentist near me"],
    rings.flatMap((r) => r.places.map((p) => p.city)),
    null,
  );
  assert.deepEqual(anchors, ["dental implants", "dentist"]);
  const queries = ringSearchQueries({ anchors, ring: rings[0], maxQueries: 6 });
  assert.deepEqual(queries, [
    "dental implants Richmond",
    "dental implants Cremorne",
    "dental implants Abbotsford",
    "dental implants South Yarra",
    "dentist Richmond",
    "dentist Cremorne",
  ]);
});

test("a profile without a service area still gets a ring from its locations", () => {
  const rings = buildSearchRings({ ...profile, serviceArea: null }, [home]);
  assert.deepEqual(
    rings.map((r) => r.places.map((p) => p.city)),
    [["Richmond"], ["Melbourne"], ["Victoria"]],
  );
});

test("Pakenham dentist run: real addresses are matched only by the ring that covers them", () => {
  const pakenham: BusinessLocation = {
    label: "Pakenham Creek Family Dentist",
    city: "Pakenham",
    suburb: "Pakenham",
    region: "Victoria",
    countryCode: "AU",
    isPrimary: true,
  };
  const rings = buildSearchRings(
    {
      ...profile,
      locations: [pakenham],
      serviceArea: {
        radiusKm: 8,
        nearbyAreas: ["Pakenham South", "Officer", "Officer South", "Beaconsfield", "Beaconsfield Upper", "Cardinia", "Koo Wee Rup", "Nar Nar Goon"],
        widerRadiusKm: 25,
        widerAreas: ["Berwick", "Narre Warren South", "Clyde", "Clyde North", "Devon Meadows", "Tooradin", "Bunyip", "Drouin", "Longwarry"],
        metro: "Pakenham",
        region: "Victoria",
      },
    },
    [pakenham],
  );
  // Addresses as the Facebook page lookup returned them in that run.
  const addresses: Record<string, string> = {
    "Integrated Dental Care": "4/37 Main St, Pakenham, VIC, Australia, Victoria",
    "Elwood Dental Group": "163 Ormond Rd, Elwood, VIC, Australia, Victoria",
    "Queen Napier Dental": "30 Queen St, Warragul, VIC, Australia, Victoria",
    "Primary Dental": "Level 6, 203 Pacific Highway, St Leonards, NSW, Australia, New South Wales",
    "Pristine Dentistry": "15 Roopena Street, Ingle Farm, SA, Australia, South Australia",
    "South Lake Smiles": "Shop 40, 620 N Lake Road, South Lake, WA 6164",
    "Incredible Smiles Woodville": "667 Port Road, Woodville, SA, Australia, South Australia",
    "Noosaville Family Dental": "2/7-9 Gibson Rd, Noosaville, QLD, Australia, Queensland",
  };
  const firstRing = (address: string) => {
    for (const ring of rings) {
      const m = matchPlaceToTargets(
        {
          locationLabel: address,
          locationCity: null,
          locationSuburb: null,
          locationCountry: null,
          locationStatus: "unknown",
          locationSource: "sociavault",
        },
        placesUpToRing(rings, ring.level),
        "company_locations",
      );
      if (m.locationStatus === "matched") return ring.level;
    }
    return "country-wide";
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(addresses).map(([name, a]) => [name, firstRing(a)])),
    {
      "Integrated Dental Care": 0,
      "Elwood Dental Group": 2,
      "Queen Napier Dental": 2,
      "Primary Dental": "country-wide",
      "Pristine Dentistry": "country-wide",
      "South Lake Smiles": "country-wide",
      "Incredible Smiles Woodville": "country-wide",
      "Noosaville Family Dental": "country-wide",
    },
  );
});

test("second Pakenham run: street names do not count as places, short state names do", () => {
  const pakenham: BusinessLocation = {
    label: "2 Deveney Street, Pakenham VIC 3810",
    city: "Pakenham",
    suburb: "Pakenham",
    region: "VIC",
    countryCode: "AU",
    isPrimary: true,
  };
  const rings = buildSearchRings(
    {
      ...profile,
      locations: [pakenham],
      serviceArea: {
        radiusKm: 8,
        nearbyAreas: ["Pakenham South", "Pakenham Upper", "Officer", "Officer South", "Beaconsfield Upper", "Nar Nar Goon", "Nar Nar Goon North", "Cardinia"],
        widerRadiusKm: 25,
        widerAreas: ["Beaconsfield", "Berwick", "Clyde", "Clyde North", "Koo Wee Rup", "Menzies Creek", "Emerald"],
        metro: "Pakenham",
        region: "Victoria",
      },
    },
    [pakenham],
  );
  const firstRing = (address: string) => {
    for (const ring of rings) {
      const m = matchPlaceToTargets(
        {
          locationLabel: address,
          locationCity: null,
          locationSuburb: null,
          locationCountry: null,
          locationStatus: "unknown",
          locationSource: "sociavault",
        },
        placesUpToRing(rings, ring.level),
        "company_locations",
      );
      if (m.locationStatus === "matched") return ring.level;
    }
    return "country-wide";
  };
  assert.deepEqual(
    {
      ceres: firstRing("179 Victoria St, Potts Point NSW 2011, Australia, Sydney, NSW, Australia, New South Wales"),
      tulip: firstRing("2 Victoria St, Mittagong NSW 2575, Australia, Mittagong, NSW, Australia, New South Wales"),
      echuca: firstRing("200-202 Pakenham Street, Echuca, VIC, Australia, Victoria"),
      altona: firstRing("95 Victoria Street Altona Meadows , Melbourne, VIC, Australia, Victoria"),
      berwick: firstRing("Alira Village Level 1/5 Adakite Drive, Berwick, VIC, Australia, Victoria"),
      cranbourne: firstRing("2 Lansell Drive , Cranbourne North, VIC, Australia, Victoria"),
      tamworth: firstRing("Shop 11, Centrepoint Shopping Centre, 374 Peel Street, Tamworth, NSW, 2340, Tamworth, NSW, Australia, New South Wales"),
      officerShort: firstRing("12 Main St, Officer VIC 3809"),
      bendigoShort: firstRing("5 High St, Bendigo VIC 3550"),
    },
    {
      ceres: "country-wide",
      tulip: "country-wide",
      echuca: 2,
      altona: 2,
      berwick: 1,
      cranbourne: 2,
      tamworth: "country-wide",
      officerShort: 0,
      bendigoShort: 2,
    },
  );
});

test("the outer ring sits between the wider area and the state", () => {
  const rings = buildSearchRings(
    {
      ...profile,
      serviceArea: { ...profile.serviceArea, outerRadiusKm: 40, outerAreas: ["Dandenong", "Frankston"] },
    },
    [home],
  );
  assert.deepEqual(
    rings.map((r) => r.label),
    ["within ~5 km of Richmond", "within ~15 km of Richmond", "within ~40 km of Richmond", "across Victoria"],
  );
});

test("the client's own business is recognised even when its ad links to WhatsApp", () => {
  const isOwn = ownBusinessCheck(
    {
      ...profile,
      url: "https://pakenhamcreekfamilydentist.com.au",
      businessName: "Pakenham Creek Family Dentist",
      brandAssets: {
        finalUrl: "https://pakenhamcreekfamilydentist.com.au/",
        siteName: "Pakenham Creek Family Dentist",
        logoUrl: null,
        faviconUrl: null,
        ogImageUrl: null,
        navLinks: [],
        footerLinks: [],
        socialLinks: [{ label: "Facebook", href: "https://www.facebook.com/PakenhamCreekFamilyDentist" }],
        images: [],
        emails: [],
        phones: [],
      },
    },
    "https://pakenhamcreekfamilydentist.com.au/",
  );
  // Exactly as the competitor row looked in the run.
  assert.equal(
    isOwn({
      pageName: "Pakenham Creek Family Dentist",
      facebookUrl: "https://www.facebook.com/PakenhamCreekFamilyDentist/",
      urls: ["https://api.whatsapp.com/send"],
    }),
    true,
  );
  assert.equal(isOwn({ pageName: "Some Page", facebookUrl: "https://www.facebook.com/PakenhamCreekFamilyDentist/" }), true);
  assert.equal(isOwn({ pageName: "Some Page", urls: ["https://www.pakenhamcreekfamilydentist.com.au/book"] }), true);
  assert.equal(
    isOwn({
      pageName: "Alira Smiles Dental",
      facebookUrl: "https://www.facebook.com/61557977086580/",
      urls: ["https://alirasmilesdental.com.au/"],
    }),
    false,
  );
});
