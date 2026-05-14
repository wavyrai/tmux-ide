# T3 → tmux-ide design mapping

**Status**: audit. No CSS edits land from this doc — the deliverable is a
concrete proposal for follow-up PRs.

**Sources consulted**:

- T3: `context/t3code/apps/web/src/index.css`,
  `context/t3code/apps/web/src/components/chat/MessagesTimeline.tsx`,
  `context/t3code/apps/web/src/components/Sidebar.tsx`,
  `context/t3code/apps/web/src/components/settings/SettingsPanels.tsx`
- Ours: `dashboard/app/globals.css`, `dashboard/app/tui-global.css`,
  `dashboard/components/chat-v2/{ChatV2Root,TurnBlock,ThreadListRail,ComposerInput}.tsx`,
  `dashboard/components/settings/SettingsView.tsx`,
  `dashboard/components/mission/MissionView.tsx`

---

## 1. T3 tokens

T3 declares tokens in `@theme inline` (Tailwind v4) so every token is
also a Tailwind utility. Foreground colors are paired with each surface
color so `text-card-foreground` always matches `bg-card`.

### 1A. Spacing / radius

| Token          | Value                          | Used as               | Source         |
| -------------- | ------------------------------ | --------------------- | -------------- |
| `--radius`     | `0.625rem` (10px)              | base scale anchor     | `index.css:88` |
| `--radius-sm`  | `calc(--radius - 4px)` = 6px   | inline chips, code    | `index.css:34` |
| `--radius-md`  | `calc(--radius - 2px)` = 8px   | small buttons, badges | `:35`          |
| `--radius-lg`  | `--radius` = 10px              | cards, dropdowns      | `:36`          |
| `--radius-xl`  | `calc(--radius + 4px)` = 14px  | composer, sections    | `:37`          |
| `--radius-2xl` | `calc(--radius + 8px)` = 18px  | message bubbles       | `:38`          |
| `--radius-3xl` | `calc(--radius + 12px)` = 22px | hero panels           | `:39`          |
| `--radius-4xl` | `calc(--radius + 16px)` = 26px | feature surfaces      | `:40`          |

T3 leans on Tailwind's default spacing scale (`0.5/1/1.5/2/2.5/3/4/5/6`)
and uses half-steps liberally — `gap-1.5`, `px-2.5`, `mt-1.5`, `py-0.5`.

### 1B. Typography

| Token                    | Value                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body font                | `"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` (`index.css:148-154`)                                                           |
| Code font                | `"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace` (`:194`)                                                                             |
| Heading sizes            | Tailwind defaults (`text-sm` 14px, `text-base` 16px, `text-lg` 18px, `text-xl` 20px). Most chrome lives at `text-xs` (12px) and `text-[10px]` (uppercase labels). |
| Uppercase label tracking | `tracking-[0.14em]` (MessagesTimeline.tsx:398)                                                                                                                    |
| Inline code              | `font-size: 0.75rem` + `padding: 0.1rem 0.35rem` + `border-radius: 0.375rem` + `border: 1px solid var(--border)` (`:343-350`)                                     |

### 1C. Color system

Colors are declared once on `:root`, redefined inside `@variant dark`,
and exposed to Tailwind via `--color-X: var(--X)` so utilities like
`bg-card`, `text-muted-foreground`, `border-border` work.

