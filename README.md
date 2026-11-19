# Interview Prep Kit

Paste a job description and a company website, say how many days you have, and get a researched, editable prep kit. The kit contains:

- a company brief
- a role breakdown with requirements marked must or nice
- a categorised question bank
- flashcards
- a day-by-day schedule

You can then reshape any part of it, practise against it, and check your own stories against what the role asks for.

> **Deployed:** web: **https://interview-prep-kit-cyan.vercel.app** · API: https://interview-prep-kit-api.onrender.com (see [Deployment](#deployment))
>
> The API runs on Render's free tier, which sleeps when idle: the first request after a quiet period can take up to a minute.

---

## Contents

1. [Tech stack](#tech-stack)
2. [Running it](#running-it) (local, batch command, deployment)
3. [Architecture](#architecture)
4. [Retrieval and sources](#retrieval-and-sources)
5. [Research and generation sequence](#research-and-generation-sequence)
6. [The coverage loop (second pass)](#the-coverage-loop-second-pass)
7. [Generated, edited and pinned state](#generated-edited-and-pinned-state)
8. [Schedule allocation](#schedule-allocation)
9. [Practice mode](#practice-mode)
10. [Creative feature: the story bank](#creative-feature-the-story-bank)
11. [Edge cases and failure handling](#edge-cases-and-failure-handling)
12. [Security](#security)
13. [Tests](#tests)
14. [Design decisions, trade-offs and known limitations](#design-decisions-trade-offs-and-known-limitations)

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 14 (App Router) and Tailwind CSS | Preferred stack. `/api/*` is proxied to Express through Next rewrites, so the session cookie is first-party and there's no CORS setup. |
| Backend | Node.js, Express, TypeScript | Preferred stack. |
| Database | MongoDB with Mongoose (Atlas M0 in production) | Preferred stack. A kit is one nested document, which suits a document store. |
| Shared logic | `@kit/core`, a TypeScript workspace package | The pipeline, schema, schedule, coverage, edit operations and practice rules live here once. The API, the batch command and the browser all use the same code (see [Architecture](#architecture)). |
| Scraping | Native `fetch` and `cheerio` | Pages are mostly static HTML, so there's no headless browser. That keeps it fast, cheap and easy to deploy. |
| LLM | **Groq** (free tier): `openai/gpt-oss-120b` (with `reasoning_effort: low`), falling back to `openai/gpt-oss-20b`, then `llama-3.3-70b-versatile`, then `llama-3.1-8b-instant` | Generous free tier, OpenAI-compatible JSON mode, fast. Models a key can't use are skipped automatically, and the list is configurable through `GROQ_MODELS`. |
| Discussion search | Tavily (optional free key), Reddit public JSON, Hacker News Algolia API | See [Sources](#sources-used). |
| Tests | Vitest, Supertest, mongodb-memory-server | |

The monorepo uses npm workspaces:

```
packages/core   pipeline, schema, schedule, coverage, edits, practice, stories, batch CLI, fixture sites
apps/api        Express API: auth, kits, background jobs
apps/web        Next.js interface
examples/       sample batch input
```

---

## Running it

### Prerequisites

- Node.js 20 or later (developed on 22/24)
- A MongoDB connection string (local `mongod` or a free Atlas cluster). The API needs one; the batch command doesn't.
- A free **Groq API key** from <https://console.groq.com/keys>
- Optional: a free **Tavily API key** from <https://app.tavily.com>

### Install

```bash
git clone <this repo> && cd interview-prep-kit
npm install
cp .env.example .env          # then fill in GROQ_API_KEY (and MONGODB_URI, JWT_SECRET for the app)
```

Every variable is documented in [`.env.example`](.env.example). The web app's single variable, `API_URL`, is in [`apps/web/.env.example`](apps/web/.env.example).

### Run the app locally

```bash
npm run dev:api     # Express on :4000 (reads the repo-root .env)
npm run dev:web     # Next.js on :3000, proxies /api to :4000
```

Open <http://localhost:3000>, create an account and paste a posting.

### Batch entry point (Section 9)

```bash
npm install
npm run evaluate -- --input <cases.json> --output <kits.json>
```

- **Input:** an array of `{ id, jd, company_url, days }`. **Output:** the Appendix B shape (`version`, `generated_at`, `kits[]`, each entry `ok` or `failed`).
- It runs the same `runPipeline()` the API's job runner uses.
- Cases run one after another, because they share one rate-limited model budget.
- The output file is rewritten after every case, so a crash still leaves the finished results.
- A failing case is recorded and the run continues.
- A time budget (14 minutes total, at most 170 s per case) makes the pipeline skip optional steps (discussion search, extra coverage passes) when a case is running long, so five cases finish within 15 minutes.
- Credentials come only from environment variables (`.env` is loaded automatically). Private and loopback addresses are allowed for this command, because test company sites may be served from `localhost`. Set `ALLOW_PRIVATE_URLS=false` to forbid them.

To try it against the bundled fixture company sites:

```bash
npm run fixtures                                                     # terminal 1: serves http://localhost:8099/{acme,globex,initech}/
npm run evaluate -- --input examples/cases.sample.json --output kits.json   # terminal 2
```

The fixtures are deliberately awkward:

| Site | What it tests |
|---|---|
| `acme` | The hiring process is buried at `/acme/handbook/people-ops/how-we-interview.html`, linked only from a handbook index in the footer. robots.txt disallows `/acme/private/`. |
| `globex` | No hiring page anywhere. |
| `initech` | A prompt-injection paragraph on the homepage, plus a hiring-process page reachable **only** through the sitemap. |

The sample cases also include a two-line description, a 404 company, 1-day and 60-day schedules, and a duplicate submission.

### Tests

```bash
npm test            # unit + integration, all workspaces
npm run coverage    # same, with coverage; fails below 100%
npm run test:e2e    # Playwright: real browser, production build, real API + MongoDB
npm run typecheck
```

| Layer | Tests | What runs |
|---|---|---|
| **Unit** | ~300 | Pure logic with fakes: schedule, coverage loop, schema, edits/merge/regeneration, extraction rules, retrieval (URL policy, robots, scoring, cleaning, fetcher on a fake network), Groq client (rate limits, fallbacks, repair), discussion search, practice, stories; API helpers (config, error mapping, view shaping); every React component and hook in jsdom with Testing Library |
| **Integration** | ~60 | Real HTTP and a real database: the crawler and pipeline against the local fixture sites; the batch command end to end in-process; the Express API over HTTP against an in-memory MongoDB with real background jobs (auth/session errors, ownership, dedupe, rate limits, edits, regeneration that keeps edits, version conflicts, restart recovery, practice, stories); `server.ts` booted and shut down |
| **End-to-end** | 5 scenarios | Playwright + Chromium against `next build` / `next start`, the real API and MongoDB, fixture sites and the scripted model: sign up → build a kit → inline edit → **keyboard drag-and-drop** → regenerate keeping the edit → stale schedule rebuild → keyboard practice → story bank → reload → sign out; batch upload from a real file; thin posting + unreachable company; duplicate submission; phone viewport (no horizontal scroll) |

**Coverage: 100% statements, branches, functions and lines in all three packages**, enforced by thresholds (`npm run coverage` fails otherwise):

| Package | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `packages/core` | 100% (2622) | 100% (1332) | 100% (153) | 100% (2622) |
| `apps/api` | 100% (666) | 100% (274) | 100% (40) | 100% (666) |
| `apps/web` | 100% (1969) | 100% (942) | 100% (136) | 100% (1969) |

Getting there removed unreachable defensive branches rather than writing contrived tests for them. Three regions are excluded with a `v8 ignore` comment explaining why: the two "run when executed directly" entry guards (`server.ts`, `cli/evaluate.ts`; both are exercised by calling the exported `start()` / `main()`), and one post-validation invariant in the pipeline that earlier steps make unreachable. jsdom lacks `Blob.text()`, so the web test setup adds a shim; the real browser path is covered by the Playwright batch-upload test.

Writing these tests found and fixed real bugs:
- **Sign-in in production builds bounced back to the login page:** the header prefetched `/kits` while signed out and the client router reused that cached redirect after sign-in (only reproducible with `next build`; caught by the e2e suite). Sign-in now does a full navigation, and that link no longer prefetches.
- **Escape in an inline editor saved the text instead of discarding it** (the blur triggered by Escape committed the stale draft).
- **Whitespace-only model output** passed the length check, trimmed to empty, and would have produced an invalid kit; such items are now dropped.
- **Company names ending in punctuation** ("Yahoo!", "Acme Inc.") never matched discussion results (`\b` doesn't match after punctuation).
- **Duplicate accessible names:** every question category had a "Question 1"; labels now include the category.
- A dismissed regeneration banner could hide a later failure for the same section.

---

## Architecture

```
            ┌──────────── apps/web (Next.js) ────────────┐
 browser ──►│ pages · builder state (useKit) · /api proxy │
            └───────────────────────┬─────────────────────┘
                                    │ same-origin /api/*
            ┌───────────────────────▼─────────────────────┐
            │ apps/api (Express)                          │
            │  auth (JWT cookie) · kits routes · validation│
            │  JobRunner ── generate / regenerate jobs     │
            └──────┬───────────────────────────┬──────────┘
                   │ MongoDB (kits, users)     │ calls
            ┌──────▼───────────────────────────▼──────────┐
            │ packages/core  (@kit/core)                   │
            │  retrieval/  url policy · robots · fetcher · │
            │              clean · crawler                 │
            │  discussion/ search                          │
            │  llm/        groq client · rate · json ·     │
            │              untrusted                       │
            │  steps/      extract · research · questions ·│
            │              flashcards                      │
            │  pipeline.ts · coverage.ts · schedule.ts     │
            │  schema.ts · edit.ts · merge.ts ·            │
            │  regenerate.ts · practice.ts · stories.ts    │
            │  cli/evaluate.ts  ◄── npm run evaluate       │
            └──────────────────────────────────────────────┘
```

Each concern lives in its own module:

- **Retrieval** (`retrieval/`, `discussion/`) only fetches and cleans.
- **Extraction and generation** (`steps/`) only talk to the model through a one-method `Llm` interface.
- **Scheduling and coverage** (`schedule.ts`, `coverage.ts`) are plain code.
- **Persistence** (`apps/api`) never contains generation logic.

The browser bundle imports only pure modules (`@kit/core/edit`, `/schema`, `/practice`, `/stories`), never the network code.

---

## Retrieval and sources

### Company site crawl

Code: `packages/core/src/retrieval/crawler.ts`. No path is hard-coded.

1. **Fetch the start URL.** If this fails (bad URL, 404, timeout, DNS failure), the site is recorded as unreachable and the kit is built from the description alone.
2. **Gather candidate links** from the homepage (navigation and footer included, since that's where hiring pages hide) and from the **sitemap**: robots.txt `Sitemap:` lines, then `<base>/sitemap.xml`.
3. **Stay in scope.** Candidates must share the start URL's origin **and its path prefix**, so `http://host/acme/` never wanders into `/globex/`. That matters when one host serves several companies, as the brief's `localhost` cases might.
4. **Score each link** by path and anchor text (`scoreLink`):
   - **Boosted:** "how we hire" and "interview" (strongest), "careers", "jobs", "join us", "handbook", "about" and similar.
   - **Penalised:** login, privacy and legal pages, binary files, archive paging, and very deep paths.
   - Path and anchor text agreeing counts for more than either alone.
5. **Fetch best-first**, up to 8 pages and 2 link levels. Links found on a careers or hiring page get a bonus, which is how `handbook → how-we-interview` is found.
6. **Classify by content, not URL** (`classifyPage`). A page counts as `hiring-process` only if its text has "interview" plus at least two other process signals (take-home, system design, pairing, recruiter screen, onsite, stages…). A `/careers` page that only lists jobs is `careers`, not a process.

### Fetching politely and defensively

Code: `retrieval/fetcher.ts`.

- robots.txt is parsed and respected (longest match, wildcards, `Crawl-delay`) and cached per origin.
- At least 750 ms between requests to the same host in the app (300 ms in the batch command), or longer if `Crawl-delay` asks.
- 10 s timeout. Up to 3 retries with exponential backoff and jitter, on timeouts, network errors, 429 and 5xx only. `Retry-After` is honoured, capped at 15 s.
- Only `text/html`, `xhtml`, `text/plain` and XML are accepted. The body is capped at 1.5 MB while streaming. At most 5 redirects, each re-validated.
- A source that can't be retrieved is **skipped and reported** in `research.skipped_sources` with its reason, never fatal.

### Sources used

| Source | Used for | Notes |
|---|---|---|
| The company's own site | Brief, hiring process | Respects robots.txt. Up to 8 pages. |
| Tavily search API | Public interview discussion | Optional (`TAVILY_API_KEY`). Snippets only. |
| Reddit `search.json` | Public interview discussion | No key. Often rate-limited or blocked for anonymous clients; recorded as skipped when it fails. |
| Hacker News (Algolia API) | Public interview discussion | No key. |

Discussion results are **filtered by code**: a result is kept only if it mentions the company name as a whole word **and** an interview-related term. Only snippets are stored. Third-party pages are never fetched in full.

---

## Research and generation sequence

Code: `packages/core/src/pipeline.ts`. Each step reacts to what the previous ones found:

| # | Step | Model? | Runs when | Responsible for |
|---|---|---|---|---|
| 1 | **Extract requirements** | yes (one call) | always. Pasted text needs no retrieval, so this runs **in parallel with** step 2 | Role title, seniority, location, responsibilities, and requirements, each with a verbatim `evidence` quote. Code then grounds and marks them (below). |
| 2 | **Crawl company site** | no | URL is valid | Pages, hiring-page detection, skipped sources |
| 3 | **Company name** | no | always | From the description, then site metadata (`og:site_name`, title), then the URL |
| 4 | **Public discussion search** | no | a name exists and there's time | Relevant snippets |
| 5 | **Hiring process** | yes | **only if** a hiring or careers page with interview content, or relevant discussion, was found | Stages, formats (take-home, system design, live coding…), tips. Each format is kept only if code finds it in the source text. |
| 6 | **Company brief** | yes | **only if** pages were fetched. Otherwise code writes an explicit "not found" brief | Summary, what they do, sources (must be pages actually fetched) |
| 7 | **Questions, one call per category** | yes (2–4 calls) | always; which categories and how many are decided by code | See below |
| 8 | **Coverage loop** | gap fills only | always | See the next section |
| 9 | **Flashcards** | yes | always (code fallback from questions if it fails) | Recall cards tied to requirement ids |
| 10 | **Schedule** | **no** | always | See [Schedule allocation](#schedule-allocation) |
| 11 | **Validate** | no | always | Zod schema plus referential checks before anything is returned or saved |

### What code decides, not the model

**Grounding.** A requirement survives only if its evidence appears in the posting (normalised substring), or 75% of its content words appear on one line. Anything else is dropped as invented and noted. A test feeds in an invented "10+ years of COBOL"; it's dropped.

**must / nice from the posting's own wording.** The model's guess is overridden by:
1. the requirement's line itself ("…is a plus", "bonus", "preferred", "required", "must");
2. otherwise, the nearest heading above it ("Nice to have:", "Bonus points", "Requirements:", "What you'll need").

A neutral explicit heading ("About the team:") stops the search, so it doesn't inherit a heading further up.

**Ids** `r1…rn` are assigned in posting order. Every id the model returns elsewhere is checked against the known ids, and unknown ones are dropped.

### Category planning (`planCategories`)

- **Technical:** technical requirements.
- **Behavioural:** behavioural requirements. Always present, but generic if the posting lists none.
- **System design:** **only if** the hiring process confirms a design round, or the seniority or title suggests one.
- **Company fit:** domain requirements plus the brief. When nothing is known about the company, it's told not to state company facts.

Each category gets its **own system prompt**:
- technical: depth and trade-offs;
- behavioural: STAR, and what the interviewer listens for;
- system design: a 45-minute prompt in the company's domain;
- company fit: motivation, using only facts from the brief.

So "5 years of React" and "mentoring juniors" never share a call or instructions.

**The hiring process changes the prompts.** A published take-home adds "include a question defending and extending your take-home". Live coding adds "practical, talk-through-your-code questions". A confirmed design round makes one prompt a full end-to-end design. A test checks the technical prompt for Acme mentions the take-home.

---

## The coverage loop (second pass)

Code: `coverage.ts`.

1. **Code checks coverage.** A requirement is covered if any question lists its id. Every requirement with no question is a gap, nice-to-haves included.
2. Gaps are grouped by the category their kind routes to. Each group goes to its category's generator in **gap mode**: one question per listed requirement, which must target it. Only questions that hit a gap are kept.
3. Check again. **Stop when:**
   - nothing is uncovered; or
   - **3 generation passes** have run (draft plus 2 gap passes); or
   - **a pass closed no gaps.** Asking again would only spend rate-limited tokens: the model can't or won't cover what's left.
4. **Fallback:** if a **must-have** is still uncovered, code adds a clearly labelled generic question (`state.origin = "template"`, shown as "Generic fallback" in the UI). Nice-to-haves may stay uncovered and are reported in `coverage.uncovered_requirement_ids`.

**Why 3 passes:** gaps mostly come from a draft spreading too few questions over many requirements. Gap mode targets each missing requirement explicitly, so one gap pass should close most of them, and a second catches stragglers. Past that, each pass costs about 2 calls against a token-per-minute budget for very little, and the "no progress, stop" rule ends it even sooner. (In the measured run below, `gpt-oss-120b`'s first drafts covered every requirement in all five sample cases, so no gap pass was needed there. The gap path is exercised by the tests with a scripted model that deliberately under-covers.) The template fallback means "the model gave up" never becomes "the kit ships without a must-have". It also stays honest: those questions are labelled as generic.

`coverage.passes` in the output is the number of generation passes, counting the first draft.

---

## Generated, edited and pinned state

This is the hardest state problem, so here is the whole design.

### Per-item state

Every question, flashcard and the brief carries `state = { origin, edited, pinned }`:

- `origin`: `generated` (model), `template` (code fallback) or `user` (written by hand)
- `edited`: the user changed a generated item's content or category
- `pinned`: the user explicitly asked to keep it

An item is **protected** if `origin === "user" || edited || pinned`. **Regenerating a section replaces only unprotected items in that section.** Protected items keep their id, content and position. Other sections aren't touched at all. Template questions are replaceable. Plain reordering is *not* an edit, because it doesn't express "keep this text". Moving a question to another category *is*.

### Edits are operations, not document replacements

Code: `edit.ts`.

- The builder sends small ops (`question.update`, `question.add`, `question.move`, `question.reorder`, `pin`, `brief.update`, …).
- **The browser and the server run the same `applyEditOps` function.** The browser applies ops instantly for display; the server applies them to the latest stored kit.
- Because ops are field-level, two tabs, or an edit made during a regeneration, combine rather than overwrite.
- After every op, code recomputes coverage and removes schedule references to deleted questions. Changing questions marks the schedule *stale* rather than silently rebuilding it.

### Ids are never reused

High-water marks per kit (`q`, `f`) mean a deleted `q7` is retired. Practice history and schedule entries can never point at a different question that took its id.

### Concurrency

- **Versioned writes.** Each kit document has a `version`. Every write is `updateOne({_id, version}, …, $inc version)`, and on conflict the server re-reads and **re-applies** the mutation. That's safe because mutations are pure functions of the latest kit.
- **Regeneration merges into the latest kit.** It reads the kit, calls the model (slow), then re-reads and merges into the **latest** version, not the one it started from. Edits made during those 30 seconds survive. There's a test for exactly that.
- **One regeneration per kit at a time,** claimed atomically. A second request gets `409 REGEN_IN_PROGRESS`.

### In the browser

Code: `apps/web/src/lib/useKit.ts`. The hook keeps:

- `base`: the last kit the server confirmed;
- `inflight` and `pending`: ops not yet confirmed.

**What you see = base + inflight + pending**, recomputed every render.

- When a new base arrives (save confirmed, regeneration finished, reload), unsaved ops are re-applied on top of it.
- Text commits on blur, Ctrl/Cmd+Enter or a pause. Consecutive updates to one item are merged into one op, so nothing is sent per keystroke.
- Temporary ids for new items are remapped to the server's ids in any still-pending ops.
- Network or 5xx failures retry with backoff. A rejected op shows why and reloads.

The brief is a single object: regenerating it replaces it only if unprotected. Otherwise the UI says "left unchanged: you edited or pinned it".

---

## Schedule allocation

Code: `schedule.ts`. Pure arithmetic, no model. For N days:

```
[ learning days ][ review days ][ final day ]
```

1. **Order:** questions sorted by priority (covers a must-have, then a nice-to-have, then neither), then difficulty (hard first), then original order. Harder and higher-priority material lands earliest.
2. **Estimated minutes per question:** 10, 20 or 30 by difficulty, plus 15 for system design. Always integers.
3. **Learning days:** `clamp(ceil(total / 90 min), 1, min(N−1, #questions))`. Each question appears exactly once, split into contiguous chunks of balanced minutes (`partitionByWeight`). A 60-day horizon doesn't spread 15 questions one per day; it learns them in a few days and uses the rest for spaced review.
4. **Review days** (only when there's spare time): cycle back through the study order, must-haves first, in batches of 3–6 at a third of the original time.
5. **Final day** (N ≥ 3): rehearse **one question per must-have requirement**, chosen by a greedy set cover. No new material the night before.
6. **One day:** everything goes on day 1, capped at 240 minutes (at least 5 per question) and labelled "Compressed".
7. **Must-haves with no question at all** (only possible if the user deleted them) are named on day 1 as self-study, so they're still scheduled.

**Invariants (tested for 1, 2, 3, 5, 7, 14, 30 and 60 days):**
- exactly N days, numbered 1…N, with integer minutes;
- every question appears and every `question_id` exists;
- every must-have requirement appears on some day (via `requirement_ids`, an added field);
- the final day contains no new material;
- the output is deterministic.

---

## Practice mode

Code: `practice.ts`. A small **Leitner system** driven by self-rated confidence:

| Rating | Effect |
|---|---|
| 1 "Didn't know" | Box 0, due now. It comes back once at the end of the current session. |
| 2 "Shaky" | Box stays (minimum 1), due in 12 h to 4 days depending on the box. |
| 3 "Solid" | Box +1, due later. |

**Next-session order:**
1. due cards, least confident first, then most overdue;
2. unseen cards, must-have cards first;
3. not-yet-due cards, soonest first.

The UI shows solid, shaky, didn't-know and unseen counts, and which requirements have cards you've never practised.

**Why Leitner, not SM-2:** prep windows are days, not months, and people rate themselves coarsely. Five boxes with short intervals are predictable ("I said I didn't know it, so it comes back") and easy to explain. SM-2's ease factors need many reviews before they mean anything.

Keyboard: Space reveals, 1/2/3 rates.

---

## Creative feature: the story bank

**The problem.** Behavioural and company-fit rounds are answered with real stories. Candidates either prepare one story per question, which is unrehearsable at 15 questions, or rely on two favourite stories and repeat themselves. The useful question isn't "what will they ask?" (the kit answers that). It's **"do the stories I actually have cover what this role needs?"**

**What it does** (the "Your stories" tab, `packages/core/src/stories.ts`):

- **Write stories.** You write 4–6 STAR stories and tag the requirements each one demonstrates.
- **Must-have gaps.** Code lists every **must-have no story covers**: behavioural and domain gaps first, and technical gaps with a "a project walkthrough would cover this" hint.
- **Story per question.** For each behavioural and company-fit question, it **suggests the best story**, ranked by shared requirement tags (weighted 3) plus word overlap (capped).
- **Warnings.** It flags a story that is your best answer to more than half the questions ("interviewers notice the same story twice"), and stories that don't help with anything.

**Why it's built this way.** It reuses the kit's central idea, coverage checked by code, but applies it to *your* experience instead of the generated questions. It's deliberately **not** model-generated: a model writing "your" stories would invent experience you don't have, which is exactly what the rest of the system refuses to do. It also works with no API key. Stories are stored per kit, outside the Appendix A structure, so they never affect batch output.

---

## Edge cases and failure handling

| Case | Behaviour |
|---|---|
| Invalid company URL | URL normalised (`acme.com` becomes `https://acme.com/`) and validated. If unusable, the kit is built from the description, with an `INVALID_COMPANY_URL` note and an honest brief. |
| 404 / timeout / DNS failure | Retried where transient, then recorded in `skipped_sources`. Kit status stays **ok**, with a `COMPANY_UNREACHABLE` note and a code-written "no reliable information" brief. The model is never asked to describe the company. If the posting doesn't name the company either, the name guessed from the URL is **not** used for discussion search, because a guessed name finds namesakes. |
| No hiring or about page | `NO_HIRING_PAGE` note. The hiring-process step is skipped, and the question prompts are told not to assume a format. |
| Two-line stub description | Only grounded requirements survive (often 1–2). `research.thin_description = true` plus a note: "nothing has been invented to fill it out". Fewer questions follow naturally. |
| No public discussion | `NO_PUBLIC_DISCUSSION` note. Hiring-process summary uses the site only, or is skipped. |
| Invalid JSON / incomplete output | JSON mode, lenient parsing (fences, prose, trailing commas), then Zod validation. On failure, the specific validation errors go back to the model as a repair turn, at most 2 times. Groq `json_validate_failed` is treated the same way. Non-critical steps fall back (brief to page meta description or "not found"; flashcards derived from questions; a failed category is covered by the coverage loop). |
| Rate limits | Client-side token bucket paces calls under `GROQ_TPM` **before** a 429 happens. On 429, waits for `retry-after` or `x-ratelimit-reset-tokens` and retries (up to 8 attempts). A **daily** limit falls over to the next model. 5xx and network errors use exponential backoff. Waits are shown in the UI. |
| Same description and company twice | Normalised hash of description and URL per user. While generating, you're attached to the running job. When ready with the same days, the existing kit is returned. With different days, the research is reused and only the schedule rebuilt (no model calls). `force: true` regenerates. The batch command does the same within a run. |
| 1-day / 60-day schedule | See [Schedule allocation](#schedule-allocation). Both are in the tests and the sample cases. |
| When is a batch case `failed`? | Only when no kit can be produced: invalid input, extraction impossible, model unavailable or not configured, or a structurally invalid kit. **An unreachable site isn't a failure**, following the FAQ. |

### Slow, failing or repeated generation

- `POST /api/kits` returns `202` immediately. Generation runs as a background job; the UI polls a lightweight `/status` endpoint every 1.5 s and shows each step as it happens. Polling, not SSE: it survives proxies, Render cold starts and reconnects with no extra code.
- Jobs run **one at a time**, since every job draws on the same model budget. Job state lives in MongoDB, so a restart or redeploy re-queues interrupted generations and marks interrupted regenerations failed with a clear message.
- Each job has a deadline (6 minutes). As it approaches, optional steps are skipped rather than the whole kit failing.
- A failed kit shows the reason in plain language and offers a one-click retry.

---

## Security

- **Untrusted content stays data.**
  - The pasted description, crawled pages and search snippets reach the model only inside `<untrusted_content>` blocks.
  - Every system prompt states that instructions inside those blocks must be ignored.
  - Delimiter-like tags in the content are neutralised, so a page can't close the block early.
- **The real guarantees come from code checking the output, not from the prompt:**
  - requirements must be grounded in the posting;
  - ids must exist;
  - brief sources must be pages we fetched;
  - interview formats must appear in the source text.

  The Initech fixture has a hidden "ignore all previous instructions" paragraph, and tests confirm it reaches the model only inside an untrusted block.
- **SSRF:**
  - only http(s) and no credentials in URLs;
  - in production, private, loopback, link-local, CGNAT and metadata addresses are refused after DNS resolution, re-checked on every redirect;
  - content types and sizes are restricted (see [Fetching](#fetching-politely-and-defensively)).
- **Auth:**
  - bcrypt password hashes;
  - an HS256 JWT in an `httpOnly`, `SameSite=Lax`, `Secure` (production) cookie;
  - distinct `SESSION_EXPIRED` and `INVALID_SESSION` errors, with the bad cookie cleared;
  - rate-limited auth endpoints, and login takes the same time whether or not the email exists;
  - every kit query is filtered by `userId`, and another user's kit returns 404.
- **Requests:**
  - all request bodies are validated with Zod, and JSON bodies are capped at 300 KB;
  - `helmet` headers are set;
  - per-user limits on active jobs and kit creation.

---

## Tests

| Area | What's covered |
|---|---|
| **Schedule** | Exact day counts from 1 to 60, integer minutes, every question scheduled, must-haves present, hard material first, no new material on the final day, the 1-day compression, the 60-day review, zero questions, determinism |
| **Coverage** | Gap detection, multi-pass closing, early stop on no progress, template fallback, a throwing generator, dangling ids |
| **Structure** | Valid kit accepted. Rejected: decimal minutes, out-of-range difficulty, bad enums, unknown references, wrong day count, duplicate ids, missing fields. Appendix B ok and failed entries. |
| **Extraction** | Grounding, must/nice from lines and headings, dedupe, ordering, ids |
| **Retrieval** | URL policy and private ranges, robots.txt, link scoring, content classification, HTML cleaning, the untrusted wrapper. Crawler against the fixture sites: buried handbook page, sitemap-only page, robots-disallowed page never fetched, path scoping, 404, timeout, connection refused. |
| **LLM client** | 429 with retry-after, daily-limit model fallback, repair turns, JSON-mode rejection, 5xx backoff, bad key, bounded failure, token bucket |
| **Pipeline** | End to end with a scripted fake model: dropped invented requirement, heading-based priority, the hiring process shaping the technical prompt, separate category calls, second pass closing gaps, thin description, unreachable site, injection kept inside untrusted blocks, a failing step, a fatal failure |
| **Edits and regeneration** | Ops, retired ids, schedule reference cleanup, move vs. reorder semantics, stale reorder lists, an edit during a regeneration surviving the merge, a protected brief |
| **API** | Auth flows and session errors, per-user isolation, background generation, deduplication and rescheduling, failure and retry, batch, edits, regeneration keeping edits plus the 409 conflict, schedule rebuild, practice, story bank |
| **Web** | Op merging and id remapping, lenient application, CSV/JSON batch parsing |

---

## Design decisions, trade-offs and known limitations

### Decisions I'd defend

1. **Code decides; the model drafts.** Which requirements exist (grounding), must or nice (posting wording), which categories run, what's covered, when to stop, and the whole schedule are all deterministic and tested. The model writes text inside those boundaries. That's what makes a thin description produce a thin kit rather than a padded one.
2. **An unreachable site is an `ok` kit with honest notes, not a failure.** The FAQ says to reserve `failed` for "a case you could not produce a kit for at all", and the description alone still gives a useful kit. (Appendix B's example shows `COMPANY_UNREACHABLE` as failed; I followed the FAQ's rule and record the code in `source.notes`.)
3. **Ops plus derived display instead of autosaving the document.** That's what lets a 30-second regeneration and continued editing happen at the same time without either losing.
4. **One shared core for the API, the batch command and the browser.** The batch command is not a parallel implementation, and the client's optimistic edits use the server's rules exactly.

### Known limitations

- **Measured on the Groq free tier** (`openai/gpt-oss-120b`, `examples/cases.sample.json` against the fixture sites): **5/5 ok in 219 s.** Per case: Acme 62 s, two-line stub 43 s, Initech 53 s, 404 site 60 s, duplicate 0 s (research reused). Groq returned several "slow down" responses during the run (1–12 s waits). All were absorbed by the retry and pacing logic. Real company sites with slower pages and more text will take longer, and the per-case budget skips optional steps rather than overrunning. A free key's **daily** token cap is the real ceiling. A full-detail kit makes about 8 model calls (Acme: extraction, hiring process, brief, four question categories, flashcards), plus one per gap pass. When the daily cap is hit, the client falls over to the next configured model.
- **Model quality varies.** The heuristics (grounding threshold, priority cues) are English-centric and tuned on typical postings, so unusual formatting can mark a requirement wrongly. The evidence quote is shown on hover so you can check.
- **The crawler doesn't run JavaScript.** Sites that render only client-side give little text, and this is recorded honestly.
- **Reddit's anonymous JSON endpoint is frequently blocked.** Tavily makes discussion search much more reliable.
- **DNS-rebinding window.** The URL check resolves DNS before connecting, so an attacker-controlled DNS server could change the answer in between. Pinning the resolved IP would close it.
- **Single API instance.** The job queue is in-process. Several instances would need a shared queue (a Mongo-backed lease or BullMQ).
- **Polling every 1.5 s, not SSE.** A deliberate trade for robustness on free hosting.
- **The story bank saves the whole list, last write wins.** Fine for one person; two tabs editing stories at once would overwrite each other.
- **Requirements themselves aren't editable** in the builder (questions, flashcards and the brief are). Changing the requirement set would invalidate coverage and the schedule, so it's left to regenerating the kit.
