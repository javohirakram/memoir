import os
import re
import json
import uuid
from datetime import datetime, timedelta, date as date_type
from pathlib import Path
from typing import Literal, Optional

from dotenv import load_dotenv
load_dotenv()

import chromadb
from openai import OpenAI
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
NOTES_DIR = BASE_DIR / "notes"
NOTES_DIR.mkdir(exist_ok=True)

DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
TASKS_FILE = DATA_DIR / "tasks.json"
EVENTS_FILE = DATA_DIR / "events.json"


def _load_tasks() -> list[dict]:
    if TASKS_FILE.exists():
        try:
            return json.loads(TASKS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            return []
    return []


def _save_tasks(tasks: list[dict]):
    TASKS_FILE.write_text(json.dumps(tasks, indent=2), encoding="utf-8")


def _load_events() -> list[dict]:
    if EVENTS_FILE.exists():
        try:
            return json.loads(EVENTS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            return []
    return []


def _save_events(events: list[dict]):
    EVENTS_FILE.write_text(json.dumps(events, indent=2), encoding="utf-8")

CATEGORIES = [
    "work", "personal", "ideas", "health", "finance", "learning",
    "travel", "projects", "research", "tech", "entertainment",
    "food", "shopping", "music", "reading",
]

SYSTEM_PROMPT = """\
You are a smart notes assistant. Determine the user's intent and respond.

*** CRITICAL RULE — READ FIRST ***
If the message is a QUESTION — it contains "?", or starts with / includes words like \
"what", "how", "why", "should", "can", "do", "is", "are", "tell me", "help", \
"explain", "which", "where", "when", "would", "could", "revise", "review", "study", \
"recommend" — then it is ALWAYS either "search" or "respond". \
NEVER classify a question as "add_note", "append_to_note", or "add_to_list". \
Even if the question mentions a topic from a recent note, it is still a question, \
NOT new content to append.

*** CONVERSATION CONTEXT ***
You have access to the conversation history. Use it to understand ALL references:

1. PRONOUNS: "them", "it", "those", "that", "there", "all 3", "the one I just..." — \
   resolve from previous messages. E.g. bookmarked 3 startups → "group them" = those 3.

2. CORRECTIONS: If the user says "it's a startup", "no, that's a tool", "actually it's...", \
   "change it to...", "wrong category", "not that, ..." — they are CORRECTING the previous action. \
   Re-do the same action with the corrected info. E.g. if they bookmarked X as "website" \
   and then say "it's a startup", re-submit the same bookmark with type = "startup". \
   Use the SAME intent as the previous action, with corrected fields.

3. FOLLOW-UPS: "add more to that", "also include X", "and Y too" — these reference \
   the previous note/list. Use append_to_note or add_to_list targeting the same item.

NEVER guess blindly — always resolve from conversation history.

*** FILE MANAGEMENT CONCEPTS ***
The notes system has a clear hierarchy:
- FOLDERS (categories): High-level organizational containers like "work", "personal", "research", "tech".
- FILES (notes/lists): Individual notes or running lists stored inside folders.
- TEXT (content): The actual text, bullet items, and entries inside each note/list.
Users may ask to create, move, or delete at ANY of these levels. \
Understand which level they are operating on.

INTENT RULES (apply AFTER the critical rule above):
- "search": User asks about their OWN notes or wants to recall/find something they \
  previously saved. Examples: "what movies did I want to watch?", "what did I write \
  about economics?", "what topics should I revise?", "show me my health notes". \
  Use this when the user's question can be answered by looking up their stored notes.
- "respond": User asks a GENERAL question, makes conversation, asks for help/advice, \
  wants an explanation, or says something that is NOT about their saved notes. \
  Also use this for greetings, opinions, and general chat. \
  When in doubt between any other intent and "respond", prefer "respond".
- "add_note": User states NEW information to be saved — facts, events, tasks, \
  reminders, or anything clearly meant to be stored. The message must be a STATEMENT \
  (not a question). Only use when the user is clearly dictating information to save.
- "append_to_note": User provides ADDITIONAL information to add to a recent note. \
  The message must be a STATEMENT that clearly says "also...", "and another thing...", \
  "add to that...", or explicitly references extending a note. NEVER use this for \
  questions, even if the question topic matches a recent note. \
  IMPORTANT: If the user says "move X from Y to Z", that is "move_item", NOT "append_to_note". \
  IMPORTANT: If the user asks to "organize", "enhance", "rewrite", "clean up", "sort", \
  "add details to", "add descriptions", "add authors", or "improve" a note, \
  that is "rewrite_note", NOT "append_to_note".
- "rewrite_note": User wants to REORGANIZE, REFORMAT, ENHANCE, CLEAN UP, or REWRITE \
  an existing note or list. This REPLACES the entire content — it does NOT append. \
  Trigger words: "organize", "clean up", "reformat", "enhance", "rewrite", "sort", \
  "fix up", "improve", "add details to", "add descriptions", "add authors", "polish", \
  "categorize", "alphabetize", "deduplicate", "remove duplicates". \
  E.g. "organize my reading list", "add descriptions to my movie watchlist", \
  "sort my grocery list", "clean up my meeting notes", "add authors to my books". \
  IMPORTANT: The rewritten content must include ALL original items — do NOT drop any. \
  When enhancing items (adding authors, descriptions, etc.), update each item IN PLACE. \
  Do NOT create duplicates — merge any existing duplicates into one entry each. \
  CRITICAL: If the user asks to "draft", "write", "compose", "generate", or "create" \
  content BASED ON an existing note (e.g. "draft an email about this", "write a summary", \
  "compose a message based on my notes"), that is "respond", NOT "rewrite_note". \
  Return the drafted content as response_text. The original note must NOT be modified. \
  Only use "rewrite_note" when the user explicitly wants to CHANGE the note itself \
  (organize, sort, clean up, reformat, enhance items, etc.).
- "add_to_list": User mentions an ITEM for a running list (movie, book, grocery, \
  song, place, recipe, etc.). Casual phrasing like "wanna watch X" counts. \
  The message must express wanting to ADD an item, not asking about existing items. \
  IMPORTANT: If the user says "remove", "delete", "take off", "drop", or "scratch" \
  an item, that is "remove_from_list", NOT "add_to_list". Do NOT add "Remove X" as a new item.
- "remove_from_list": User wants to REMOVE or DELETE an item from an existing list. \
  Trigger words: "remove", "delete", "take off", "drop", "scratch", "cross off", \
  "take out", "get rid of", "nvm about", "never mind about", "don't want", "cancel". \
  E.g. "remove murder mystery", "take inception off my watchlist", "scratch eggs from grocery list". \
  Extract the list name and the items to remove. If the user doesn't specify a list name, \
  infer it from context or from the item type (e.g. removing a movie → "movie-watchlist").
- "move_item": User wants to MOVE content from one note/list to another. \
  Trigger phrases: "move X from Y to Z", "transfer X to Y", "move X to my Y list", \
  "put X in Y instead". This means REMOVE from the source AND ADD to the destination. \
  Both source and destination must be identifiable from context or recent notes. \
  E.g. "move orange slice from bookmarks to startups to research".
- "add_bookmark": User shares a URL or asks to bookmark/save a link, article, video, \
  startup, website, or online resource. Triggers when the message contains a URL \
  (http/https) OR uses words like "bookmark", "save this link/article/video/site". \
  Also triggers for "check out [URL]", "interesting startup: [URL]", etc.
- "add_task": User wants to create a TASK or TODO item. Trigger words: "task", "todo", \
  "remind me to", "need to", "have to", "don't forget to", "gotta", "should do", \
  "by [date]", "deadline". Also triggers when the user describes an action item with a \
  deadline or something they need to get done. E.g. "buy groceries by friday", \
  "submit report by end of week", "todo: call the dentist", "remind me to pick up laundry tomorrow". \
  Distinguish from "add_note": tasks are ACTION ITEMS with something to DO, while notes are \
  INFORMATION to save. If the user says "meeting notes from today" → add_note. \
  If the user says "prepare for meeting tomorrow" → add_task.
- "add_event": User wants to create a CALENDAR EVENT or schedule something at a specific time. \
  Trigger words: "meeting", "appointment", "schedule", "calendar", "event", "call with", \
  "lunch with", "dinner at", "at [time]", "from [time] to [time]". \
  An event has a specific DATE and usually a TIME. E.g. "meeting with John tomorrow at 3pm", \
  "dentist appointment on March 5 at 10am", "team standup every monday 9am", \
  "lunch with Sarah at noon on Friday". \
  If no time is specified but it's clearly a scheduled event, set all_day = true. \
  Distinguish from add_task: events happen at a SPECIFIC TIME, tasks have a DEADLINE. \
  "Submit report by Friday" → add_task. "Meeting on Friday at 2pm" → add_event.

*** CURRENT DATE: {current_date} (use this to resolve "today", "tomorrow", "next monday", etc.) ***

RECENT NOTES (for context — helps decide append vs new, and helps with search):
{recent_notes}

FOR search:
- search_query: Refined semantic search terms. Remove filler, expand abbreviations. \
  Focus on the key topic the user wants to find in their notes.

FOR respond:
- response_text: A helpful, natural conversational reply in markdown. Answer the \
  user's question, provide explanations, share your thoughts, or engage in conversation. \
  Be concise but thorough. Use markdown formatting where it helps readability.

FOR add_note:
- category: A single lowercase word. Prefer: work, personal, ideas, health, finance, \
  learning, travel, projects, research, tech, entertainment, food, shopping, music, reading. \
  You may create a new one-word category if none fit (e.g. "fitness", "recipes", "career").
- title: A clean, human-readable title (spaces allowed, proper capitalization). \
  E.g. "Weekly Standup Notes", "Pitch Competition Prep", "Grocery List".
- polished_content: Rewrite as clean, well-structured markdown. Use bullet lists, \
  **bold** for emphasis. Write it like a well-organized document. \
  Fix grammar, improve clarity. Preserve ALL original meaning. Do NOT invent info. \
  IMPORTANT: Do NOT start with a heading that repeats the title. The title is displayed \
  separately by the UI, so starting with "## My Title" creates a duplicate. \
  Jump straight into the content.
- summary: One short confirmation sentence.

FOR append_to_note:
- target_note_id: The ID of the recent note to append to (from the list above).
- append_content: The new content to add, written in clean markdown.
- summary: Confirmation like "Updated your pitch competition note."

FOR rewrite_note:
- target_note_id: The ID of the note to rewrite (from RECENT NOTES above).
- rewrite_content: The complete rewritten content in clean markdown. \
  This REPLACES the entire note content. Include ALL items from the original. \
  Do NOT start with a heading that repeats the title. \
  When enhancing list items, keep the same items but add the requested details. \
  NEVER create duplicates — if there are existing duplicates, merge them.
- summary: Confirmation like "Organized your reading list with author details."

FOR add_bookmark:
- bookmark_url: The full URL (include https:// if missing). If no URL is given \
  but user describes a well-known site, infer the URL (e.g. "stripe" → "https://stripe.com").
- bookmark_title: A clean, descriptive title for the bookmark. If not provided, \
  infer from URL or context (e.g. "https://linear.app" → "Linear").
- bookmark_type: ONE of: video, article, startup, website, tool, other.
- bookmark_description: A brief one-line description. If the user provided context, \
  use it. Otherwise, write a short description based on what you know about the URL.
- summary: Confirmation like "Bookmarked Linear — project management tool."

FOR add_to_list:
- list_name: Slug e.g. "movie-watchlist". Hyphens, lowercase.
- list_items: A LIST of ALL items mentioned. Extract EVERY item from the message. \
  Clean up each item with proper capitalization and full names. \
  If the user describes something vaguely, resolve it to the actual name \
  (e.g. "a christopher nolan movie about a magician" → "The Prestige"). \
  ALWAYS return a list even if there's only one item.
- list_category: A single lowercase category word (same rules as add_note category).
- summary: Confirmation mentioning all items added, e.g. "Added 5 movies to your watchlist."

FOR remove_from_list:
- remove_list_name: Slug of the list to remove from, e.g. "movie-watchlist". Hyphens, lowercase. \
  Infer from context if not explicitly stated.
- remove_items: A LIST of items to remove. Clean up names with proper capitalization. \
  ALWAYS return a list even if there's only one item.
- summary: Confirmation like "Removed Murder Mystery from your watchlist."

FOR move_item:
- move_source_name: The name of the source note or list to move FROM. \
  Use the slug if it's a list (e.g. "movie-watchlist"), or the note title if it's a note. \
  Match against RECENT NOTES titles and list names above.
- move_dest_name: The name of the destination note or list to move TO. \
  Same format — slug for lists, title for notes. Match against RECENT NOTES above.
- move_items: A LIST of items to move. Clean names with proper capitalization. \
  ALWAYS return a list even if there's only one item.
- summary: Confirmation like "Moved OrangeSlice.ai from Bookmarks to Startups to Research."

FOR add_task:
- task_title: Clean, concise task title. Proper capitalization. \
  E.g. "Buy groceries", "Submit quarterly report", "Call the dentist".
- task_description: Optional additional details about the task.
- task_due_date: Due date in YYYY-MM-DD format. Resolve relative dates using CURRENT DATE above. \
  "tomorrow" → next day, "friday" → coming Friday, "next week" → next Monday, \
  "end of month" → last day of current month. null if no date specified.
- task_due_time: Due time in HH:MM (24h) format. null if no time specified.
- task_priority: Priority 1-4. 1=urgent(red), 2=high(orange), 3=medium(blue), 4=normal(default). \
  Infer from context: "urgent", "ASAP", "critical" → 1. "important" → 2. Default is 4.
- task_project: Project name, lowercase slug. Default "inbox". \
  Infer from context: work-related → "work", personal → "personal", etc.
- task_labels: Optional list of label strings. E.g. ["phone", "errands"].
- summary: Confirmation like "Added task: Buy groceries — due Friday."

FOR add_event:
- event_title: Clean event title. E.g. "Meeting with John", "Dentist Appointment", "Team Standup".
- event_date: Event date in YYYY-MM-DD format. Resolve relative dates using CURRENT DATE above.
- event_start_time: Start time in HH:MM (24h) format. E.g. "14:00", "09:30". null for all-day.
- event_end_time: End time in HH:MM (24h) format. If not specified, default to 1 hour after start. \
  null for all-day events.
- event_all_day: true if no specific time, false if time is specified.
- event_location: Location string if mentioned. null otherwise.
- event_description: Additional details/description. null if none.
- event_color: One of: "blue", "red", "green", "orange", "purple", "teal". Default "blue". \
  Infer from context if possible (work → blue, personal → green, urgent → red).
- summary: Confirmation like "Scheduled: Meeting with John — tomorrow at 3:00 PM."

Leave irrelevant fields as null.\
"""

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class MessageRequest(BaseModel):
    message: str


class NoteResponse(BaseModel):
    intent: Literal["add_note", "append_to_note", "rewrite_note", "add_to_list", "remove_from_list", "move_item", "add_bookmark", "search", "respond", "add_task", "add_event"]
    # add_note
    category: Optional[str] = None
    title: Optional[str] = None
    polished_content: Optional[str] = None
    summary: Optional[str] = None
    # append_to_note / rewrite_note
    target_note_id: Optional[str] = None
    append_content: Optional[str] = None
    rewrite_content: Optional[str] = None
    # add_to_list
    list_name: Optional[str] = None
    list_items: Optional[list[str]] = None
    list_category: Optional[str] = None
    # remove_from_list
    remove_list_name: Optional[str] = None
    remove_items: Optional[list[str]] = None
    # move_item
    move_source_name: Optional[str] = None
    move_dest_name: Optional[str] = None
    move_items: Optional[list[str]] = None
    # add_bookmark
    bookmark_url: Optional[str] = None
    bookmark_title: Optional[str] = None
    bookmark_type: Optional[str] = None  # video, article, startup, website, tool, other
    bookmark_description: Optional[str] = None
    # search
    search_query: Optional[str] = None
    # respond
    response_text: Optional[str] = None
    # add_task
    task_title: Optional[str] = None
    task_description: Optional[str] = None
    task_due_date: Optional[str] = None  # YYYY-MM-DD
    task_due_time: Optional[str] = None  # HH:MM
    task_priority: Optional[int] = None  # 1-4
    task_project: Optional[str] = None
    task_labels: Optional[list[str]] = None
    # add_event
    event_title: Optional[str] = None
    event_date: Optional[str] = None  # YYYY-MM-DD
    event_start_time: Optional[str] = None  # HH:MM
    event_end_time: Optional[str] = None  # HH:MM
    event_all_day: Optional[bool] = None
    event_location: Optional[str] = None
    event_description: Optional[str] = None
    event_color: Optional[str] = None


class ChatResponse(BaseModel):
    type: Literal["note_saved", "note_updated", "note_rewritten", "list_updated", "list_item_removed", "item_moved", "bookmark_saved", "search_results", "chat_response", "task_created", "event_created"]
    message: str
    results: Optional[list] = None
    category: Optional[str] = None
    title: Optional[str] = None
    items: Optional[list[str]] = None
    removed_items: Optional[list[str]] = None
    source_title: Optional[str] = None
    action_id: Optional[str] = None
    note_id: Optional[str] = None
    bookmark_url: Optional[str] = None
    bookmark_type: Optional[str] = None


class EditNoteRequest(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None


class NoteAIRequest(BaseModel):
    prompt: str


class MoveNoteRequest(BaseModel):
    new_category: str


class TaskCreateRequest(BaseModel):
    title: str
    description: str = ""
    due_date: Optional[str] = None
    due_time: Optional[str] = None
    priority: int = 4
    project: str = "inbox"
    labels: list[str] = []


class TaskUpdateRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[str] = None
    due_time: Optional[str] = None
    priority: Optional[int] = None
    completed: Optional[bool] = None
    project: Optional[str] = None
    labels: Optional[list[str]] = None
    sort_order: Optional[int] = None


class EventCreateRequest(BaseModel):
    title: str
    date: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    all_day: bool = False
    location: str = ""
    description: str = ""
    color: str = "blue"


class EventUpdateRequest(BaseModel):
    title: Optional[str] = None
    date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    all_day: Optional[bool] = None
    location: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None

# ---------------------------------------------------------------------------
# App + clients
# ---------------------------------------------------------------------------
app = FastAPI()

_api_key = os.environ.get("OPENAI_API_KEY", "")
if not _api_key:
    raise RuntimeError(
        "OPENAI_API_KEY environment variable is not set. "
        "Export it before starting the server: export OPENAI_API_KEY='sk-...'"
    )
openai_client = OpenAI(api_key=_api_key)

chroma_client = chromadb.PersistentClient(path=str(BASE_DIR / "chroma_db"))
collection = chroma_client.get_or_create_collection(
    name="notes",
    metadata={"hnsw:space": "cosine"},
)

# Undo / redo stacks (in-memory)
undo_stack: list[dict] = []
redo_stack: list[dict] = []
UNDO_MAX = 30

# Conversation history (in-memory) — gives the AI context for "them", "it", "there", etc.
conversation_history: list[dict] = []
HISTORY_MAX = 20


def _push_undo(action: dict):
    action["timestamp"] = datetime.now().isoformat()
    undo_stack.append(action)
    if len(undo_stack) > UNDO_MAX:
        undo_stack.pop(0)
    redo_stack.clear()  # new action invalidates redo history


def _add_to_history(role: str, content: str):
    conversation_history.append({"role": role, "content": content})
    if len(conversation_history) > HISTORY_MAX:
        conversation_history.pop(0)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_filename(name: str) -> str:
    return re.sub(r"[^\w\-]", "", name.replace(" ", "-")).lower()


def get_recent_notes(n: int = 5) -> str:
    """Get recent notes as context string for the AI."""
    if collection.count() == 0:
        return "(none yet)"

    # Get all notes and sort by created date
    all_notes = collection.get(include=["documents", "metadatas"])
    if not all_notes["ids"]:
        return "(none yet)"

    # Pair up and sort by created date descending
    paired = list(zip(all_notes["ids"], all_notes["documents"], all_notes["metadatas"]))
    paired.sort(key=lambda x: x[2].get("created", ""), reverse=True)

    lines = []
    for note_id, doc, meta in paired[:n]:
        preview = doc[:120].replace("\n", " ")
        lines.append(f"- ID: {note_id} | Title: {meta['title']} | Category: {meta['category']} | Preview: {preview}")

    return "\n".join(lines) if lines else "(none yet)"


def save_note_to_disk(category: str, title: str, content: str) -> Path:
    category_dir = NOTES_DIR / category
    category_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"{timestamp}-{_safe_filename(title)}.md"
    filepath = category_dir / filename

    frontmatter = (
        f"---\ntitle: {title}\ncategory: {category}\n"
        f"created: {datetime.now().isoformat()}\n---\n\n"
    )
    filepath.write_text(frontmatter + content, encoding="utf-8")
    return filepath


def append_to_note_file(filepath: str, new_content: str) -> str:
    """Append content to an existing note file. Returns full document content."""
    path = Path(filepath)
    if not path.exists():
        return new_content

    existing = path.read_text(encoding="utf-8")
    parts = existing.split("---", 2)
    if len(parts) >= 3:
        frontmatter = f"---{parts[1]}---\n\n"
        old_content = parts[2].strip()
        updated_content = old_content + "\n\n" + new_content
        path.write_text(frontmatter + updated_content, encoding="utf-8")
        return updated_content
    else:
        updated = existing + "\n\n" + new_content
        path.write_text(updated, encoding="utf-8")
        return updated


def add_to_chromadb(
    note_id: str,
    content: str,
    category: str,
    title: str,
    filepath: str,
    is_list: bool = False,
    list_name: str | None = None,
    original_text: str = "",
):
    collection.upsert(
        ids=[note_id],
        documents=[content],
        metadatas=[
            {
                "category": category,
                "title": title,
                "filepath": filepath,
                "is_list": str(is_list),
                "list_name": list_name or "",
                "created": datetime.now().isoformat(),
                "original_text": original_text,
            }
        ],
    )


def find_existing_list(list_name: str) -> dict | None:
    results = collection.get(
        where={"list_name": list_name},
        include=["documents", "metadatas"],
    )
    if results["ids"]:
        return {
            "id": results["ids"][0],
            "document": results["documents"][0],
            "metadata": results["metadatas"][0],
        }
    return None


def append_to_list_file(filepath: str, items: list[str]) -> str:
    path = Path(filepath)
    existing = path.read_text(encoding="utf-8")
    new_lines = "".join(f"- {item}\n" for item in items)
    updated = existing + new_lines
    path.write_text(updated, encoding="utf-8")
    parts = updated.split("---", 2)
    if len(parts) >= 3:
        return parts[2].strip()
    return updated


def create_list_file(category: str, list_name: str, items: list[str]) -> Path:
    category_dir = NOTES_DIR / category
    category_dir.mkdir(parents=True, exist_ok=True)

    display_name = list_name.replace("-", " ").title()
    filename = f"{_safe_filename(list_name)}.md"
    filepath = category_dir / filename

    frontmatter = (
        f"---\ntitle: {display_name}\ncategory: {category}\n"
        f"type: list\ncreated: {datetime.now().isoformat()}\n---\n\n"
    )
    # No heading — title is in the frontmatter and shown by the UI
    content = "".join(f"- {item}\n" for item in items)
    filepath.write_text(frontmatter + content, encoding="utf-8")
    return filepath


def search_notes(query: str, n_results: int = 5, max_distance: float = 0.65) -> list:
    if collection.count() == 0:
        return []

    results = collection.query(
        query_texts=[query],
        n_results=min(n_results, collection.count()),
        include=["documents", "metadatas", "distances"],
    )

    notes = []
    for i in range(len(results["ids"][0])):
        distance = results["distances"][0][i]
        if distance > max_distance:
            continue
        notes.append(
            {
                "id": results["ids"][0][i],
                "content": results["documents"][0][i],
                "category": results["metadatas"][0][i]["category"],
                "title": results["metadatas"][0][i]["title"],
                "created": results["metadatas"][0][i].get("created", ""),
                "distance": distance,
            }
        )
    return notes

def find_bookmarks_file() -> dict | None:
    """Find the existing bookmarks collection in ChromaDB."""
    results = collection.get(
        where={"list_name": "bookmarks"},
        include=["documents", "metadatas"],
    )
    if results["ids"]:
        return {
            "id": results["ids"][0],
            "document": results["documents"][0],
            "metadata": results["metadatas"][0],
        }
    return None


def create_bookmarks_file(url: str, title: str, btype: str, desc: str) -> Path:
    """Create the initial bookmarks markdown file."""
    cat_dir = NOTES_DIR / "personal"
    cat_dir.mkdir(parents=True, exist_ok=True)
    filepath = cat_dir / "bookmarks.md"
    frontmatter = (
        f"---\ntitle: Bookmarks\ncategory: personal\n"
        f"type: list\ncreated: {datetime.now().isoformat()}\n---\n\n"
    )
    entry = f"- [{title}]({url}) — *{btype}* · {desc}\n"
    filepath.write_text(frontmatter + entry, encoding="utf-8")
    return filepath


def append_bookmark_to_file(filepath: str, url: str, title: str, btype: str, desc: str) -> str:
    """Add or update a bookmark entry in the bookmarks file. Returns content.
    If a bookmark with the same URL or title already exists, replace it."""
    path = Path(filepath)
    existing = path.read_text(encoding="utf-8")
    entry = f"- [{title}]({url}) — *{btype}* · {desc}"
    new_entry_line = entry + "\n"

    # Check for duplicate by URL or title (case-insensitive)
    url_lower = url.lower().rstrip("/")
    title_lower = title.lower()
    lines = existing.split("\n")
    replaced = False
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("- ["):
            line_lower = stripped.lower()
            # Match by URL or by title
            has_url = url_lower and url_lower in line_lower
            has_title = title_lower and f"[{title_lower}]" in line_lower
            if has_url or has_title:
                if not replaced:
                    new_lines.append(entry)
                    replaced = True
                # Skip duplicate lines
                continue
        new_lines.append(line)

    if replaced:
        updated = "\n".join(new_lines) + "\n"
    else:
        updated = existing + new_entry_line

    path.write_text(updated, encoding="utf-8")
    parts = updated.split("---", 2)
    if len(parts) >= 3:
        return parts[2].strip()
    return updated


def find_note_by_name(name: str) -> dict | None:
    """Find a note by list_name slug OR by fuzzy title match."""
    # First try exact list_name match
    result = find_existing_list(name)
    if result:
        return result
    # Try slug variant (e.g. "bookmarks" → might be stored differently)
    slug = name.lower().replace(" ", "-")
    result = find_existing_list(slug)
    if result:
        return result
    # Fall back to title search across all notes
    all_notes = collection.get(include=["documents", "metadatas"])
    if not all_notes["ids"]:
        return None
    query_lower = name.lower().replace("-", " ")
    best = None
    best_score = 0
    for i, meta in enumerate(all_notes["metadatas"]):
        note_title = meta["title"].lower()
        list_name = meta.get("list_name", "").replace("-", " ")
        # Check various matching strategies
        score = 0
        if query_lower == note_title or query_lower == list_name:
            score = 100  # exact match
        elif query_lower in note_title or note_title in query_lower:
            score = 80  # substring match
        elif query_lower in list_name or list_name in query_lower:
            score = 70
        else:
            # Check word overlap
            q_words = set(query_lower.split())
            t_words = set(note_title.split())
            overlap = q_words & t_words
            if overlap:
                score = len(overlap) * 20
        if score > best_score:
            best_score = score
            best = {
                "id": all_notes["ids"][i],
                "document": all_notes["documents"][i],
                "metadata": all_notes["metadatas"][i],
            }
    return best if best_score >= 60 else None


def remove_from_list_file(filepath: str, items_to_remove: list[str]) -> tuple[str, list[str]]:
    """Remove items from a list markdown file. Returns (updated_content, actually_removed)."""
    path = Path(filepath)
    raw = path.read_text(encoding="utf-8")
    parts = raw.split("---", 2)
    if len(parts) < 3:
        return raw, []

    frontmatter = f"---{parts[1]}---\n\n"
    body = parts[2].strip()
    lines = body.split("\n")

    # Normalize items to remove for case-insensitive matching
    remove_lower = [item.lower().strip() for item in items_to_remove]

    kept = []
    removed = []
    for line in lines:
        stripped = line.strip()
        # Match lines like "- Item Name" or "- [Title](url) — ..."
        if stripped.startswith("- "):
            item_text = stripped[2:].strip()
            # For plain list items, compare directly
            # For bookmark-style items, extract the display text
            compare_text = item_text.lower()
            matched = False
            for rm in remove_lower:
                if rm in compare_text or compare_text in rm:
                    matched = True
                    removed.append(item_text)
                    break
            if not matched:
                kept.append(line)
        else:
            kept.append(line)

    new_body = "\n".join(kept)
    path.write_text(frontmatter + new_body + "\n", encoding="utf-8")
    return new_body.strip(), removed


def generate_answer(question: str, notes: list) -> str:
    """Generate a conversational answer based on found notes."""
    context = "\n\n---\n\n".join(
        f"**{n['title']}** ({n['category']})\n{n['content']}"
        for n in notes
    )

    response = openai_client.chat.completions.create(
        model="gpt-4o",
        max_tokens=1024,
        messages=[
            {"role": "system", "content": (
                "You are a helpful assistant. The user asked a question about their notes. "
                "Below are the relevant notes found. Answer the user's question based on "
                "these notes in a natural, conversational way. Use markdown formatting. "
                "Be concise but thorough. If the notes contain the answer, give it directly. "
                "Do NOT say 'based on your notes' or 'I found' — just answer naturally."
            )},
            {"role": "user", "content": f"Question: {question}\n\nNotes:\n{context}"},
        ],
    )
    return response.choices[0].message.content


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/api/message")
async def handle_message(request: MessageRequest):
    if len(request.message) > 4000:
        return JSONResponse(
            status_code=400,
            content={"error": "Message too long (max 4000 characters)"},
        )

    recent = get_recent_notes(5)
    today_str = datetime.now().strftime("%A, %B %d, %Y")
    prompt = SYSTEM_PROMPT.replace("{recent_notes}", recent).replace("{current_date}", today_str)

    # Build messages with conversation history for context
    messages = [{"role": "system", "content": prompt}]
    messages.extend(conversation_history)
    messages.append({"role": "user", "content": request.message})

    try:
    
        response = openai_client.beta.chat.completions.parse(
            model="gpt-4o",
            max_tokens=1024,
            messages=messages,
            response_format=NoteResponse,
        )
    except Exception as exc:
        return JSONResponse(
            status_code=502,
            content={"error": f"AI service unavailable: {exc}"},
        )

    result = response.choices[0].message.parsed
    if result is None:
        return JSONResponse(
            status_code=502,
            content={"error": "AI returned an unparseable response. Please try again."},
        )

    action_id = str(uuid.uuid4())

    # Record user message in history
    _add_to_history("user", request.message)

    # Process intent and build response
    chat_resp = _handle_intent(result, action_id, request.message)

    # Record assistant action in history (concise summary for context)
    _add_to_history("assistant", f"[{result.intent}] {chat_resp.message}")

    return chat_resp


def _handle_intent(result: NoteResponse, action_id: str, original_message: str) -> ChatResponse:
    """Process a parsed intent and return the appropriate ChatResponse."""

    if result.intent == "add_note":
        note_id = str(uuid.uuid4())
        filepath = save_note_to_disk(
            category=result.category, title=result.title,
            content=result.polished_content,
        )
        add_to_chromadb(
            note_id=note_id, content=result.polished_content,
            category=result.category, title=result.title,
            filepath=str(filepath), original_text=original_message,
        )
        _push_undo({"id": action_id, "type": "note_created",
                     "note_id": note_id, "filepath": str(filepath)})
        return ChatResponse(
            type="note_saved", message=result.summary,
            category=result.category, title=result.title,
            action_id=action_id, note_id=note_id,
        )

    elif result.intent == "append_to_note":
        target_id = result.target_note_id
        existing = collection.get(ids=[target_id], include=["documents", "metadatas"])
        if not existing["ids"]:
            note_id = str(uuid.uuid4())
            cat = result.category or "personal"
            ttl = result.title or "Untitled"
            filepath = save_note_to_disk(category=cat, title=ttl, content=result.append_content)
            add_to_chromadb(note_id=note_id, content=result.append_content,
                            category=cat, title=ttl, filepath=str(filepath),
                            original_text=original_message)
            _push_undo({"id": action_id, "type": "note_created",
                         "note_id": note_id, "filepath": str(filepath)})
            return ChatResponse(
                type="note_saved", message=result.summary,
                category=cat, title=ttl,
                action_id=action_id, note_id=note_id,
            )

        meta = existing["metadatas"][0]
        prev_doc = existing["documents"][0]
        updated_content = append_to_note_file(meta["filepath"], result.append_content)
        collection.update(ids=[target_id], documents=[updated_content])
        _push_undo({"id": action_id, "type": "note_appended",
                     "note_id": target_id, "filepath": meta["filepath"],
                     "previous_document": prev_doc})
        return ChatResponse(
            type="note_updated", message=result.summary,
            category=meta["category"], title=meta["title"],
            action_id=action_id, note_id=target_id,
        )

    elif result.intent == "rewrite_note":
        target_id = result.target_note_id
        existing = collection.get(ids=[target_id], include=["documents", "metadatas"])
        if not existing["ids"]:
            return ChatResponse(
                type="chat_response",
                message="I couldn't find that note to rewrite.",
            )

        meta = existing["metadatas"][0]
        prev_doc = existing["documents"][0]
        filepath = Path(meta["filepath"])
        new_content = result.rewrite_content

        # Save to disk
        if filepath.exists():
            frontmatter = (
                f"---\ntitle: {meta['title']}\ncategory: {meta['category']}\n"
                f"created: {meta.get('created', datetime.now().isoformat())}\n---\n\n"
            )
            filepath.write_text(frontmatter + new_content, encoding="utf-8")

        # Update ChromaDB
        collection.update(ids=[target_id], documents=[new_content])

        # Push undo (can restore previous content)
        _push_undo({"id": action_id, "type": "note_appended",
                     "note_id": target_id, "filepath": meta["filepath"],
                     "previous_document": prev_doc})

        return ChatResponse(
            type="note_rewritten", message=result.summary,
            category=meta["category"], title=meta["title"],
            action_id=action_id, note_id=target_id,
        )

    elif result.intent == "add_to_list":
        items = result.list_items or []
        existing = find_existing_list(result.list_name)

        if existing:
            prev_doc = existing["document"]
            updated_content = append_to_list_file(
                existing["metadata"]["filepath"], items)
            add_to_chromadb(
                note_id=existing["id"], content=updated_content,
                category=existing["metadata"]["category"],
                title=existing["metadata"]["title"],
                filepath=existing["metadata"]["filepath"],
                is_list=True, list_name=result.list_name,
                original_text=existing["metadata"].get("original_text", ""),
            )
            _push_undo({"id": action_id, "type": "list_appended",
                         "note_id": existing["id"],
                         "filepath": existing["metadata"]["filepath"],
                         "previous_document": prev_doc})
            return ChatResponse(
                type="list_updated", message=result.summary,
                category=existing["metadata"]["category"],
                title=existing["metadata"]["title"],
                items=items, action_id=action_id, note_id=existing["id"],
            )
        else:
            note_id = str(uuid.uuid4())
            filepath = create_list_file(
                category=result.list_category,
                list_name=result.list_name, items=items,
            )
            display_name = result.list_name.replace("-", " ").title()
            content = "\n".join(f"- {item}" for item in items)
            add_to_chromadb(
                note_id=note_id, content=content,
                category=result.list_category, title=display_name,
                filepath=str(filepath), is_list=True,
                list_name=result.list_name, original_text=original_message,
            )
            _push_undo({"id": action_id, "type": "list_created",
                         "note_id": note_id, "filepath": str(filepath)})
            return ChatResponse(
                type="list_updated", message=result.summary,
                category=result.list_category, title=display_name,
                items=items, action_id=action_id, note_id=note_id,
            )

    elif result.intent == "remove_from_list":
        items = result.remove_items or []
        existing = find_existing_list(result.remove_list_name)

        if not existing:
            return ChatResponse(
                type="chat_response",
                message=f"I couldn't find a list matching \"{result.remove_list_name}\". Try checking your lists first!",
            )

        prev_doc = existing["document"]
        updated_content, actually_removed = remove_from_list_file(
            existing["metadata"]["filepath"], items
        )

        if not actually_removed:
            return ChatResponse(
                type="chat_response",
                message=f"I couldn't find {', '.join(items)} in your {existing['metadata']['title']}.",
            )

        add_to_chromadb(
            note_id=existing["id"], content=updated_content,
            category=existing["metadata"]["category"],
            title=existing["metadata"]["title"],
            filepath=existing["metadata"]["filepath"],
            is_list=True, list_name=result.remove_list_name,
            original_text=existing["metadata"].get("original_text", ""),
        )
        _push_undo({"id": action_id, "type": "list_appended",
                     "note_id": existing["id"],
                     "filepath": existing["metadata"]["filepath"],
                     "previous_document": prev_doc})
        return ChatResponse(
            type="list_item_removed",
            message=result.summary or f"Removed {', '.join(actually_removed)} from your list.",
            category=existing["metadata"]["category"],
            title=existing["metadata"]["title"],
            removed_items=actually_removed,
            action_id=action_id, note_id=existing["id"],
        )

    elif result.intent == "move_item":
        items = result.move_items or []

        # Find source
        source = find_note_by_name(result.move_source_name or "")
        if not source:
            return ChatResponse(
                type="chat_response",
                message=f"I couldn't find a note or list matching \"{result.move_source_name}\".",
            )

        # Remove from source first
        prev_source_doc = source["document"]
        updated_source, actually_removed = remove_from_list_file(
            source["metadata"]["filepath"], items
        )

        if not actually_removed:
            return ChatResponse(
                type="chat_response",
                message=f"I couldn't find {', '.join(items)} in {source['metadata']['title']}.",
            )

        # Extract clean item names (strip bookmark formatting like [Title](url) — ...)
        clean_items = []
        for item in actually_removed:
            m = re.match(r'\[([^\]]+)\]', item)
            if m:
                clean_items.append(m.group(1))
            else:
                clean_items.append(item)

        # Update source in ChromaDB
        collection.update(ids=[source["id"]], documents=[updated_source])

        # Find or create destination
        dest = find_note_by_name(result.move_dest_name or "")
        dest_created = False

        if dest:
            # Destination exists — append items to it
            prev_dest_doc = dest["document"]
            updated_dest = append_to_list_file(dest["metadata"]["filepath"], clean_items)
            collection.update(ids=[dest["id"]], documents=[updated_dest])
        else:
            # Destination doesn't exist — create a new list
            dest_created = True
            dest_slug = (result.move_dest_name or "misc").lower().replace(" ", "-")
            dest_category = source["metadata"]["category"]  # inherit from source
            dest_display = dest_slug.replace("-", " ").title()
            dest_note_id = str(uuid.uuid4())
            dest_filepath = create_list_file(
                category=dest_category, list_name=dest_slug, items=clean_items,
            )
            dest_content = "\n".join(f"- {item}" for item in clean_items)
            add_to_chromadb(
                note_id=dest_note_id, content=dest_content,
                category=dest_category, title=dest_display,
                filepath=str(dest_filepath), is_list=True,
                list_name=dest_slug, original_text=original_message,
            )
            prev_dest_doc = ""
            dest = {
                "id": dest_note_id,
                "metadata": {
                    "filepath": str(dest_filepath),
                    "title": dest_display,
                    "category": dest_category,
                },
            }

        # Push undo (stores both previous states)
        undo_entry = {
            "id": action_id,
            "source_id": source["id"],
            "source_filepath": source["metadata"]["filepath"],
            "source_prev_doc": prev_source_doc,
            "dest_id": dest["id"],
            "dest_filepath": dest["metadata"]["filepath"],
            "dest_prev_doc": prev_dest_doc,
        }
        if dest_created:
            undo_entry["type"] = "item_moved_new_dest"
        else:
            undo_entry["type"] = "item_moved"
        _push_undo(undo_entry)

        return ChatResponse(
            type="item_moved",
            message=result.summary or f"Moved {', '.join(clean_items)} from {source['metadata']['title']} to {dest['metadata']['title']}.",
            title=dest["metadata"]["title"],
            category=dest["metadata"]["category"],
            items=clean_items,
            source_title=source["metadata"]["title"],
            action_id=action_id, note_id=dest["id"],
        )

    elif result.intent == "add_bookmark":
        url = result.bookmark_url or ""
        title = result.bookmark_title or "Untitled"
        btype = result.bookmark_type or "website"
        desc = result.bookmark_description or ""

        existing = find_bookmarks_file()
        if existing:
            prev_doc = existing["document"]
            updated_content = append_bookmark_to_file(
                existing["metadata"]["filepath"], url, title, btype, desc
            )
            # Prefix with "Bookmarks:" for better semantic search
            searchable = "Bookmarks — saved links, articles, videos, startups, websites:\n" + updated_content
            add_to_chromadb(
                note_id=existing["id"], content=searchable,
                category="personal", title="Bookmarks",
                filepath=existing["metadata"]["filepath"],
                is_list=True, list_name="bookmarks",
                original_text=existing["metadata"].get("original_text", ""),
            )
            _push_undo({"id": action_id, "type": "list_appended",
                         "note_id": existing["id"],
                         "filepath": existing["metadata"]["filepath"],
                         "previous_document": prev_doc})
            return ChatResponse(
                type="bookmark_saved", message=result.summary or f"Bookmarked {title}.",
                category="personal", title=title,
                action_id=action_id, note_id=existing["id"],
                bookmark_url=url, bookmark_type=btype,
            )
        else:
            note_id = str(uuid.uuid4())
            filepath = create_bookmarks_file(url, title, btype, desc)
            content = f"Bookmarks — saved links, articles, videos, startups, websites:\n- [{title}]({url}) — *{btype}* · {desc}"
            add_to_chromadb(
                note_id=note_id, content=content,
                category="personal", title="Bookmarks",
                filepath=str(filepath), is_list=True,
                list_name="bookmarks", original_text=original_message,
            )
            _push_undo({"id": action_id, "type": "list_created",
                         "note_id": note_id, "filepath": str(filepath)})
            return ChatResponse(
                type="bookmark_saved", message=result.summary or f"Bookmarked {title}.",
                category="personal", title=title,
                action_id=action_id, note_id=note_id,
                bookmark_url=url, bookmark_type=btype,
            )

    elif result.intent == "add_task":
        task_id = str(uuid.uuid4())
        now = datetime.now().isoformat()
        task = {
            "id": task_id,
            "title": result.task_title or "Untitled task",
            "description": result.task_description or "",
            "due_date": result.task_due_date,
            "due_time": result.task_due_time,
            "priority": result.task_priority or 4,
            "completed": False,
            "completed_at": None,
            "project": result.task_project or "inbox",
            "labels": result.task_labels or [],
            "parent_id": None,
            "sort_order": 0,
            "created": now,
        }
        tasks = _load_tasks()
        tasks.append(task)
        _save_tasks(tasks)
        return ChatResponse(
            type="task_created",
            message=result.summary or f"Added task: {task['title']}",
            title=task["title"],
            category=task["project"],
            action_id=action_id,
        )

    elif result.intent == "add_event":
        event_id = str(uuid.uuid4())
        now = datetime.now().isoformat()
        start = result.event_start_time
        end = result.event_end_time
        all_day = result.event_all_day if result.event_all_day is not None else (start is None)
        if start and not end:
            # Default 1 hour duration
            try:
                sh, sm = map(int, start.split(":"))
                eh, em = sh + 1, sm
                if eh >= 24:
                    eh = 23
                    em = 59
                end = f"{eh:02d}:{em:02d}"
            except Exception:
                end = None
        event = {
            "id": event_id,
            "title": result.event_title or "Untitled event",
            "date": result.event_date or datetime.now().strftime("%Y-%m-%d"),
            "start_time": start,
            "end_time": end,
            "all_day": all_day,
            "location": result.event_location or "",
            "description": result.event_description or "",
            "color": result.event_color or "blue",
            "created": now,
        }
        events = _load_events()
        events.append(event)
        _save_events(events)
        return ChatResponse(
            type="event_created",
            message=result.summary or f"Scheduled: {event['title']}",
            title=event["title"],
            category=event["color"],
            action_id=action_id,
        )

    elif result.intent == "search":
        notes = search_notes(result.search_query)
        if not notes:
            # No relevant notes found — try a broader search with relaxed threshold
            notes = search_notes(result.search_query, max_distance=0.80)
        if not notes:
            return ChatResponse(
                type="search_results",
                message="I couldn't find any notes related to that. Try adding some first!",
                results=[],
            )
        answer = generate_answer(original_message, notes)
        return ChatResponse(
            type="search_results",
            message=answer,
            results=notes,
        )

    elif result.intent == "respond":
        return ChatResponse(
            type="chat_response",
            message=result.response_text or "I'm not sure how to help with that.",
        )

    # Fallback — should never be reached, but prevents returning None
    return ChatResponse(
        type="chat_response",
        message="I wasn't sure how to handle that. Could you rephrase?",
    )


@app.get("/api/health")
async def health():
    return {"status": "ok", "notes_count": collection.count()}


@app.get("/api/categories")
async def list_categories():
    categories = []
    if NOTES_DIR.exists():
        for cat_dir in sorted(NOTES_DIR.iterdir()):
            if cat_dir.is_dir():
                files = list(cat_dir.glob("*.md"))
                if files:
                    categories.append({"name": cat_dir.name, "count": len(files)})
    return {"categories": categories}


def _safe_category(name: str) -> str:
    """Sanitise a category name so it can't escape NOTES_DIR."""
    name = name.strip().lower()
    name = re.sub(r"[^a-z0-9_-]", "", name)
    if not name or name.startswith("."):
        name = "misc"
    return name


@app.get("/api/notes/{category}")
async def list_notes_in_category(category: str):
    category = _safe_category(category)
    cat_dir = NOTES_DIR / category
    if not cat_dir.exists():
        return {"notes": []}

    # Build filepath -> chromadb data mapping
    filepath_to_id = {}
    filepath_to_original = {}
    chroma_results = collection.get(where={"category": category}, include=["metadatas"])
    for cid, meta in zip(chroma_results["ids"], chroma_results["metadatas"]):
        fp = meta.get("filepath", "")
        filepath_to_id[fp] = cid
        filepath_to_original[fp] = meta.get("original_text", "")

    notes = []
    for f in sorted(cat_dir.glob("*.md"), reverse=True):
        raw = f.read_text(encoding="utf-8")
        parts = raw.split("---", 2)
        title = f.stem
        created = ""
        content = raw
        if len(parts) >= 3:
            for line in parts[1].strip().splitlines():
                if line.startswith("title:"):
                    title = line.split(":", 1)[1].strip()
                elif line.startswith("created:"):
                    created = line.split(":", 1)[1].strip()
            content = parts[2].strip()

        notes.append({
            "id": filepath_to_id.get(str(f), ""),
            "filename": f.name,
            "title": title,
            "category": category,
            "created": created,
            "content": content,
            "original_text": filepath_to_original.get(str(f), ""),
        })
    return {"notes": notes}


@app.get("/api/note/{note_id}")
async def get_note_by_id(note_id: str):
    results = collection.get(ids=[note_id], include=["documents", "metadatas"])
    if not results["ids"]:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    meta = results["metadatas"][0]
    filepath = Path(meta["filepath"])
    content = results["documents"][0]

    if filepath.exists():
        raw = filepath.read_text(encoding="utf-8")
        parts = raw.split("---", 2)
        if len(parts) >= 3:
            content = parts[2].strip()

    return {
        "id": note_id,
        "title": meta["title"],
        "category": meta["category"],
        "content": content,
        "created": meta.get("created", ""),
        "is_list": meta.get("is_list", "False") == "True",
        "original_text": meta.get("original_text", ""),
    }


@app.put("/api/note/{note_id}")
async def edit_note(note_id: str, req: EditNoteRequest):
    results = collection.get(ids=[note_id], include=["documents", "metadatas"])
    if not results["ids"]:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    meta = results["metadatas"][0]
    filepath = Path(meta["filepath"])

    new_title = req.title or meta["title"]
    new_content = req.content if req.content is not None else results["documents"][0]

    # Push undo before modifying
    _push_undo({
        "id": str(uuid.uuid4()),
        "type": "note_appended",
        "note_id": note_id,
        "filepath": meta["filepath"],
        "previous_document": results["documents"][0],
        "previous_title": meta["title"],
    })

    if filepath.exists():
        frontmatter = (
            f"---\ntitle: {new_title}\ncategory: {meta['category']}\n"
            f"created: {meta.get('created', datetime.now().isoformat())}\n---\n\n"
        )
        filepath.write_text(frontmatter + new_content, encoding="utf-8")

    collection.update(
        ids=[note_id],
        documents=[new_content],
        metadatas=[{**meta, "title": new_title}],
    )
    return {"ok": True}


@app.post("/api/note/{note_id}/ai")
async def ai_transform_note(note_id: str, req: NoteAIRequest):
    results = collection.get(ids=[note_id], include=["documents", "metadatas"])
    if not results["ids"]:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    meta = results["metadatas"][0]
    filepath = Path(meta["filepath"])
    content = results["documents"][0]

    if filepath.exists():
        raw = filepath.read_text(encoding="utf-8")
        parts = raw.split("---", 2)
        if len(parts) >= 3:
            content = parts[2].strip()

    # Push undo before modifying
    _push_undo({
        "id": str(uuid.uuid4()),
        "type": "note_appended",
        "note_id": note_id,
        "filepath": meta["filepath"],
        "previous_document": content,
    })


    response = openai_client.chat.completions.create(
        model="gpt-4o",
        max_tokens=2048,
        messages=[
            {"role": "system", "content": (
                "You are editing a note. The user has given you an instruction about how to "
                "modify the note's content. Apply the instruction and return ONLY the updated "
                "note content in markdown format. Do not add any explanation, preamble, or "
                "commentary. Do not wrap in code blocks. Just return the updated content directly.\n"
                "IMPORTANT rules:\n"
                "- Preserve the general format (bullet lists stay as bullet lists, etc).\n"
                "- Do NOT start with a heading that repeats the note title.\n"
                "- When reorganizing or enhancing items, REPLACE existing items in place — "
                "do NOT create duplicates.\n"
                "- If asked to add details (e.g. authors to books), update each item in place.\n"
                "- If there are existing duplicates, merge them into one entry each."
            )},
            {"role": "user", "content": (
                f"Note title: {meta['title']}\n\n"
                f"Current content:\n{content}\n\n"
                f"Instruction: {req.prompt}"
            )},
        ],
    )
    new_content = response.choices[0].message.content

    # Save to disk and ChromaDB
    if filepath.exists():
        frontmatter = (
            f"---\ntitle: {meta['title']}\ncategory: {meta['category']}\n"
            f"created: {meta.get('created', datetime.now().isoformat())}\n---\n\n"
        )
        filepath.write_text(frontmatter + new_content, encoding="utf-8")

    collection.update(ids=[note_id], documents=[new_content])
    return {"ok": True, "content": new_content}


@app.delete("/api/note/{note_id}")
async def delete_note(note_id: str):
    results = collection.get(ids=[note_id], include=["metadatas"])
    if not results["ids"]:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    meta = results["metadatas"][0]
    filepath = Path(meta["filepath"])

    if filepath.exists():
        filepath.unlink()
        if filepath.parent.exists() and not any(filepath.parent.iterdir()):
            filepath.parent.rmdir()

    collection.delete(ids=[note_id])
    return {"ok": True}


@app.patch("/api/note/{note_id}/move")
async def move_note(note_id: str, req: MoveNoteRequest):
    results = collection.get(ids=[note_id], include=["documents", "metadatas"])
    if not results["ids"]:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    meta = results["metadatas"][0]
    old_path = Path(meta["filepath"])
    new_cat = req.new_category

    new_dir = NOTES_DIR / new_cat
    new_dir.mkdir(parents=True, exist_ok=True)
    new_path = new_dir / old_path.name

    if old_path.exists():
        raw = old_path.read_text(encoding="utf-8")
        raw = re.sub(r"(?m)^category: .+$", f"category: {new_cat}", raw)
        new_path.write_text(raw, encoding="utf-8")
        old_path.unlink()
        if old_path.parent.exists() and not any(old_path.parent.iterdir()):
            old_path.parent.rmdir()

    updated_meta = {**meta, "category": new_cat, "filepath": str(new_path)}
    collection.update(ids=[note_id], metadatas=[updated_meta])
    return {"ok": True, "new_category": new_cat}


@app.delete("/api/category/{name}")
async def delete_category(name: str):
    name = _safe_category(name)
    cat_dir = NOTES_DIR / name
    if not cat_dir.exists():
        return JSONResponse(status_code=404, content={"error": "Not found"})

    for f in cat_dir.glob("*.md"):
        f.unlink()
    cat_dir.rmdir()

    matches = collection.get(where={"category": name}, include=[])
    if matches["ids"]:
        collection.delete(ids=matches["ids"])

    return {"ok": True}


def _capture_note_snapshot(note_id: str) -> dict | None:
    """Capture current state of a note for redo/undo purposes."""
    try:
        results = collection.get(ids=[note_id], include=["documents", "metadatas"])
        if not results["ids"]:
            return None
        filepath = Path(results["metadatas"][0].get("filepath", ""))
        file_content = filepath.read_text(encoding="utf-8") if filepath.exists() else None
        return {
            "note_id": note_id,
            "document": results["documents"][0],
            "metadata": results["metadatas"][0],
            "filepath": str(filepath),
            "file_content": file_content,
        }
    except Exception:
        return None


def _restore_snapshot(snap: dict):
    """Restore a note to a previously captured snapshot state."""
    filepath = Path(snap["filepath"])
    filepath.parent.mkdir(parents=True, exist_ok=True)
    if snap.get("file_content") is not None:
        filepath.write_text(snap["file_content"], encoding="utf-8")
    if snap.get("document") is not None and snap.get("metadata") is not None:
        collection.upsert(
            ids=[snap["note_id"]],
            documents=[snap["document"]],
            metadatas=[snap["metadata"]],
        )


def _do_undo(action: dict) -> dict | None:
    """Execute an undo action and return a redo entry (or None)."""
    atype = action["type"]

    if atype in ("note_created", "list_created"):
        note_id = action["note_id"]
        filepath = Path(action["filepath"])
        # Capture full state for redo (recreate)
        snap = _capture_note_snapshot(note_id)
        # Delete
        if filepath.exists():
            filepath.unlink()
            if filepath.parent.exists() and not any(filepath.parent.iterdir()):
                filepath.parent.rmdir()
        try:
            collection.delete(ids=[note_id])
        except Exception:
            pass
        if snap:
            return {"redo_type": "recreate", "snapshot": snap, "original_action": action}
        return None

    elif atype in ("note_appended", "list_appended"):
        note_id = action["note_id"]
        filepath = Path(action["filepath"])
        prev_doc = action["previous_document"]
        prev_title = action.get("previous_title")
        # Capture current state for redo
        snap = _capture_note_snapshot(note_id)
        # Restore previous document (and title if changed)
        if filepath.exists():
            raw = filepath.read_text(encoding="utf-8")
            parts = raw.split("---", 2)
            if len(parts) >= 3:
                fm = parts[1]
                if prev_title:
                    fm = re.sub(r"(?m)^title: .+$", f"title: {prev_title}", fm)
                filepath.write_text(f"---{fm}---\n\n" + prev_doc, encoding="utf-8")
        try:
            if prev_title:
                existing = collection.get(ids=[note_id], include=["metadatas"])
                if existing["ids"]:
                    meta = {**existing["metadatas"][0], "title": prev_title}
                    collection.update(ids=[note_id], documents=[prev_doc], metadatas=[meta])
                else:
                    collection.update(ids=[note_id], documents=[prev_doc])
            else:
                collection.update(ids=[note_id], documents=[prev_doc])
        except Exception:
            pass
        if snap:
            return {"redo_type": "restore", "snapshot": snap, "original_action": action}
        return None

    elif atype == "item_moved":
        src_snap = _capture_note_snapshot(action["source_id"])
        dest_snap = _capture_note_snapshot(action["dest_id"])
        # Restore source
        src_path = Path(action["source_filepath"])
        if src_path.exists():
            raw = src_path.read_text(encoding="utf-8")
            parts = raw.split("---", 2)
            if len(parts) >= 3:
                src_path.write_text(f"---{parts[1]}---\n\n" + action["source_prev_doc"], encoding="utf-8")
        try:
            collection.update(ids=[action["source_id"]], documents=[action["source_prev_doc"]])
        except Exception:
            pass
        # Restore dest
        dest_path = Path(action["dest_filepath"])
        if dest_path.exists():
            raw = dest_path.read_text(encoding="utf-8")
            parts = raw.split("---", 2)
            if len(parts) >= 3:
                dest_path.write_text(f"---{parts[1]}---\n\n" + action["dest_prev_doc"], encoding="utf-8")
        try:
            collection.update(ids=[action["dest_id"]], documents=[action["dest_prev_doc"]])
        except Exception:
            pass
        return {
            "redo_type": "restore_pair",
            "source_snapshot": src_snap, "dest_snapshot": dest_snap,
            "original_action": action,
        }

    elif atype == "item_moved_new_dest":
        src_snap = _capture_note_snapshot(action["source_id"])
        dest_snap = _capture_note_snapshot(action["dest_id"])
        # Restore source
        src_path = Path(action["source_filepath"])
        if src_path.exists():
            raw = src_path.read_text(encoding="utf-8")
            parts = raw.split("---", 2)
            if len(parts) >= 3:
                src_path.write_text(f"---{parts[1]}---\n\n" + action["source_prev_doc"], encoding="utf-8")
        try:
            collection.update(ids=[action["source_id"]], documents=[action["source_prev_doc"]])
        except Exception:
            pass
        # Delete new dest
        dest_path = Path(action["dest_filepath"])
        if dest_path.exists():
            dest_path.unlink()
            if dest_path.parent.exists() and not any(dest_path.parent.iterdir()):
                dest_path.parent.rmdir()
        try:
            collection.delete(ids=[action["dest_id"]])
        except Exception:
            pass
        return {
            "redo_type": "restore_and_recreate",
            "source_snapshot": src_snap, "dest_snapshot": dest_snap,
            "original_action": action,
        }

    return None


def _do_redo(entry: dict):
    """Execute a redo and push a corresponding undo entry."""
    rtype = entry["redo_type"]

    if rtype == "recreate":
        snap = entry["snapshot"]
        _restore_snapshot(snap)
        undo_stack.append(entry["original_action"])

    elif rtype == "restore":
        # Capture current state first (will become the next undo's previous_document)
        current_snap = _capture_note_snapshot(entry["snapshot"]["note_id"])
        _restore_snapshot(entry["snapshot"])
        # Push undo that can reverse this redo
        undo_entry = dict(entry["original_action"])
        if current_snap:
            undo_entry["previous_document"] = current_snap["document"]
        undo_stack.append(undo_entry)

    elif rtype == "restore_pair":
        if entry.get("source_snapshot"):
            _restore_snapshot(entry["source_snapshot"])
        if entry.get("dest_snapshot"):
            _restore_snapshot(entry["dest_snapshot"])
        undo_stack.append(entry["original_action"])

    elif rtype == "restore_and_recreate":
        if entry.get("source_snapshot"):
            _restore_snapshot(entry["source_snapshot"])
        if entry.get("dest_snapshot"):
            _restore_snapshot(entry["dest_snapshot"])
        undo_stack.append(entry["original_action"])


@app.post("/api/undo/{action_id}")
async def undo_action(action_id: str):
    action = None
    for i, a in enumerate(undo_stack):
        if a["id"] == action_id:
            action = undo_stack.pop(i)
            break
    if not action:
        return JSONResponse(status_code=404,
                            content={"error": "Action expired or already undone"})
    redo_entry = _do_undo(action)
    if redo_entry:
        redo_stack.append(redo_entry)
    return {"ok": True, "undone": action["type"],
            "can_undo": len(undo_stack) > 0, "can_redo": len(redo_stack) > 0}


@app.post("/api/undo")
async def undo_last():
    if not undo_stack:
        return JSONResponse(status_code=404, content={"error": "Nothing to undo"})
    action = undo_stack.pop()
    redo_entry = _do_undo(action)
    if redo_entry:
        redo_stack.append(redo_entry)
    return {"ok": True, "undone": action["type"],
            "can_undo": len(undo_stack) > 0, "can_redo": len(redo_stack) > 0}


@app.post("/api/redo")
async def redo_last():
    if not redo_stack:
        return JSONResponse(status_code=404, content={"error": "Nothing to redo"})
    entry = redo_stack.pop()
    _do_redo(entry)
    return {"ok": True, "can_undo": len(undo_stack) > 0, "can_redo": len(redo_stack) > 0}


@app.get("/api/undo-status")
async def undo_status():
    return {"can_undo": len(undo_stack) > 0, "can_redo": len(redo_stack) > 0}


@app.get("/api/recent")
async def get_recent():
    if collection.count() == 0:
        return {"recent": []}

    all_notes = collection.get(include=["metadatas"])
    paired = list(zip(all_notes["ids"], all_notes["metadatas"]))
    paired.sort(key=lambda x: x[1].get("created", ""), reverse=True)

    recent = []
    for note_id, meta in paired[:10]:
        recent.append({
            "id": note_id,
            "title": meta["title"],
            "category": meta["category"],
            "created": meta.get("created", ""),
        })
    return {"recent": recent}


# ---------------------------------------------------------------------------
# Task CRUD endpoints
# ---------------------------------------------------------------------------

@app.get("/api/tasks")
async def get_tasks(project: str | None = None, view: str | None = None):
    tasks = _load_tasks()
    today = datetime.now().strftime("%Y-%m-%d")

    if view == "today":
        tasks = [t for t in tasks if not t["completed"] and t.get("due_date") == today]
    elif view == "upcoming":
        tasks = [t for t in tasks if not t["completed"] and t.get("due_date") and t["due_date"] >= today]
        tasks.sort(key=lambda t: t.get("due_date", "9999"))
    elif view == "overdue":
        tasks = [t for t in tasks if not t["completed"] and t.get("due_date") and t["due_date"] < today]
    elif view == "completed":
        tasks = [t for t in tasks if t["completed"]]
    elif project:
        tasks = [t for t in tasks if not t["completed"] and t.get("project") == project]
    else:
        tasks = [t for t in tasks if not t["completed"]]

    return {"tasks": tasks}


@app.get("/api/tasks/projects")
async def get_task_projects():
    tasks = _load_tasks()
    projects = {}
    for t in tasks:
        p = t.get("project", "inbox")
        if p not in projects:
            projects[p] = {"name": p, "count": 0, "completed": 0}
        if t.get("completed"):
            projects[p]["completed"] += 1
        else:
            projects[p]["count"] += 1
    return {"projects": list(projects.values())}


@app.post("/api/tasks")
async def create_task(req: TaskCreateRequest):
    task_id = str(uuid.uuid4())
    task = {
        "id": task_id,
        "title": req.title,
        "description": req.description,
        "due_date": req.due_date,
        "due_time": req.due_time,
        "priority": req.priority,
        "completed": False,
        "completed_at": None,
        "project": req.project,
        "labels": req.labels,
        "parent_id": None,
        "sort_order": 0,
        "created": datetime.now().isoformat(),
    }
    tasks = _load_tasks()
    tasks.append(task)
    _save_tasks(tasks)
    return {"ok": True, "task": task}


@app.put("/api/tasks/{task_id}")
async def update_task(task_id: str, req: TaskUpdateRequest):
    tasks = _load_tasks()
    for t in tasks:
        if t["id"] == task_id:
            if req.title is not None:
                t["title"] = req.title
            if req.description is not None:
                t["description"] = req.description
            if req.due_date is not None:
                t["due_date"] = req.due_date if req.due_date != "" else None
            if req.due_time is not None:
                t["due_time"] = req.due_time if req.due_time != "" else None
            if req.priority is not None:
                t["priority"] = req.priority
            if req.completed is not None:
                t["completed"] = req.completed
                t["completed_at"] = datetime.now().isoformat() if req.completed else None
            if req.project is not None:
                t["project"] = req.project
            if req.labels is not None:
                t["labels"] = req.labels
            if req.sort_order is not None:
                t["sort_order"] = req.sort_order
            _save_tasks(tasks)
            return {"ok": True, "task": t}
    return JSONResponse(status_code=404, content={"error": "Task not found"})


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str):
    tasks = _load_tasks()
    tasks = [t for t in tasks if t["id"] != task_id]
    _save_tasks(tasks)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Event CRUD endpoints
# ---------------------------------------------------------------------------

@app.get("/api/events")
async def get_events(month: str | None = None, date: str | None = None):
    events = _load_events()
    if date:
        events = [e for e in events if e.get("date") == date]
    elif month:
        events = [e for e in events if e.get("date", "")[:7] == month]
    return {"events": events}


@app.post("/api/events")
async def create_event(req: EventCreateRequest):
    event_id = str(uuid.uuid4())
    start = req.start_time
    end = req.end_time
    if start and not end:
        try:
            sh, sm = map(int, start.split(":"))
            eh, em = sh + 1, sm
            if eh >= 24:
                eh, em = 23, 59
            end = f"{eh:02d}:{em:02d}"
        except Exception:
            end = None
    event = {
        "id": event_id,
        "title": req.title,
        "date": req.date,
        "start_time": start,
        "end_time": end,
        "all_day": req.all_day,
        "location": req.location,
        "description": req.description,
        "color": req.color,
        "created": datetime.now().isoformat(),
    }
    events = _load_events()
    events.append(event)
    _save_events(events)
    return {"ok": True, "event": event}


@app.put("/api/events/{event_id}")
async def update_event(event_id: str, req: EventUpdateRequest):
    events = _load_events()
    for e in events:
        if e["id"] == event_id:
            if req.title is not None:
                e["title"] = req.title
            if req.date is not None:
                e["date"] = req.date
            if req.start_time is not None:
                e["start_time"] = req.start_time
            if req.end_time is not None:
                e["end_time"] = req.end_time
            if req.all_day is not None:
                e["all_day"] = req.all_day
            if req.location is not None:
                e["location"] = req.location
            if req.description is not None:
                e["description"] = req.description
            if req.color is not None:
                e["color"] = req.color
            _save_events(events)
            return {"ok": True, "event": e}
    return JSONResponse(status_code=404, content={"error": "Event not found"})


@app.delete("/api/events/{event_id}")
async def delete_event(event_id: str):
    events = _load_events()
    events = [e for e in events if e["id"] != event_id]
    _save_events(events)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------

@app.get("/")
async def root():
    return HTMLResponse((BASE_DIR / "static" / "index.html").read_text())


app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
