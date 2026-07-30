import fs from "fs";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const key = env.FIRECRAWL_API_KEY;
if (!key) {
  console.error("No FIRECRAWL_API_KEY");
  process.exit(1);
}

const url = "https://moderndentalcentre.com.au/";
const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url,
    formats: ["branding"],
    onlyMainContent: false,
    timeout: 90000,
  }),
});

const json = await res.json();
const branding = json?.data?.branding ?? null;
console.log(
  JSON.stringify(
    {
      ok: res.ok,
      status: res.status,
      success: json?.success,
      error: json?.error ?? null,
      colors: branding?.colors ?? null,
      fonts: branding?.fonts ?? null,
      typography: branding?.typography
        ? {
            fontFamilies: branding.typography.fontFamilies,
            fontSizes: branding.typography.fontSizes,
          }
        : null,
      buttonPrimary: branding?.components?.buttonPrimary ?? null,
      buttonSecondary: branding?.components?.buttonSecondary ?? null,
      personality: branding?.personality ?? null,
      logo: branding?.logo ?? branding?.images?.logo ?? null,
      images: branding?.images ?? null,
    },
    null,
    2
  )
);
