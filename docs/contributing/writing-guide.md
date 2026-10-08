# Writing guide

How we write tmux-ide's docs, landing copy, README and agent-facing manuals.
Truth comes first: every claim must trace to the
[product-truth ledger](./product-truth-ledger.md). This guide covers how to say
it.

## Voice

- **Plain and direct.** Write like a colleague explaining the tool at their
  desk. No hype, no exclamation marks, no selling.
- **Second person, present tense.** "You can rename a pane from its menu," not
  "Users are able to rename panes."
- **Imperative for steps.** "Open Commands with `F5`," not "You will want to
  open Commands."
- **Show, then stop.** Prefer a command, a table or an example over a paragraph
  describing it. One sentence of context before a code block is usually enough.
- **State limits plainly, in the body.** Say what doesn't work in the same
  calm voice as what does. Don't hide limits in footnotes, and don't apologize.

## Sentences and paragraphs

- Aim for 10–20 words per sentence. Split anything over 30.
- Keep paragraphs to 2–4 sentences.
- One idea per sentence. If a sentence needs a semicolon and a dash, it's two
  sentences.
- Put the subject and verb early. Lead with what the reader does or gets.

Before (multi-agent-teams):

> tmux-ide doesn't just watch one agent — it lets a **team of agents work
> together**, and they don't have to be the same tool. A Claude Code lead, a
> codex pane, a cursor-agent pane, and an `aider` pane can share one fleet and
> coordinate through tmux-ide's primitives. Nothing here is aspirational: it's
> the same `send`, `wait`, `events`, and `team` commands documented elsewhere,
> pointed at each other.

After:

> Agents in different panes can work as a team, even when they are different
> tools. They coordinate with the same `send`, `wait`, `events` and `team`
> commands documented elsewhere, pointed at each other.

## Openings: answer first

Every page opens with one or two sentences that answer "what is this and what
does it let me do?" before anything else. That opening should still make sense
when quoted on its own, because search results and AI assistants quote it out of
context.

- Use a definition pattern for concept pages: "Agent detection is how tmux-ide
  knows whether an agent is working, blocked, done or idle."
- Use an outcome for task pages: "`tmux-ide restore` rebuilds your tmux
  sessions after the server crashes."
- Name the product and the subject in the first sentence. Don't open with
  "This page…", a story or a rhetorical question.
- Apply the same rule to each H2 section: its first sentence answers the
  heading.

Before (agent-detection):

> The whole point is trust: when an agent can tell you the truth, tmux-ide
> believes it; when it can't, tmux-ide reasons transparently and lets you
> correct it.

After:

> tmux-ide trusts an agent's own report first. When there is none, it reads the
> pane's process and screen, and shows you exactly how it decided.

## Stating limits

- Use "does not", "is not part of 2.9" or "requires", followed by the
  workaround if one exists.
- Give a "What it does not do" or "Not in this release" list when a feature has
  several limits. See the Claude Code agent teams section of
  `multi-agent-teams.mdx`.
- Never present quarantined, legacy or schema-only features as available, even
  as "coming soon". Don't promise dates.

Before (restore-resume): "Honest status of both:"

After: "Support differs by agent:"

## Words

### Preferred terms

Use these consistently, with this capitalization:

| Term                         | Means                                            | Don't write                                                   |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| the app                      | `tmux-ide app`, the full-screen terminal app     | the OpenTUI, the unified app, the IDE, the TUI (in user docs) |
| Home                         | The `F1` surface                                 | home screen, cockpit, dashboard                               |
| Terminals                    | The `F2` surface                                 | Terminal tab, terminal view                                   |
| Commands                     | The `F5` palette                                 | command palette (except once, to explain), Ctrl+P             |
| Sessions, Attention          | The `F6` and `F7` pickers                        | switcher (in the app)                                         |
| tmux chrome                  | What `tmux-ide adopt` adds to plain tmux clients | the dock (except in the page slug), cockpit                   |
| agent                        | A coding agent process running in a pane         | bot, AI, worker (unless quoting a role)                       |
| pane, window, session        | tmux's own objects, lowercase                    | tab (for a window), workspace (for a session)                 |
| machine                      | Your computer or an SSH host                     | host, server (except tmux server)                             |
| tmux server                  | One running tmux server                          | server (alone)                                                |
| teammate                     | A member of a Claude Code agent team             | sub-agent, worker                                             |
| Claude Code, Codex           | The products, capitalized                        | claude, codex (except as commands)                            |
| working, blocked, done, idle | Agent states, lowercase in prose                 | busy, waiting, finished                                       |