| Token pair                               | Light                            | Dark                             | Use                     |
| ---------------------------------------- | -------------------------------- | -------------------------------- | ----------------------- |
| `background` / `foreground`              | white / neutral-800              | neutral-950 mix / neutral-100    | page chrome             |
| `card` / `card-foreground`               | white                            | bg + 2% white                    | message bubbles, panels |
| `popover` / `popover-foreground`         | white                            | bg + 2% white                    | dropdowns               |
| `primary` / `primary-foreground`         | `oklch(0.488 0.217 264)` / white | `oklch(0.588 0.217 264)` / white | accent button           |
| `secondary` / `secondary-foreground`     | black @ 4% / neutral-800         | white @ 4% / neutral-100         | subdued surface         |
| `muted` / `muted-foreground`             | black @ 4% / neutral-500 mix     | white @ 4% / neutral-500 mix     | meta text               |
| `accent` / `accent-foreground`           | black @ 4% / neutral-800         | white @ 4% / neutral-100         | hover state             |
| `destructive` / `destructive-foreground` | red-500 / red-700                | red-500 mix / red-400            | errors                  |
| `info` / `info-foreground`               | blue-500 / blue-700              | blue-500 / blue-400              | links, info             |
| `success` / `success-foreground`         | emerald-500 / emerald-700        | emerald-500 / emerald-400        | success state           |
| `warning` / `warning-foreground`         | amber-500 / amber-700            | amber-500 / amber-400            | warning state           |
| `border`                                 | black @ 8%                       | white @ 6%                       | hairlines               |
| `input`                                  | black @ 10%                      | white @ 8%                       | field borders           |
| `ring`                                   | same as primary                  | same as primary                  | focus ring              |

Two characteristics:

- **Alpha-overlay surfaces.** `secondary`/`muted`/`accent` are
  `--alpha(var(--color-black) / 4%)` — they don't introduce new hues,
  they tint the background. This guarantees coherent surface tones
  across themes.
- **Foreground pairing.** Every surface token has a matching foreground
  token, so Tailwind's `text-card-foreground` / `bg-card` combo always
  reads as designed.

### 1D. Density patterns (sampled)

| Surface                   | Tailwind classes                                                                                                               | Source                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| User chat bubble          | `max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3`                                            | `MessagesTimeline.tsx:309` |
| Assistant copy            | `whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground`                                                  | `:732`                     |
| Section label (uppercase) | `rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80` | `:398`                     |
| Inline meta row           | `mt-1.5 flex items-center justify-end gap-2` then `text-xs text-muted-foreground/50`                                           | `:352, :370`               |
| Sidebar menu item         | `h-6 w-full justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80`  | `Sidebar.tsx:852-857`      |
| Card (small)              | `rounded-xl border border-border/45 bg-card/25 px-2 py-1.5`                                                                    | `MessagesTimeline.tsx:545` |
| Card (medium)             | `rounded-lg border border-border/80 bg-card/45 p-2.5`                                                                          | `:626`                     |
| Settings row              | `flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5`                            | `SettingsPanels.tsx:1444`  |
| Settings title            | `truncate text-sm font-medium text-foreground`                                                                                 | `:1457`                    |
| Settings sub              | `text-xs text-muted-foreground`                                                                                                | `:1458`                    |
| Chat button               | `h-7 shrink-0 cursor-pointer gap-1.5 px-2.5`                                                                                   | `:1468`                    |

**Hierarchy ladder**:
`text-base` body (rare) → `text-sm` chat copy → `text-xs` meta →
`text-[11px]` dense badges → `text-[10px]` uppercase labels (with
`tracking-[0.14em]`).

**Opacity sugar**: t3 leans on alpha-divided foregrounds
(`text-muted-foreground/50`, `bg-card/25`, `border-border/45`) for
near-states. That requires colors registered with Tailwind's color
machinery so `/N` works.

---

## 2. tmux-ide tokens (current)

Declared in `dashboard/app/globals.css` + `dashboard/app/tui-global.css`

- `dashboard/app/tui-bridge.css`. Tailwind v4 is loaded (`@import
"tailwindcss"`) but tokens are **not** registered via `@theme` — they
  live on `:root` as plain CSS variables, so utilities like
  `bg-[var(--bg)]` work but `bg-card` / `text-muted-foreground` do not.

### 2A. Spacing / radius

| Token        | Value                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Radius scale | **None defined.** Components use ad-hoc `rounded`, `rounded-md`, `rounded-full` (Tailwind defaults: 4/6/9999px). No `--radius` anywhere. |
| Spacing      | Tailwind defaults. Components use integer steps (`p-2`, `p-3`, `p-4`, `gap-2`, `gap-3`) far more than half-steps.                        |

### 2B. Typography

