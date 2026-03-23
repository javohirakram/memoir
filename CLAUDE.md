# Memoir

## Tech Stack
- **Backend**: Python 3.12, FastAPI (serverless on Vercel)
- **Frontend**: Vanilla JS, HTML, CSS (no framework)
- **Database**: Vercel Postgres (Neon) with pgvector
- **AI**: OpenAI gpt-4o-mini (intent classification via structured output)
- **Auth**: Google OAuth 2.0 + JWT
- **Hosting**: Vercel (serverless Python functions)
- **Error Tracking**: Sentry
- **Email**: Resend (welcome emails)

## Project Structure
- `api/index.py` — Main backend (all endpoints, ~2900 lines)
- `db.py` — Database schema and helpers
- `static/` — Frontend files (index.html, script.js, style.css, landing.html)
- `vercel.json` — Vercel config (rewrites, headers, function settings)

## Key Patterns
- Single-file API (`api/index.py`) with FastAPI
- AI intent classification using Pydantic structured output (`NoteResponse`)
- Chat-first UI — single input handles notes, tasks, events, bookmarks, questions
- Dark theme with warm copper/gold palette (Playfair Display + Inter fonts)
- All env vars are optional except `OPENAI_API_KEY`, `POSTGRES_URL`, `GOOGLE_CLIENT_ID`, `JWT_SECRET`

## gstack
Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.
Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse,
/qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro,
/investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard,
/unfreeze, /gstack-upgrade.
