# CLAUDE-SETTINGS.md

Style guide for anything rendered inside the Settings modal (`src/renderer/components/Settings/`).

Read this **before** adding or editing a settings section. Every rule here is derived from an audit of all 73 `.tsx` files under `src/renderer/components/Settings/` and all 21 themes in `src/shared/themes.ts`. Where a rule exists because the codebase disagrees with itself, the audit numbers are quoted so you know which side is canonical.

Related: [UI-PATTERNS.md](docs/agent-guides/UI-PATTERNS.md) (modals, layer stack, text selection), [WIDGET-LIBRARY.md](docs/agent-guides/WIDGET-LIBRARY.md) (stat cards, charts, inputs), [[CLAUDE-PATTERNS.md]] §3 (settings persistence plumbing).

---

## 1. The one rule that causes the most rework

**Never apply an `opacity-*` utility and `theme.colors.textDim` to the same text.**

This is "double-dimming". Each channel dims independently, so stacking them multiplies. It is the single most common visual defect in this tree and it is invisible on the theme you happen to be developing against.

```tsx
// WRONG - two dimming channels stacked
<div className="text-xs opacity-50" style={{ color: theme.colors.textDim }}>
	Mentioned agents may modify files in their own workspace.
</div>

// RIGHT - one dimming channel
<div className="text-xs opacity-50">
	Mentioned agents may modify files in their own workspace.
</div>
```

### Why this is not a nitpick

Measured contrast against each theme's `bgMain` (WCAG needs 3:1 for secondary text, 4.5:1 for body):

| Dimming approach                          | Passes 3:1         | Dracula (default theme) |
| ----------------------------------------- | ------------------ | ----------------------- |
| `textDim`, no opacity utility             | **21 / 21 themes** | 3.03:1                  |
| `opacity-50` on inherited `textMain`      | 15 / 21 themes     | 4.52:1                  |
| `opacity-50` **+** `textDim` (double-dim) | **4 / 21 themes**  | **1.74:1**              |

Double-dimming costs an average of **1.21 contrast points** and fails the 3:1 floor in **17 of 21 themes**. On Dracula the same sentence renders at 1.74:1 instead of 4.52:1 - roughly a **2.6x** readability loss. That is why one description reads fine and the one directly below it looks broken.

### The trap that produces it

Double-dimming is usually inherited, not typed. It happens when:

1. You copy a neighbouring section that already has the bug (`TabBehaviorSection` has 5 instances and is the most-copied section in the tree), or
2. You pass a `textDim`-colored node **into** a component that already applies opacity. `ToggleSettingRow` wraps `description` in `<p className="text-xs opacity-50">`, so `description={<span style={{ color: theme.colors.textDim }}>...` is a cross-file double-dim. Two of these exist today.

**Before copying any section as a template, check it against this rule first.** Prefer copying from `DisplayTab` (audited clean, 0 instances) over `GeneralTab` (19 instances).

---

## 2. Canonical anatomy of a settings section

Every section is: **icon heading -> card -> rows**. Nothing else.

```tsx
import { AtSign } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

export function MyFeatureSection({ theme, value, setValue }: MyFeatureSectionProps) {
	return (
		<div data-setting-id="general-my-feature">
			<SettingsSectionHeading icon={AtSign}>My Feature</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Do the thing"
					description="What happens when the thing is done."
					checked={value}
					onChange={setValue}
					clickableRow
				/>
			</SectionCard>
		</div>
	);
}
```

The outer `<div>` carries `data-setting-id` and nothing else. Do not put padding, margins, or borders on it: vertical rhythm between sections is owned by the tab root (`space-y-5`), not by sections.

---

## 3. Use the primitives. Do not hand-roll.

All four already exist. Hand-rolling them is the root cause of the drift this guide exists to stop.