| Token                    | Value                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Body font                | `--font-mono = "Berkeley Mono", ui-monospace, …` — **monospace by default** (`globals.css:104`)            |
| Code font                | Same `--font-mono`                                                                                         |
| TUI body line-height     | `--theme-line-height-base: 1.25` (`tui-global.css:252`)                                                    |
| TUI base font-size       | `--font-size: 16px`                                                                                        |
| Heading sizes            | Tailwind defaults; components reach for `text-[12px]`, `text-[11px]`, `text-[10px]`, `text-[9px]` directly |
| Inline code styling      | **None** — no rule in `globals.css` for `code` or `pre`                                                    |
| Uppercase label tracking | `tracking-wider` (CSS default 0.05em) — less explicit than t3's `tracking-[0.14em]`                        |

### 2C. Color system

| Surface (ours)                            | Dark default       | Approx t3 equivalent                                                          |
| ----------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `--bg` `#101010`                          | flat black         | `background`                                                                  |
| `--bg-weak` `#1e1e1e`                     | one step up        | — (no direct equivalent; t3 has card and popover at slightly different mixes) |
| `--bg-strong` `#121212`                   | titlebar / sidebar | —                                                                             |
| `--surface` rgba(255,255,255,3.1%)        | hover tint         | `accent` (4%)                                                                 |
| `--surface-raised` rgba(255,255,255,5.9%) | card               | `secondary` (4%) — close                                                      |
| `--surface-elevated` `#161616`            | popover, dropdown  | `popover` / `card`                                                            |
| `--fg` rgba(255,255,255,93.6%)            | primary text       | `foreground`                                                                  |
| `--fg-secondary` rgba(255,255,255,61.8%)  | secondary text     | `secondary-foreground`                                                        |
| `--dim` rgba(255,255,255,42.2%)           | meta               | `muted-foreground`                                                            |
| `--dimmer` rgba(255,255,255,28.4%)        | placeholder        | `muted-foreground/50`                                                         |
| `--border` rgba(255,255,255,19.5%)        | hairline           | `border` (6% in dark) — **ours is 3× t3's contrast**                          |
| `--border-weak` `#282828`                 | subtle hairline    | `border`                                                                      |
| `--accent` `#fab283`                      | warm amber         | `primary` (blue)                                                              |
| `--green/--yellow/--red/--cyan/--magenta` | raw 16-color tones | `success/warning/destructive/info` (we have no `-foreground` pair)            |
| `--ai-color/-bg/-badge`                   | indigo track       | — (no equivalent — agent attribution is theme-specific)                       |
| `--human-color/-bg/-badge`                | mint track         | —                                                                             |

We carry **9 themes** (`dark/light/catppuccin/dracula/tokyonight/solarized-dark/solarized-light/gruvbox-dark/gruvbox-light` per `globals.css`) which is a much wider matrix than t3's light+dark.

### 2D. Density patterns (sampled)

| Surface            | Tailwind classes                                                                                                                         | Source                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Turn block         | `flex flex-col gap-1 border-t border-[var(--border-weak)] px-2 py-2`                                                                     | `TurnBlock.tsx:75`      |
| Turn header        | `flex items-center gap-2 text-[11px]`                                                                                                    | `TurnBlock.tsx:77`      |
| Thread list header | `flex h-8 items-center justify-between border-b border-[var(--border-weak)] px-3 text-[10px] uppercase tracking-wider text-[var(--dim)]` | `ThreadListRail.tsx:47` |
| Thread list item   | `flex w-full flex-col px-3 py-1.5 text-left text-[11px]`                                                                                 | `:81`                   |
| Thread item tag    | `rounded bg-[var(--surface)] px-1 py-px text-[9px] uppercase tracking-wider`                                                             | `:100`                  |
| Composer row       | `flex items-end gap-2 border-t border-[var(--border)] bg-[var(--bg-strong)] px-3 py-2`                                                   | `ComposerInput.tsx:34`  |
| Composer textarea  | `flex-1 resize-none rounded border border-[var(--border-weak)] bg-[var(--surface)] px-2 py-1 text-[12px] text-[var(--fg)]`               | `:44`                   |
| Settings row       | `grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-[var(--border-weak)] py-3`                                                    | `SettingsView.tsx:52`   |
| Settings main      | `min-w-0 flex-1 space-y-5 overflow-auto p-4`                                                                                             | `:139`                  |
| Settings input     | `rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px]`                                                     | `:156`                  |
| Mission panel body | `space-y-4 p-4`                                                                                                                          | `MissionView.tsx`       |
| Mission card       | `max-w-md p-5`                                                                                                                           | `MissionView.tsx`       |
| Mission menu item  | `flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]`                                                                       | `MissionView.tsx`       |

