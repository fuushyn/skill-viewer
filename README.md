# Skill Viewer

See what your agent skills are actually telling the model. Paste a SKILL.md, drop a folder, or link a skill — get the positive/negative instruction ledger, conflicts, the primacy/recency attention curve, description scorecard and budgets. Optional LLM review with your own OpenRouter key.

**Live:** https://fuushyn.github.io/skill-viewer/

## What it checks

- **Instruction ledger** — every line classified positive prompt / negative prompt / hard MUST; every prohibition checked for a stated replacement ("don't use excessive branding" without "use branding here" drags the banned behavior into context)
- **Conflicts** — verb clashes ("always ask" vs "never ask"), modal clashes, opposite-polarity instructions
- **Attention curve** — U-curve model of primacy/recency with the dead zone shaded; critical rules buried mid-file glow
- **Description scorecard** — triggering, perspective, specificity, limits, schema, near-miss disambiguation (the description is the entire trigger surface)
- **Budgets** — body lines vs 500, tokens vs ~5k, negation density vs a 283-skill corpus baseline, description length limits
- **Health score** — weighted deductions for all of the above

## Inputs

- Paste SKILL.md contents
- Drop / browse one file or a whole folder (every `SKILL.md` found → leaderboard)
- Link:
  - `skills.sh/{owner}/{repo}/{skill}` — e.g. `skills.sh/anthropics/skills/pptx`
  - `github.com/{owner}/{repo}` (repo) or `/tree/{branch}/{path}` (subtree) — loads every skill, capped at 60
  - `github.com/{owner}/{repo}/blob/{branch}/{path}` — single file
  - any raw `.md` URL (CORS permitting)
- Deep link: `?url=<link>` pre-loads and analyzes on open

## Privacy

Static analysis runs **100% locally in your browser** — skills are never uploaded. Fetching a link pulls the file straight from GitHub's raw CDN / API. The optional LLM review calls OpenRouter directly with **your** API key (stored in your browser's localStorage only).

## LLM review

The static engine can't judge semantics. Paste an OpenRouter key, pick a cheap model (kimi-k3 default), and the app sends a strict-JSON review prompt — real contradictions, no-op sentences, and a suggested positive for every bare prohibition — merging the findings into the same view. Or use the copy-prompt flow with any LLM by hand.

## Engine

`analyzer.js` (UMD, runs in browser and Node) + markdown-it + js-yaml, vendored locally; ECharts for charts. No build step. Grounded in Anthropic's Agent Skills docs and a ~283-skill corpus survey (negation density baseline 6.2/1k words).

```sh
python3 -m http.server 8123   # or npx http-server
open http://localhost:8123
```
