## Quality floor (every section, without announcing it)
(from Impeccable, Vercel Web Interface Guidelines, taste-skill and Anthropic frontend-design)

Readability and contrast
- Body text at least 16px; nothing under 14px except fine print. Prose lines 45 to 75 characters (.adr-lead and paragraphs already cap width; do not stretch text across the full container).
- Text and buttons meet WCAG AA: 4.5:1 for body, 3:1 for large text. No grey text on coloured bands; on --dark/--brand/--gradient bands use inherited or white text and the band's own classes.
- Every button label is readable against its fill. A ghost button over a photo needs a scrim or a solid variant.

Buttons and links
- Primary CTA labels fit on one line at desktop: 2 to 5 words.
- One label per intent across the whole page. If the primary action is "Book a free review", every primary button says exactly that (header, hero, closing section). Secondary actions use .adr-link.
- Buttons are <a> for navigation and <button> only inside forms. Every link has a real href.

Structure and semantics
- One h1 (the hero). Headings go in order: h2 per section, h3 inside cards. Never skip levels for size; the classes handle size.
- Images: meaningful alt text written for the client; decorative images alt="". Logos alt="<name> logo".
- Icon-only controls get aria-label. Decorative glyphs get aria-hidden="true".
- Lists of things are <ul>/<ol>; FAQs use the .adr-faq details pattern.

Consistency locks
- One corner-radius system: the stylesheet's --radius-* tokens. Do not add other radii.
- One accent: the brand tokens. No new colours, no second accent halfway down the page.
- One theme: section bands vary only through the provided band classes; no ad-hoc dark or cream inserts.
- No cards inside cards. A card's content never gets another bordered box.

Hero
- The hero reads in one glance: headline (max 2 lines at desktop), one supporting line (about 20 words), CTAs visible without scrolling. At most 4 text elements (optional eyebrow, headline, lead, CTAs).
- Trust logos and rating strips belong in their own section below the hero unless the competitor's hero clearly shows them inside it.

Motion
- No new animations. If a section genuinely needs one, use transform/opacity only; the stylesheet already disables motion for prefers-reduced-motion.