**Hierarchy ladder**: `text-[12px]` body, `text-[11px]` meta, `text-[10px]`/`text-[9px]` labels. **2 px tighter than t3** at every level.

---

## 3. Delta

| #   | Gap                                    | Today                                               | T3                                                     |
| --- | -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| 1   | No radius scale                        | ad-hoc `rounded` / `rounded-md`                     | `--radius` × 7 stops (6 → 26 px)                       |
| 2   | Tokens unregistered with Tailwind      | `bg-[var(--surface)]` everywhere                    | `bg-card`, `text-muted-foreground`                     |
| 3   | No alpha-divided opacity sugar         | hand-roll new colors for transparency               | `bg-card/25`, `text-muted-foreground/60`               |
| 4   | No semantic foreground pairing         | `--fg` / `--fg-secondary` / `--dim` are independent | every surface has a `-foreground` pair                 |
| 5   | No status foregrounds                  | raw `--red`, `--green`, `--yellow`                  | `destructive`/`destructive-foreground`, etc.           |
| 6   | Body font is monospace                 | comfortable for terminal, cramped for prose         | DM Sans body + SF Mono code                            |
| 7   | Letter spacing on labels less explicit | `tracking-wider` (0.05em)                           | `tracking-[0.14em]`                                    |
| 8   | No inline-code styling                 | bare `<code>` renders as plain text                 | full markdown code styling in `index.css:343-350`      |
| 9   | Density 1–2 px tighter than t3         | composer `px-3 py-2`, settings input `px-2 py-1`    | composer-equivalent `h-7 px-2.5`, settings `px-4 py-3` |
| 10  | Border too high-contrast in dark       | `rgba(255,255,255,19.5%)`                           | `rgba(255,255,255,6%)`                                 |
| 11  | Surface hierarchy underused            | most components reach for `--bg-strong`             | t3 uses card/popover/secondary distinctly              |
| 12  | No `--ease-*` / motion tokens applied  | `--ease-out-fluid` defined but unused in components | t3 hand-codes `transition-colors duration-200`         |

---

## 4. Recommended adoption (5 PRs)

### PR 1 — Radius scale + `@theme` registration

**Files**: `dashboard/app/globals.css`

Add a t3-style `@theme inline` block that registers our existing
custom-properties as Tailwind tokens AND introduces a radius scale:

```css
@theme inline {
  --radius: 0.625rem;
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --radius-2xl: calc(var(--radius) + 8px);
  --radius-3xl: calc(var(--radius) + 12px);

  /* register existing tokens so Tailwind utilities work */
  --color-background: var(--bg);
  --color-foreground: var(--fg);
  --color-card: var(--surface-elevated);
  --color-card-foreground: var(--fg);
  --color-popover: var(--surface-elevated);
  --color-popover-foreground: var(--fg);
  --color-muted: var(--surface);
  --color-muted-foreground: var(--dim);
  --color-accent: var(--surface-active);
  --color-accent-foreground: var(--fg);
  --color-secondary: var(--surface-raised);
  --color-secondary-foreground: var(--fg);
  --color-border: var(--border);
  --color-input: var(--border);
  --color-ring: var(--accent);
  --color-primary: var(--accent);
  --color-primary-foreground: var(--bg);
  --color-destructive: var(--red);
  --color-destructive-foreground: var(--bg);
  --color-success: var(--green);
  --color-warning: var(--yellow);
}
```