| Need                                | Use                      | Import from                                               |
| ----------------------------------- | ------------------------ | --------------------------------------------------------- |
| Uppercase section heading + icon    | `SettingsSectionHeading` | `src/renderer/components/Settings/SettingsSectionHeading` |
| The bordered card body              | `SectionCard`            | `.../tabs/DisplayTab/components/SectionCard`              |
| A labelled on/off row               | `ToggleSettingRow`       | `.../tabs/DisplayTab/components/ToggleSettingRow`         |
| A 2-4 way choice                    | `ToggleButtonGroup`      | `src/renderer/components/ToggleButtonGroup`               |
| A bare switch (inside a custom row) | `ToggleSwitch`           | `src/renderer/components/ui/ToggleSwitch`                 |

Current adoption, for context on how much of the tree predates these:

| Tab            | Files | `SettingsSectionHeading` | `ToggleSettingRow` | Double-dim defects |
| -------------- | ----- | ------------------------ | ------------------ | ------------------ |
| **DisplayTab** | 21    | 16 of 18                 | 27 of 28           | **0**              |
| GeneralTab     | 21    | 0 of 18                  | 0 of 10            | 19                 |
| Settings root  | 20    | 0 of 13                  | n/a                | 6                  |
| EncoreTab      | 6     | 0 of 3                   | n/a                | 4                  |

**`DisplayTab` is the reference implementation.** When you need a template, read `ContextWarningsSection.tsx`, `WindowChromeSection.tsx`, or `TabOptionsSection.tsx`. `GeneralTab` sections are legacy markup that has not been migrated; match this guide, not the file you happen to be editing next to.

### `SectionCard` note

`SectionCard` defaults to `className="space-y-3"`, which spaces its children. If you pass a custom `className` you lose that default, so re-add `space-y-3` unless you deliberately want tight packing.

---

## 4. Typography

Only these four roles exist. If you find yourself inventing a fifth, you are probably building something that should be a card of its own.

| Role                  | Classes                                                                 | Color                            |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| Section heading       | via `SettingsSectionHeading` (`text-xs font-bold opacity-70 uppercase`) | inherit (never override)         |
| Setting title         | `font-medium` (or `text-sm font-medium` inside dense rows)              | `theme.colors.textMain`          |
| Description / helper  | `text-xs opacity-50`                                                    | **inherit - do not set a color** |
| Micro-note / footnote | `text-[11px] opacity-40`                                                | inherit                          |

Sizes in use across the tree: `text-xs` (194), `text-sm` (82), `text-[10px]` (30), `text-[11px]` (20). Prefer `text-xs` for descriptions. Reach for `text-[11px]` only for a genuine third-level footnote, and never go below `text-[10px]`.

**Do not set `color` on description text.** Inheriting `textMain` and dimming once with `opacity-50` is the convention (78 instances) and it is what the shared primitives hard-code. Setting `textDim` on top of that is the bug in §1.

---

## 5. Color

Pull every color from `theme.colors`. Never hard-code a hex for text, borders, or surfaces: there are 21 themes including 4 light ones, and a literal will be unreadable in most of them.

| Token                     | Use for                                               |
| ------------------------- | ----------------------------------------------------- |
| `theme.colors.textMain`   | Setting titles, active control labels                 |
| `theme.colors.textDim`    | Standalone secondary text **with no opacity utility** |
| `theme.colors.border`     | Card borders, row dividers                            |
| `theme.colors.bgMain`     | Card fill                                             |
| `theme.colors.bgActivity` | Inset/well fill, inactive control fill                |
| `theme.colors.accentDim`  | Active state of a selected control                    |
| `theme.colors.warning`    | Destructive-adjacent cautions                         |
| `theme.colors.error`      | Validation failures                                   |

Hard-coded hex is acceptable only for semantic data viz where the color _is_ the meaning (the yellow/red threshold dots in `ContextWarningsSection`). Everywhere else it is a bug.

### Warnings

A warning is an icon plus text, colored with `theme.colors.warning`, placed **above** the control it qualifies so it is read before the choice is made:

