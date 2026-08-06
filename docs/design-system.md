# Lia Design System

## Color tokens

```css
--navy-950: #0b1830;
--navy-900: #10213f;
--purple-600: #5b43f1;
--purple-500: #6b54f5;
--purple-100: #eeebff;
--green-600: #159a61;
--green-100: #e9f8f0;
--amber-600: #d98b00;
--amber-100: #fff5de;
--red-600: #e34646;
--red-100: #fff0f0;
--blue-600: #2684ff;
--gray-950: #111827;
--gray-700: #374151;
--gray-500: #6b7280;
--gray-300: #d1d5db;
--gray-200: #e5e7eb;
--gray-100: #f3f4f6;
--gray-50: #f8fafc;
--white: #ffffff;
```

## Typography

Use Inter or Geist.

- Page title: 28–32 px, 650–700 weight
- Section title: 16–18 px, 600 weight
- Body: 14 px, 400–500 weight
- Metadata: 12–13 px
- Table headers: 12 px, 600 weight

## Spacing

Use an 8 px base rhythm.

- Page padding: 24–32 px
- Card padding: 16–24 px
- Card gap: 16 px
- Dense row height: 64–84 px

## Components

### Cards

- White background
- 1 px neutral border
- 12–16 px radius
- Minimal shadow

### Buttons

- Primary: purple fill, white text
- Secondary: white fill, neutral border
- Destructive: white or pale red with red text
- Compact controls: 32–36 px height
- Primary actions: 40–44 px height

### Status badges

Use semantic pale backgrounds and concise labels.

### Data density

Desktop screens may be information-dense, but hierarchy must remain clear. Prefer disclosure panels over adding more top-level pages.

## Surfaces

The product and the public site are two brands, and there are now three
surfaces rather than two. Each scopes its own focus ring and selection colour
through a `data-surface` attribute on its wrapper, declared in `globals.css`.

| Surface | `data-surface` | Typeface | Accent | Where |
| --- | --- | --- | --- | --- |
| Product | *(none)* | `font-sans` (Inter) | `purple-600` | `(app)` routes |
| Marketing site | `site` | `font-site` (Geist) | `site-orange` / `site-blue` | `(site)` routes |
| Onboarding | `site` | `font-site` (Geist) | `site-orange` / `site-blue` | `/onboarding/*` |

### Onboarding

Onboarding uses the **marketing** tokens, not the product's. It is the first
screen after signing up, and it should look like the site the person just came
from rather than like a dashboard they have not earned. Concretely:

- `site-ink` headings, `site-body` copy, `site-muted` secondary copy
- `site-tint` page background, white cards
- `site-orange` / `site-orange-hover` primary actions, with **ink** labels —
  white on `#FF7A2E` measures 2.60:1 and fails even the large-text floor
- `site-blue` links and outlined secondary buttons
- `site-blue-tint` / `site-blue-edge` information panels
- `site-blue-mark` for decorative strokes only, never text
- `site-field` (`#8296B4`) for form-control borders. The ornamental
  `site-border` (`#E6EAF0`) measures 1.21:1 against white and fails WCAG 1.4.11
  for a control boundary.

No purple, no navy, no teal, and no app sidebar. `tests/onboarding-accessibility.test.ts`
holds that: it fails if any onboarding component references a `purple-*` or
`navy-*` utility.

Decorative speech bubbles are a separate component from the marketing site's
(`onboarding-doodle.tsx`, not `speech-bubble.tsx`) because the site's renders a
*quote* with an attribution — reusing it would put words in a fictional
customer's mouth on a screen where the real customer is configuring their
account. At most two per screen; every one is `aria-hidden`, `focusable="false"`,
`role="presentation"`, and `pointer-events-none`.

Touch targets on the wizard are 44px minimum without exception. Setup is
frequently finished on a phone, one-handed, by somebody who has had the product
for four minutes and will not persevere through a mis-tap.

## Interaction principles

- Preserve selected row context in split-view layouts.
- Keep the primary action visible without scrolling where practical.
- Display why Lia made a recommendation.
- Show publishing capability and approval requirement explicitly.
- Make automation reversible and auditable.
