import type { BrandDesignSpec } from "../../types";

function bullet(items: string[]): string {
  if (!items.length) return "_None extracted._";
  return items.map((i) => `- ${i}`).join("\n");
}

function kv(label: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return `- **${label}:** _not extracted_`;
  }
  return `- **${label}:** ${value}`;
}

function linkLines(
  items: Array<{ label: string; href: string }>,
): string {
  if (!items.length) return "_None extracted._";
  return items
    .slice(0, 24)
    .map((l) => `- ${l.label || "Link"}: ${l.href}`)
    .join("\n");
}

/**
 * Serialize BrandDesignSpec to the stable design.md template used as brand SSOT.
 */
export function serializeDesignMd(spec: BrandDesignSpec): string {
  const sizes = spec.typography.fontSizes
    ? Object.entries(spec.typography.fontSizes)
        .map(([k, v]) => `- **${k}:** ${v}`)
        .join("\n")
    : "_Not extracted._";
  const weights = spec.typography.fontWeights
    ? Object.entries(spec.typography.fontWeights)
        .map(([k, v]) => `- **${k}:** ${v}`)
        .join("\n")
    : "_Not extracted._";

  return `# Brand design system

> Single source of truth for visual identity on this recreation run.
> Competitor page = layout only. Every branding decision must follow this file.

## Meta

${kv("Brand name", spec.brandName)}
${kv("Brand website", spec.businessUrl)}
${kv("Extracted at", spec.extractedAt)}
${kv("Source", spec.source)}
${kv("Competitor layout source", spec.competitorName || "unknown")}

## Colors

${kv("Primary", spec.colors.primary)}
${kv("Secondary", spec.colors.secondary)}
${kv("Accent", spec.colors.accent)}
${kv("Background", spec.colors.background)}
${kv("Text", spec.colors.text)}
${kv("Muted", spec.colors.muted)}
${kv("Icon", spec.colors.icon)}
${kv("Color scheme", spec.design?.colorScheme)}

## Logos

${kv("Primary logo", spec.logos.primary)}
${kv("Dark / inverse logo", spec.logos.dark)}
${kv("Favicon", spec.logos.favicon)}

## Typography

${kv("Heading font", spec.typography.headingFont)}
${kv("Body font", spec.typography.bodyFont)}
${kv("Font stack", spec.fonts.join(", ") || null)}

### Font sizes

${sizes}

### Font weights

${weights}

## Buttons

### Primary

${kv("Background", spec.buttons.primary.background)}
${kv("Text", spec.buttons.primary.textColor)}
${kv("Border radius", spec.buttons.primary.borderRadius)}
${kv("Border color", spec.buttons.primary.borderColor)}

### Secondary

${kv("Background", spec.buttons.secondary.background)}
${kv("Text", spec.buttons.secondary.textColor)}
${kv("Border radius", spec.buttons.secondary.borderRadius)}
${kv("Border color", spec.buttons.secondary.borderColor)}

## Radii, shadows, spacing

${kv("Spacing base unit", spec.spacing.baseUnit)}
${kv("Default border radius", spec.spacing.borderRadius)}

### Border radii

${bullet(spec.borderRadii)}

### Box shadows

${bullet(spec.boxShadows)}

## Section backgrounds

${kv("Page", spec.sectionBackgrounds.page)}
${kv("Surface", spec.sectionBackgrounds.surface)}
${kv("Muted surface", spec.sectionBackgrounds.muted)}

## Imagery

### Style notes

${bullet(spec.imagery.styleNotes)}

### Sample subjects from brand site

${bullet(spec.imagery.sampleSubjects)}

## Chrome links (nav / footer / social / CTA)

### Nav

${linkLines(spec.links.nav)}

### Footer

${linkLines(spec.links.footer)}

### Social

${linkLines(spec.links.social)}

### CTA destinations

${linkLines(spec.links.cta)}

## Implementor rules

${bullet(spec.rules)}

## Extraction warnings

${bullet(spec.warnings)}
`;
}

/** Truncate design.md for LLM prompts while keeping critical rules + tokens. */
export function designMdPromptExcerpt(
  markdown: string,
  maxChars = 6000,
): string {
  const trimmed = markdown.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n…(truncated)`;
}