**Acceptance**: `<div className="rounded-lg bg-card text-card-foreground border border-border">` renders correctly in every theme. **Effort**: S. **Risk**: tiny — additive only.

### PR 2 — Tighten dark border + introduce foreground pairs for status colors

**Files**: `dashboard/app/globals.css` (all themes)

Halve the default dark `--border` (19.5% → 8%, matching t3's
black/white-alpha pattern), and add `--red-foreground`, `--green-foreground`,
`--yellow-foreground`, `--info-foreground`, plus register them in the
`@theme` block. Apply the same shift to every theme.

**Acceptance**: dashboard at dark theme looks noticeably less "boxed";
status pills can use `text-destructive-foreground` against `bg-destructive`.
**Effort**: S. **Risk**: visual diff — needs screenshot review per theme.

### PR 3 — Two-font story: body sans + chrome mono

**Files**: `dashboard/app/globals.css`, `dashboard/app/tui-fonts.css`,
`tailwind.config` (or `@theme` font registration)

Introduce a `--font-sans` token (default DM Sans → system stack), keep
`--font-mono` for code/tui. Set `body { font-family: var(--font-sans) }`
for **non-terminal surfaces** (chat copy, settings labels, mission KPIs).
Keep `--font-mono` on `.tui-*`, terminal, `code`/`pre`.

```css
:root {
  --font-sans:
    "Geist", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
```

**Acceptance**: chat assistant copy reads at native font weights; tui
panes unchanged. **Effort**: M (touches every component that _should_
opt into sans — chat-v2/_, settings/_, mission/\*). **Risk**: visual
diff requiring per-component approval. Consider gating behind a
`font-feel=mono|hybrid` user preference.

### PR 4 — Inline code + markdown styling parity

**Files**: `dashboard/app/globals.css` (new `.chat-markdown` block
mirroring t3 `index.css:273-486`)

Port t3's chat-markdown block (inline `code` border + padding + radius,
`pre` wrap + border, `blockquote` left rule, list spacing, file-link
chip styling, copy-button). Apply class on
`dashboard/components/chat-v2/*` text-bearing surfaces.

**Acceptance**: paste a long assistant message with inline `code`, fenced
code, lists, blockquote; visual matches t3 within ±2 px. **Effort**: S.
**Risk**: low — purely additive selectors scoped under `.chat-markdown`.

### PR 5 — Density nudge on three specific surfaces

**Files**: see §5 below. Apply the per-component recommendations.

**Effort**: M per surface (component-by-component review). **Risk**:
medium — visible product change; should ship behind a feature flag
during rollout if the team needs A/B.

---

## 5. Component-level recommendations

### 5A. `dashboard/components/chat-v2/TurnBlock.tsx` ↔ t3 `MessagesTimeline.tsx`

| Surface                | Today                                                                | Proposed                                                                                   | T3 anchor                                                                                                |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Container              | `flex flex-col gap-1 border-t border-[var(--border-weak)] px-2 py-2` | `flex flex-col gap-1.5 border-t border-border/60 px-3 py-3`                                | not directly equivalent — t3 has no "turn block" wrapper; messages float on the page with `px-3 sm:px-5` |
| Header row             | `flex items-center gap-2 text-[11px]`                                | `flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80` | section-label pattern at `MessagesTimeline.tsx:398`                                                      |
| Ambient activity stack | `flex flex-col gap-0.5 px-2 py-1`                                    | `flex flex-col gap-1 px-2.5 py-1.5`                                                        | "small card" pattern at `MessagesTimeline.tsx:545`                                                       |
| Inline border color    | `border-[var(--border-weak)]`                                        | `border-border/45` once `--border` is softened (PR 2)                                      | t3 uses `border-border/45` on cards                                                                      |
| Per-line text          | `text-[11px]`                                                        | `text-[11px]` (keep — t3 also uses 11px for dense work-log)                                | `MessagesTimeline.tsx:992`                                                                               |

### 5B. `dashboard/components/settings/SettingsView.tsx` ↔ t3 `SettingsPanels.tsx`

