<div align="center">

# Memoir

### One input for everything on your mind.

Notes, tasks, reminders, bookmarks, questions — just type naturally and Memoir figures out what it is and where it belongs.

[Website](https://getmemoir.vercel.app) · [Report a Bug](https://github.com/javohirakram/memoir/issues) · [Request a Feature](https://github.com/javohirakram/memoir/issues)

</div>

---

## Why Memoir?

Most productivity apps force you to decide upfront: *Is this a note? A task? A calendar event? A bookmark?* Then they make you fill out a form. Then they make you pick a folder.

Memoir removes all of that. You type one sentence. An AI figures out the intent, extracts the structure, and files it in the right place. No forms. No menus. No decision fatigue.

```
You type:    "call dentist tomorrow at 3pm"
Memoir:      Creates a task with a reminder for tomorrow 3:00 PM

You type:    "idea for a side project — AI that summarizes podcasts"
Memoir:      Saves as a note, tagged 'ideas'

You type:    "https://nytimes.com/article-about-ai"
Memoir:      Saves as a bookmark with title and preview

You type:    "what did I write about React last week?"
Memoir:      Semantic search across your notes
```

## Features

- **Natural language input** — Type the way you think, not the way an app wants
- **AI intent classification** — Notes, tasks, events, bookmarks, and questions handled automatically
- **Semantic search** — Ask questions about your own knowledge base (pgvector embeddings)
- **Full-text fuzzy search** — Find anything instantly with Postgres `pg_trgm`
- **Google OAuth + email login** — Sign in with Google or email/password
- **Dark mode first** — Warm copper/gold palette, Playfair Display + Inter typography
- **Serverless** — Python FastAPI on Vercel, scales to zero
- **Privacy-respecting** — Your data stays in your Postgres instance

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Python 3.12, FastAPI (serverless on Vercel) |
| **Frontend** | Vanilla JavaScript, HTML, CSS — no framework |
| **Database** | Postgres (Neon) with `pgvector` + `pg_trgm` |
| **AI** | OpenAI `gpt-4o-mini` via structured Pydantic output |
| **Auth** | Google OAuth 2.0 + JWT, email/password with bcrypt |
| **Analytics** | PostHog |
| **Errors** | Sentry |
| **Email** | Resend |
| **Hosting** | Vercel (Fluid Compute, Python runtime) |

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  Vanilla JS UI  │─────▶│  FastAPI on      │─────▶│  Postgres       │
│  (static HTML)  │      │  Vercel Lambdas  │      │  + pgvector     │
└─────────────────┘      └──────────────────┘      └─────────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │  OpenAI API      │
                         │  (intent + embed)│
                         └──────────────────┘
```

Single-file API (`api/index.py`) keeps cold starts minimal. Frontend is plain HTML/CSS/JS that ships as static files — no build step, no bundler, no framework.

## Project Structure

```
memoir/
├── api/
│   └── index.py          # All backend endpoints (FastAPI)
├── static/
│   ├── landing.html      # Marketing page
│   ├── index.html        # App shell
│   ├── script.js         # Frontend logic
│   └── style.css         # Design system
├── db.py                 # Database schema + migrations
├── migrate.py            # Manual migration runner
├── requirements.txt      # Python dependencies
└── vercel.json           # Vercel routing + function config
```

## Running Locally

### Prerequisites
- Python 3.12
- A Postgres database with `pgvector` and `pg_trgm` extensions (Neon works great)
- An OpenAI API key
- A Google OAuth 2.0 client ID (for Google login)

### Setup

```bash
# Clone the repo
git clone https://github.com/javohirakram/memoir.git
cd memoir

# Install dependencies
pip install -r requirements.txt

# Copy env file and fill in your keys
cp .env.example .env
# Edit .env with your POSTGRES_URL, OPENAI_API_KEY, GOOGLE_CLIENT_ID, JWT_SECRET

# Run migrations
python migrate.py

# Start the dev server
./run.sh
```

Open [http://localhost:8000](http://localhost:8000).

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_URL` | Yes | Postgres connection string with `pgvector` enabled |
| `OPENAI_API_KEY` | Yes | OpenAI API key for intent classification + embeddings |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth 2.0 client ID |
| `JWT_SECRET` | Yes | Secret for signing JWT auth tokens |
| `SENTRY_DSN` | No | Sentry error tracking |
| `RESEND_API_KEY` | No | Welcome email sending |
| `POSTHOG_API_KEY` | No | Product analytics |

## Deployment

Memoir is designed to deploy to Vercel out of the box.

```bash
npm i -g vercel
vercel --prod
```

Set the environment variables in the Vercel dashboard or via `vercel env add`. The `vercel.json` handles routing: `/api/*` hits the FastAPI serverless function, static files are served from `/static/`, and `/` serves the landing page.

## Roadmap

- [x] Natural language intent classification
- [x] Semantic search over notes
- [x] Google OAuth + email auth
- [x] Task reminders and calendar view
- [x] Bookmarks with URL preview
- [ ] iOS / Android apps
- [ ] Offline mode with sync
- [ ] Shared notebooks and collaboration
- [ ] Voice input
- [ ] Browser extension for quick capture

## Contributing

This is currently a solo project, but issues and PRs are welcome. If you find a bug or have an idea, open an issue.

## License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">

Built by [Javohir Akramov](https://github.com/javohirakram)

</div>
