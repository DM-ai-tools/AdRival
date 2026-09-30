# Recreate design skills

Design skills used every time a landing page is recreated for a client (`src/lib/pipeline/unified/*`). They make the generated page look deliberate and polished instead of AI-generated, while it still follows the competitor's layout and the client's brand.

## How they are used

| Skill | Upstream | Used for | Where in code |
| --- | --- | --- | --- |
| Taste Skill (design-taste-frontend, high-end-visual-design, minimalist-ui, industrial-brutalist-ui, redesign, image-to-code) | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) @ `ce26fc2`, MIT | Anti-slop and copy rules, screenshot-reading rules, the three style directions | `playbook/*.md` → `skills/playbook.ts`; style tokens in `skills/styleDirection.ts` |
| Impeccable | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) @ `0d6b47e`, Apache 2.0 | Its detector engine (61 deterministic rules) checks every built page; findings drive section repairs. Polish/audit guidance shapes the repair prompt | `skills/designAudit.ts` runs the `impeccable` npm package; `playbook/repair.md` |
| UI UX Pro Max | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) @ `09170ee`, MIT | Industry lookup (192 product types): font pairing and palette used only where the client's brand has none, plus industry pitfalls given to the writer | `vendor/ui-ux-pro-max/data/*.csv` → `skills/industry.ts` |
| awesome-design-md | [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) @ `f696123`, MIT | Format of the DESIGN.md style file saved with each recreated page | `skills/designMd.ts` |
| Vercel Web Interface Guidelines | [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) @ `e3d624b`, MIT | Accessibility and markup rules: in the playbook, and as local checks and automatic fixes (labels, autocomplete, image sizes, focus, reduced motion, zoom) | `playbook/quality-floor.md`, `skills/designAudit.ts` |
| Anthropic frontend-design | [anthropics/skills](https://github.com/anthropics/skills) @ `8a1541c`, Apache 2.0 | Generated-design tells, restraint, writing guidance | `playbook/anti-generic.md`, `playbook/copy.md` |
| screenshot-to-code | [abi/screenshot-to-code](https://github.com/abi/screenshot-to-code) @ `d026163`, MIT | "Look exactly like the screenshot" replication discipline, limited to layout (never the competitor's text, colours or logos) | `playbook/screenshot-fidelity.md` |

`vendor/` holds the upstream files unchanged, with their licences, as the source of truth. `playbook/` is the text actually sent to Claude: short, pipeline-specific rules distilled from those sources. The raw skills are not sent as they are, because they target other set-ups (Tailwind, React, GSAP, asking the user questions) and some of their rules would contradict copying the competitor's layout (for example "never use three equal cards"). The precedence is written in `playbook/00-precedence.md`.

## Why not the Skills API

The Skills API (`container.skills` + code execution) lets Claude open skill files itself inside a sandbox. For this pipeline that would add a container and extra tool turns to every section call, and make the strict JSON output harder to keep. The playbook sits in the system prompt with prompt caching instead: the same text for every call, so after the first call of a run it is read from cache. The detector runs locally, at no model cost.

## Updating a skill

1. Replace the files under `vendor/<skill>/` with the new upstream version and update the commit in the table above.
2. Read the diff and carry any rule that matters for landing pages into `playbook/`.
3. For Impeccable, bump the `impeccable` version in `package.json`.

## Licences

Each `vendor/<skill>/` folder keeps its upstream `LICENSE` (and `NOTICE.md` for Impeccable). The playbook files name the skill each rule comes from.