| Surface             | Today                                                                                 | Proposed                                                                                                                                                                         | T3 anchor                              |
| ------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Page main pad       | `p-4`                                                                                 | `p-4 sm:p-5` (match t3 responsive bump)                                                                                                                                          | `:139` vs `SettingsPanels.tsx:1444`    |
| Section row         | `grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-[var(--border-weak)] py-3` | `grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5` (switch to `border-t`, drop the bottom border on last, add horizontal pad) | `SettingsPanels.tsx:1444`              |
| Section title       | (varies)                                                                              | `truncate text-sm font-medium text-foreground`                                                                                                                                   | `:1457`                                |
| Section sub         | (varies)                                                                              | `text-xs text-muted-foreground`                                                                                                                                                  | `:1458`                                |
| Input               | `rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px]`  | `rounded-md border border-input bg-background px-2.5 py-1.5 text-xs` (token-name swap once PR 1 lands; bump pad to 2.5/1.5)                                                      | matches t3 button heights `h-7 px-2.5` |
| Section gap         | `space-y-5`                                                                           | `space-y-4` (t3 uses 4-unit rhythm in panels)                                                                                                                                    | `MissionView` `space-y-4 p-4`          |
| Theme swatches grid | `grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3`                                | `grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3` (bump gap; cards need air)                                                                                                | —                                      |

### 5C. `dashboard/components/mission/MissionView.tsx` ↔ t3 (no direct equivalent; pattern from `Sidebar.tsx` cards)

| Surface          | Today                                                              | Proposed                                                                                                                                    | T3 anchor                                                   |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| PanelBody        | `space-y-4 p-4`                                                    | `space-y-4 p-4 sm:p-5`                                                                                                                      | keeps 4-unit rhythm; bumps responsive pad to match settings |
| KPI strip card   | inferred medium card                                               | wrap in `rounded-lg border border-border/45 bg-card/25 px-3 py-2.5` once tokens registered                                                  | `MessagesTimeline.tsx:626`                                  |
| Empty-state card | `max-w-md p-5`                                                     | `max-w-md p-5 rounded-2xl border border-border/45 bg-card/25`                                                                               | t3 uses `rounded-2xl` for hero/empty surfaces               |
| Menu item        | `flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]` | `flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground`         | `Sidebar.tsx:852`                                           |
| Inline code chip | `inline-flex rounded-md bg-[var(--surface)] px-2 py-1 text-[11px]` | `inline-flex rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-mono` (border + tighter pad-y; opt into mono explicitly) | `index.css:343-350`                                         |

---

## 6. Risks & open questions

1. **Tailwind v4 `@theme` interaction with existing `--bg`/`--fg` tokens.** PR 1 keeps the original names AND adds `--color-*` aliases; rolling back is removing the aliases. Verify the cascade is stable across all 9 themes.
2. **Mono-by-default is a deliberate aesthetic choice for terminal-UI users.** Before shipping PR 3, surface a user preference (or A/B). Memory note: `feedback_design_reference.md` says lean into t3 — interpret that as "warmer body type for prose surfaces" not "abandon Berkeley Mono in tui panes".
3. **Border-contrast change (PR 2) is visible.** Run screenshot diffs per theme; tokyonight/gruvbox already use lower-contrast borders so the change there is small, but dark/dracula will look softer.
4. **The Solid silos (`@tmux-ide/chat-solid`, `@tmux-ide/v2-solid-widgets`) read their own theme via CSS custom properties.** All proposals here are token-level so the silos inherit them automatically — the bridge components don't need code changes. Verify after PR 1 that chat-solid still renders correctly (it uses `var(--bg)`, `var(--fg)`, `var(--accent)` directly, so it should).
5. **Memory cross-link**: per `feedback_architecture_preferences.md`, RSC orchestrates and Solid silos handle perf islands. The token layer is _shared substrate_ — PR 1 reinforces that boundary by giving both sides the same Tailwind-registered token surface, so a silo and an RSC card can sit next to each other and look uniform.