```tsx
<div className="flex items-start gap-1.5 text-xs mb-2" style={{ color: theme.colors.warning }}>
	<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
	<span>A consulted agent can change files on its own.</span>
</div>
```

`flex-shrink-0 mt-0.5` on the icon is required: without it the icon squashes on narrow modals and sits misaligned against the first text line.

---

## 6. Spacing and order

| Level                  | Rule                                           |
| ---------------------- | ---------------------------------------------- |
| Between sections       | `space-y-5` on the tab root (owned by the tab) |
| Between rows in a card | `space-y-3` (the `SectionCard` default)        |
| Heading -> card        | `mb-2` (baked into `SettingsSectionHeading`)   |
| Title -> description   | `mt-0.5`                                       |
| Description -> control | `mb-2`                                         |

`EncoreTab` uses `space-y-6`; that is a deliberate exception for its larger feature blocks. New tabs use `space-y-5`.

### Vertical order inside a row is fixed

**Title -> description -> warning (if any) -> control.**

Controls go last and full width. Do not put a wide control in a `justify-between` header row beside the title: it renders narrow and right-aligned, which reads as a different design language from every other section. A `ToggleSwitch` is the one exception - it is small and belongs inline on the right, which is exactly what `ToggleSettingRow` does.

`ToggleButtonGroup` buttons are `flex-1`, so they span the container automatically. The component does **not** accept a `className` prop; wrap it in a spacing div if you need margin.

---

## 7. Choosing a control

| Situation                      | Control                                                 |
| ------------------------------ | ------------------------------------------------------- |
| Boolean                        | `ToggleSettingRow` (with `clickableRow`)                |
| 2-4 mutually exclusive options | `ToggleButtonGroup`                                     |
| 5+ options                     | Native `<select>`, themed                               |
| Bounded numeric with feel      | `<input type="range">`                                  |
| Precise numeric                | `<input type="number">` in a themed wrapper             |
| Free text / paths              | `FormInput` from `src/renderer/components/ui/FormInput` |

Set `clickableRow` on `ToggleSettingRow` so the whole row is a hit target. It already wires `role="button"`, `tabIndex`, and Enter/Space handling; do not re-implement that.

---

## 8. Copy

- **Titles**: sentence case, no trailing period. "Automatically name tabs based on first message".
- **Descriptions**: complete sentences with a period. Say what happens, not what the control is.
- **Never hard-code modifier keys.** Use `formatMetaKey()` / `formatShortcutKeys()` from `src/renderer/utils/shortcutFormatter` or the copy is wrong on the other platform.
- **No em-dashes or en-dashes** anywhere (repo-wide rule). Spaced hyphen, comma, or two sentences.
- Descriptions that change with state should read as the _current_ state, not the available action.

---

## 9. Registration checklist

A settings control is not done when it renders. All six steps or it will not persist, will not survive restart, or will not be findable:

1. `src/shared/settingsMetadata.ts` - add to `SETTINGS_METADATA` with `description`, `type`, `default`, `category`.
2. `src/renderer/stores/settingsStore.ts` - **five** edits: interface field, setter signature, initial-state default, setter action (which must call `window.maestro.settings.set`), and the `allSettings[...]` hydration mapping. Skipping hydration is the classic "setting resets on restart" bug.
3. `src/renderer/hooks/settings/useSettings.ts` - add the field and setter to `UseSettingsReturn`. The store is spread at runtime, but the type is curated, so TS fails without this.
4. `src/main/stores/defaults.ts` - **only** if `MaestroSettings` requires the key. Editor/input-behavior settings deliberately do not live here; their default comes from `settingsMetadata.ts`.
5. `src/renderer/components/Settings/searchableSettings.ts` - add a `SearchableSetting` whose `id` exactly matches the `data-setting-id` on your section root. Put every user-visible string from the section into `keywords`.
6. Render it and thread props from the tab.

`searchableSettings.test.ts` enforces DOM parity in both directions: a `data-setting-id` with no registry entry fails, and a registry entry with no `data-setting-id` fails. It also asserts that specific user-typed phrases surface your section, so add your visible strings to that `it.each` table.

