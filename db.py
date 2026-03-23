"""
Database module for Memoir — Vercel Postgres (Neon) with pgvector.

Provides connection management, schema initialization, and helper functions.
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor
from pgvector.psycopg2 import register_vector
from contextlib import contextmanager
from datetime import date, datetime

DATABASE_URL = os.environ.get("POSTGRES_URL", "")

# Module-level connection — reused across warm serverless invocations
_conn = None
_db_initialized = False


def _get_connection():
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
        _conn.autocommit = False
        register_vector(_conn)
    return _conn


@contextmanager
def get_cursor():
    """Yield a DB cursor inside a transaction. Auto-commits on success, rolls back on error."""
    global _db_initialized
    if not _db_initialized:
        _init_db_once()
    conn = _get_connection()
    cur = conn.cursor()
    try:
        yield cur
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        # Reset connection on error (may be stale)
        global _conn
        try:
            _conn.close()
        except Exception:
            pass
        _conn = None
        raise
    finally:
        cur.close()


_SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    picture TEXT,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    original_text TEXT NOT NULL DEFAULT '',
    is_list BOOLEAN NOT NULL DEFAULT FALSE,
    list_name TEXT,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    embedding vector(1536)
);

CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);
CREATE INDEX IF NOT EXISTS idx_notes_list_name ON notes(list_name);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created DESC);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    due_time TEXT,
    priority INTEGER NOT NULL DEFAULT 4,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ,
    project TEXT NOT NULL DEFAULT 'inbox',
    labels JSONB NOT NULL DEFAULT '[]'::jsonb,
    parent_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    all_day BOOLEAN NOT NULL DEFAULT FALSE,
    location TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'blue',
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);

CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    message TEXT NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rate_limits (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    ai_requests INT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS chat_history (
    user_id TEXT PRIMARY KEY,
    messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_context (
    user_id TEXT PRIMARY KEY,
    history JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY,
    theme TEXT NOT NULL DEFAULT 'dark',
    onboarding_done BOOLEAN NOT NULL DEFAULT FALSE,
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'free',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    current_period_end TIMESTAMPTZ,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def _init_db_once():
    """Create tables on first use — safe to re-run (IF NOT EXISTS)."""
    global _db_initialized
    if _db_initialized:
        return
    conn = _get_connection()
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL)
    conn.commit()

    # Migration: add end_date column to events if missing
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'events' AND column_name = 'end_date'"
            )
            if not cur.fetchone():
                cur.execute("ALTER TABLE events ADD COLUMN end_date TEXT")
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass

    # Migration: add user_id column to existing tables if missing
    for table in ("notes", "tasks", "events"):
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = %s AND column_name = 'user_id'",
                    (table,)
                )
                if not cur.fetchone():
                    cur.execute(f"ALTER TABLE {table} ADD COLUMN user_id TEXT NOT NULL DEFAULT '__legacy__'")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass

    # Create user_id indexes (safe to re-run)
    for table in ("notes", "tasks", "events"):
        try:
            with conn.cursor() as cur:
                cur.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_user_id ON {table}(user_id)")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass

    # Try HNSW index (may fail if not enough rows, that's OK)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_notes_embedding
                ON notes USING hnsw (embedding vector_cosine_ops)
                WITH (m = 16, ef_construction = 64)
            """)
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    _db_initialized = True


def check_and_increment_rate_limit(user_id: str, limit: int = 100) -> bool:
    """Atomically increment daily AI request count. Returns True if under limit."""
    today = date.today().isoformat()
    with get_cursor() as cur:
        cur.execute("""
            INSERT INTO rate_limits (user_id, date, ai_requests) VALUES (%s, %s, 1)
            ON CONFLICT (user_id, date) DO UPDATE SET ai_requests = rate_limits.ai_requests + 1
            RETURNING ai_requests
        """, (user_id, today))
        row = cur.fetchone()
        return row["ai_requests"] <= limit


def get_user_plan(user_id: str) -> str:
    """Return the user's subscription plan ('free' or 'pro'). Defaults to 'free'."""
    with get_cursor() as cur:
        cur.execute(
            "SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = %s",
            (user_id,)
        )
        row = cur.fetchone()
    if not row:
        return "free"
    if row["status"] != "active":
        return "free"
    if row["current_period_end"] and row["current_period_end"] < datetime.now(row["current_period_end"].tzinfo):
        return "free"
    return row["plan"]
