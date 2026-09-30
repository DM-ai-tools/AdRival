import type { DesignSystem } from "../unified/designSystem";
import { STYLE_DIRECTION_LABEL } from "./playbook";

/**
 * The recreated page's style file, in the DESIGN.md layout used by
 * awesome-design-md (Overview, Colors, Typography, Layout, Elevation,
 * Components, Responsive Behavior). Built from the page's own tokens, so it
 * always matches what was shipped and can be handed to a developer or
 * another design tool.
 */
export function designSystemToDesignMd(input: {
  design: DesignSystem;
  clientName: string;
  clientUrl: string;
  competitorName: string;
  industry?: string | null;
}): string {
  const t = input.design.tokens;
  const v = (k: string) => t[k] || "";
  const { heading, body } = input.design.families;
  const style = STYLE_DIRECTION_LABEL[input.design.style];
  return `# ${input.clientName} landing page: DESIGN.md

## Overview

Landing page for ${input.clientName} (${input.clientUrl})${input.industry ? `, ${input.industry}` : ""}. Layout follows ${input.competitorName}'s page section by section; colours, fonts and logo come from ${input.clientName}'s own site. Style direction: ${style}.

## Colors

### Brand & Accent
- Primary: \`${v("--primary")}\`, text on primary \`${v("--on-primary")}\`
- Secondary: \`${v("--secondary")}\`
- Accent: \`${v("--accent")}\`
- Primary button: \`${v("--btn-bg")}\` with \`${v("--btn-text")}\` label

### Surface
- Page background: \`${v("--bg")}\`
- Tinted band: \`${v("--bg-alt")}\`
- Dark band: \`${v("--bg-dark")}\`

### Hairlines & Borders
- Border: \`${v("--border")}\`

### Text
- Body text: \`${v("--text")}\`
- Muted text: \`${v("--text-muted")}\`
- Links and highlights on light surfaces: \`${v("--text-safe")}\`
- Highlights on dark bands: \`${v("--accent-on-dark")}\`, text \`${v("--text-on-dark")}\`

## Typography

### Font Family
- Headings: ${heading}
- Body: ${body}

### Hierarchy
| Role | Size |
| --- | --- |
| H1 | \`${v("--h1")}\` |
| H2 | \`${v("--h2")}\` |
| H3 | \`${v("--h3")}\` |
| Body | \`${v("--body")}\` |

### Principles
- One H1 per page (the hero). Headings follow H2 per section, H3 inside cards.
- Prose stays within about 75 characters per line.

## Layout

### Spacing System
- Section padding: \`${v("--section-y")}\`
- Grid gap: \`${v("--gap")}\`
- Side gutter: \`${v("--gutter")}\`

### Grid & Container
- Content width: \`${v("--container")}\`
- Columns: 2 to 6 equal columns (\`.adr-grid--N\`), text and media split (\`.adr-split\`)

## Elevation
- Cards: \`${v("--shadow-card")}\`

## Components

### Buttons
- Primary: brand fill, radius \`${v("--radius-btn")}\`, at least 44px tall, one line on desktop
- Secondary: outline in the highlight colour; text links for tertiary actions

### Cards
- Radius \`${v("--radius-card")}\`, padding 20 to 32px

### Forms
- Inputs radius \`${v("--radius-input")}\`, label above each field, visible focus ring in the primary colour

## Responsive Behavior

### Touch Targets
- Buttons and form controls at least 44px tall.

### Collapsing Strategy
- Below 960px: 3 to 6 column grids become 2 columns, text and media splits stack.
- Below 640px: everything is one column and buttons are full width.
`;
}