---

## 10. Review checklist

Before you call a settings change done:

- [ ] No element has both an `opacity-*` utility and `theme.colors.textDim`
- [ ] No `textDim`-colored node passed into `ToggleSettingRow`'s `description`
- [ ] `SettingsSectionHeading` used, with a Lucide icon
- [ ] `SectionCard` used for the body
- [ ] Order is title -> description -> warning -> control
- [ ] Control spans full width (except an inline `ToggleSwitch`)
- [ ] No hard-coded hex, no hard-coded `Cmd`/`Ctrl`
- [ ] `data-setting-id` matches the `searchableSettings.ts` entry
- [ ] Checked against a light theme (`github-light`) and a low-contrast one (`solarized-dark`)
- [ ] `npm run lint` and `lint:eslint` clean

---

## 11. Known debt and remediation options

The audit found four classes of drift. None are urgent; all are listed so a future agent can pick one up deliberately instead of half-fixing it in passing.

### A. Double-dim defects (29 instances)

The readability bug in §1. `GeneralTab` 19, `Settings root` 6, `EncoreTab` 4, `ShortcutsTab` 1, plus 2 cross-component instances via `ToggleSettingRow`.

- **A1 (recommended, low risk):** strip the `color: theme.colors.textDim` override from every element that also carries an `opacity-*` utility. Purely subtractive, no layout change, immediately fixes contrast in 17 themes.
- **A2:** strip the `opacity-*` utility instead and keep `textDim`. Also correct, and scores 21/21 on contrast, but changes the look of far more surfaces since `opacity-50` is the dominant existing convention.
- **A3:** add an ESLint rule or a unit test that fails when a `className` containing `opacity-` sits on an element whose `style` sets `textDim`. Prevents regression permanently; catches the copy-paste vector that keeps reintroducing this.

### B. `GeneralTab` has not been migrated to the primitives

18 hand-rolled headings, 10 raw `ToggleSwitch` rows, 0 `SectionCard`.

- **B1:** migrate headings only. 18 mechanical replacements, near-zero risk, removes the most-copied source of bad markup.
- **B2:** migrate headings + `SectionCard`. Also normalises padding and border color.
- **B3:** full migration including `ToggleSettingRow`. Highest consistency payoff, but each row needs its click/keyboard behaviour checked, so it warrants its own PR.
- **B4:** migrate only sections you are already touching. Slowest to converge, lowest risk of a large diff.

### C. Six themes fail 3:1 for `opacity-50` secondary text even without double-dimming

`solarized-dark`, `solarized-light`, `one-light`, and three others sit under the WCAG floor for correctly-written single-dim text.

- **C1:** raise `textDim`/`textMain` contrast in just those six theme definitions. Fixes the root cause once, touches no components.
- **C2:** move descriptions from `opacity-50` to `opacity-60`. One-line change per site, recovers most of the gap, slightly brightens every theme.
- **C3:** switch descriptions globally to `textDim` with no opacity (21/21 pass). Cleanest semantically, largest visual diff.
- **C4:** accept and document. These are opt-in low-contrast themes.

### D. Heading markup has ten spelling variants

39 hand-rolled headings across 10 distinct class strings (`mb-1` vs `mb-2` vs `mb-3`, with and without `opacity-70`, with and without the icon flex).

- **D1:** replace all 39 with `SettingsSectionHeading`. Subsumes B1 and collapses ten variants to one.
- **D2:** extend `SettingsSectionHeading` with an optional `description` slot, since the heading is followed by an intro paragraph in ~12 sections that each style it slightly differently.

---

## 12. Where the canon lives

If this guide and the code disagree, the code wins **only** for `DisplayTab`, which is the audited reference. Anywhere else, this guide wins and the code is debt.

When you establish a genuinely new pattern, add it here in the same turn. A pattern that is not written down is a pattern the next agent will re-invent slightly differently, which is how the tree reached ten heading variants.