Write keys as `F5`, `Ctrl+K`, `Shift+click`, `Alt+Arrow`. Write tmux chrome keys
as `prefix h`, with the `⌥` key as the secondary form.

### Banned filler

Cut these words and phrases, or replace them with something specific.
`check-product-docs.mjs` fails the docs build on the clearest ones (simply,
seamless, powerful, leverage, utilize, in order to, and similar):

- just, simply, easily, seamlessly, effortlessly, of course, obviously
- powerful, robust, blazing, magic, revolutionary, next-generation, world-class
- leverage, utilize (use "use"), in order to (use "to"), allows you to (use "lets you", or the verb)
- note that, it's worth noting, it's important to, keep in mind
- delve, dive into, unlock, empower, elevate, supercharge, game-changer
- "Nothing here is aspirational", "honest", "the whole point", "no risk"
- marketing intensifiers on facts: "truly", "really", "very", "incredibly"

Don't name competing products. Name other tools only when tmux-ide integrates
with them (Claude Code, Codex, tmux, iTerm2).

## Headings

- Sentence case: "Connect to another machine over SSH", not "Connect To Another
  Machine Over SSH".
- Task pages use verbs: "Open a session", "Choose a theme". Reference pages use
  nouns: "Global config", "Theme presets".
- A heading that matches a question people ask is good: "Does it work over
  SSH?" fits FAQs. In docs, prefer the task form.
- No numbering in headings, except steps in a procedure. No trailing
  punctuation. Use code formatting only for literal names (`` `theme` ``).
- H1 comes from the frontmatter `title`. Start the body at H2. Don't skip
  levels.
- Keep headings stable. Other pages link to their anchors, and
  `check-product-docs.mjs` fails on a broken anchor.

## Frontmatter

```yaml
---
title: Restore and resume
description: "Rebuild every tmux session after a server crash with tmux-ide restore: windows, layouts, directories, titles, and agent conversations."
---
```

- `title`: two to four words in sentence case that make sense out of context.
  The site appends " | tmux-ide". Proper nouns keep their capitals ("Claude
  Code", "Home"); write "and", not "&".
- `metaTitle` (optional): a search title of at most 49 characters, used only for
  the browser title and social cards. Add one when the short `title` lacks the
  words people search for ("Restore tmux sessions and resume agents" for
  "Restore and resume"). Each must be unique.
- `description`: 110–155 characters, one sentence, ending with a period. Say
  what the page lets the reader do, and put the key phrase first.
- Quote the description if it contains `: `, or the YAML breaks.

## Commands and code

- Introduce a block with one sentence that says what it does, ending in a
  colon: "Preview the plan without touching tmux:".
- Use `bash` for shell commands and `json` or `yaml` for config. Don't use a
  `$` prompt.
- Put short explanations in trailing `#` comments, aligned, only when a block
  has several commands.
- Every command must exist in `tmux-ide --help` for this release. Run it, or
  read `bin/cli.ts`, before documenting a flag.
- Show the smallest working example first, then options in a table.
- Option tables use the columns Flag/Field, Default and Effect. Defaults come
  from source (`lib/app-config.ts`, `--help`), never from memory.
- Don't use diagrams that need a renderer (mermaid). Use a table, a list or an
  ASCII sketch.

## Links

- Link the first mention of another page's topic, with descriptive anchor text:
  "see [Agent detection](/docs/agent-detection)", not "see [here](...)".
- Aim for 2–5 internal links per page. End task pages with a short "See also"
  list.
- Link external docs only where tmux-ide depends on them (for example Claude
  Code's agent teams page).

## Landing copy and README

The same rules apply, with shorter sentences. Use concrete nouns and real key
names, not abstractions. The tagline is "The open-source workspace for coding
agents." Don't use numbers that aren't measured and sourced.

## Checklist before you commit

- Every claim traces to the ledger or source on `main`.
- The page opens with an answer, and each H2 opens with one.
- There are no banned words and no unknown terms (see the term table).
- Code blocks are introduced, runnable and current.
- The description is 110–155 characters; headings are sentence case.
- `pnpm docs:build` passes.
