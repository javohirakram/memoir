"""
One-time migration script: moves existing data from local files/ChromaDB
into Vercel Postgres. Run locally with:

    POSTGRES_URL_NON_POOLING="postgres://..." python migrate.py

Requires: psycopg2-binary, pgvector, chromadb, openai
"""

import os
import sys
import json
from pathlib import Path
from datetime import datetime

from dotenv import load_dotenv
load_dotenv()

import psycopg2
from psycopg2.extras import RealDictCursor
from pgvector.psycopg2 import register_vector
from openai import OpenAI
import chromadb

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DB_URL = os.environ.get("POSTGRES_URL_NON_POOLING") or os.environ.get("POSTGRES_URL", "")
if not DB_URL:
    print("ERROR: Set POSTGRES_URL_NON_POOLING or POSTGRES_URL env var")
    sys.exit(1)

API_KEY = os.environ.get("OPENAI_API_KEY", "")
if not API_KEY:
    print("ERROR: Set OPENAI_API_KEY env var")
    sys.exit(1)

BASE_DIR = Path(__file__).parent
openai_client = OpenAI(api_key=API_KEY)

# ---------------------------------------------------------------------------
# Connect
# ---------------------------------------------------------------------------

print(f"Connecting to database...")
conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
conn.autocommit = False
register_vector(conn)

# ---------------------------------------------------------------------------
# Create schema
# ---------------------------------------------------------------------------

print("Creating tables...")
with conn.cursor() as cur:
    cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            original_text TEXT NOT NULL DEFAULT '',
            is_list BOOLEAN NOT NULL DEFAULT FALSE,
            list_name TEXT,
            created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            embedding vector(1536)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_notes_list_name ON notes(list_name)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created DESC)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
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
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            date TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            all_day BOOLEAN NOT NULL DEFAULT FALSE,
            location TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT 'blue',
            created TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)")
conn.commit()
print("Tables created.")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def generate_embedding(text: str) -> list[float]:
    response = openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=text[:8000],
    )
    return response.data[0].embedding

# ---------------------------------------------------------------------------
# Migrate notes from ChromaDB
# ---------------------------------------------------------------------------

chroma_path = BASE_DIR / "chroma_db"
if chroma_path.exists():
    print("\nMigrating notes from ChromaDB...")
    chroma = chromadb.PersistentClient(path=str(chroma_path))
    try:
        collection = chroma.get_or_create_collection("notes")
        all_notes = collection.get(include=["documents", "metadatas"])

        for note_id, doc, meta in zip(all_notes["ids"], all_notes["documents"], all_notes["metadatas"]):
            print(f"  Migrating note: {meta.get('title', 'untitled')} ...", end=" ", flush=True)

            # Generate new embedding with OpenAI
            embedding = generate_embedding(doc)

            created = meta.get("created", datetime.now().isoformat())
            is_list = meta.get("is_list", "False")
            if isinstance(is_list, str):
                is_list = is_list.lower() == "true"

            list_name = meta.get("list_name", "") or None
            if list_name == "":
                list_name = None

            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO notes (id, title, category, content, original_text,
                                       is_list, list_name, created, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        content = EXCLUDED.content,
                        embedding = EXCLUDED.embedding
                """, (
                    note_id,
                    meta.get("title", "Untitled"),
                    meta.get("category", "personal"),
                    doc,
                    meta.get("original_text", ""),
                    is_list,
                    list_name,
                    created,
                    embedding,
                ))
            conn.commit()
            print("OK")

        print(f"  Migrated {len(all_notes['ids'])} notes.")
    except Exception as e:
        print(f"  Error migrating notes: {e}")
        conn.rollback()
else:
    print("\nNo chroma_db/ found, skipping notes migration.")

# ---------------------------------------------------------------------------
# Migrate tasks
# ---------------------------------------------------------------------------

tasks_file = BASE_DIR / "data" / "tasks.json"
if tasks_file.exists():
    print("\nMigrating tasks...")
    tasks = json.loads(tasks_file.read_text(encoding="utf-8"))
    for t in tasks:
        print(f"  Migrating task: {t['title']} ...", end=" ", flush=True)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO tasks (id, title, description, due_date, due_time,
                                   priority, completed, completed_at, project,
                                   labels, parent_id, sort_order, created)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s)
                ON CONFLICT (id) DO NOTHING
            """, (
                t["id"], t["title"], t.get("description", ""),
                t.get("due_date"), t.get("due_time"),
                t.get("priority", 4), t.get("completed", False),
                t.get("completed_at"), t.get("project", "inbox"),
                json.dumps(t.get("labels", [])),
                t.get("parent_id"), t.get("sort_order", 0),
                t.get("created", datetime.now().isoformat()),
            ))
        conn.commit()
        print("OK")
    print(f"  Migrated {len(tasks)} tasks.")
else:
    print("\nNo data/tasks.json found, skipping tasks migration.")

# ---------------------------------------------------------------------------
# Migrate events
# ---------------------------------------------------------------------------

events_file = BASE_DIR / "data" / "events.json"
if events_file.exists():
    print("\nMigrating events...")
    events = json.loads(events_file.read_text(encoding="utf-8"))
    for e in events:
        print(f"  Migrating event: {e['title']} ...", end=" ", flush=True)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO events (id, title, date, start_time, end_time,
                                    all_day, location, description, color, created)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO NOTHING
            """, (
                e["id"], e["title"], e["date"],
                e.get("start_time"), e.get("end_time"),
                e.get("all_day", False), e.get("location", ""),
                e.get("description", ""), e.get("color", "blue"),
                e.get("created", datetime.now().isoformat()),
            ))
        conn.commit()
        print("OK")
    print(f"  Migrated {len(events)} events.")
else:
    print("\nNo data/events.json found, skipping events migration.")

# ---------------------------------------------------------------------------
# Create HNSW index
# ---------------------------------------------------------------------------

print("\nCreating HNSW index on embeddings...")
try:
    with conn.cursor() as cur:
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_notes_embedding
            ON notes USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
        """)
    conn.commit()
    print("HNSW index created.")
except Exception as e:
    print(f"HNSW index creation failed (may need more rows): {e}")
    conn.rollback()

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

conn.close()
print("\nMigration complete!")
