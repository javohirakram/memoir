"""
Memoir — FastAPI app for Vercel serverless deployment.
All storage uses Vercel Postgres (Neon) with pgvector for semantic search.
"""

import os
import re
import json
import uuid
import sys
from datetime import datetime, timedelta, date as date_type
from typing import Literal, Optional

# Allow imports from parent directory (db.py lives at project root)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from openai import AsyncOpenAI
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import jwt
try:
    from google.oauth2 import id_token as google_id_token
    from google.auth.transport import requests as google_requests
except ImportError as _gauth_err:
    google_id_token = None
    google_requests = None
    _gauth_import_error = str(_gauth_err)

from db import get_cursor, check_and_increment_rate_limit, get_user_plan

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

AI_MODEL = os.environ.get("AI_MODEL", "gpt-4o-mini")
RATE_LIMIT_FREE = 50
RATE_LIMIT_PRO = 500
UNLIMITED_EMAILS = set(filter(None, os.environ.get("UNLIMITED_EMAILS", "").split(",")))

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
  *** IMPORTANT: TASK & SCHEDULE QUERIES *** \
  If the user asks about their tasks, schedule, or calendar — such as "what are my tasks today?", \
  "what's on my schedule?", "what do I have due this week?", "any tasks for tomorrow?", \
  "am I free on Friday?", "what's coming up?" — use "respond" and answer using the \
  RECENT TASKS and UPCOMING EVENTS data above. Format the answer nicely with markdown lists. \
  Include due dates, times, priorities, and project info. If asking about "today", only include \
  tasks/events matching today's date ({current_date}). \
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
  ALSO triggers when user says "add [item/it] to [note] and delete the task" — treat the task \
  as the source and the named note as the destination. \
  The source can be a task (use the task title as move_source_name, resolved from conversation \
  history or RECENT TASKS). "it" refers to the most recently mentioned task or item. \
  Both source and destination must be identifiable from context or recent notes/tasks. \
  E.g. "move orange slice from bookmarks to startups to research". \
  E.g. "add it to my west coast trip note and delete the task" → move_item where source = recent task, dest = west coast trip note.
- "add_bookmark": User shares a URL or asks to bookmark/save a link, article, video, \
  startup, website, or online resource. Triggers when the message contains a URL \
  (http/https) OR uses words like "bookmark", "save this link/article/video/site". \
  Also triggers for "check out [URL]", "interesting startup: [URL]", etc.
- "add_task": User wants to create a TASK or TODO item — an ACTION they need to PERFORM. \
  Trigger words: "task", "todo", "remind me to", "need to", "have to", "don't forget to", \
  "gotta", "should do", "by [date]", "deadline". Also triggers when the user describes an \
  action item with a deadline or something they need to get done. \
  TASK ACTION VERBS (always add_task, even if date/time given): send, email, call (place a call), \
  buy, submit, fix, draft, write, edit, review, research, file, return, cancel, clean, \
  practice, apply, plan, back up, record, pick up, renew, pay, book (as in "book an appointment"), \
  transfer, finish, read (as in "read chapter X"). \
  E.g. "buy groceries by friday" → add_task. "submit report by end of week" → add_task. \
  "send email to prof Monday at 9am" → add_task (action to perform AT that time). \
  "call bank ASAP" → add_task. "buy a black turtleneck" → add_task (shopping action). \
  "practice presentation 30 min tonight" → add_task. "gym every other day at 8pm" → add_task. \
  Distinguish from "add_note": tasks are ACTION ITEMS with something to DO, while notes are \
  INFORMATION to save. "meeting notes from today" → add_note. "prepare for meeting tomorrow" → add_task. \
  *** TODOIST-STYLE METADATA *** \
  Parse these inline markers and strip them from task_title: \
  #tag → add to task_labels (e.g. "#errands" → labels: ["errands"]) \
  p1/p2/p3/p4 → task_priority (p1=1 urgent, p2=2 high, p3=3 medium, p4=4 normal) \
  @context → add to task_labels (e.g. "@laptop" → labels: ["laptop"]) \
  Example: "Fix bug p1 #work @laptop" → title="Fix bug", priority=1, labels=["work","laptop"].
- "add_event": User wants to create a CALENDAR EVENT — something they ATTEND, OBSERVE, or \
  BLOCK TIME for at a scheduled moment. \
  EVENT NOUNS (always add_event): meeting, appointment, dinner, lunch, breakfast, coffee chat, \
  flight, train, party, game, concert, lecture, class, exam, midterm, interview, webinar, \
  presentation (as a scheduled session), standup, offsite, visit, viewing, reservation, \
  birthday party, career fair, office hours. \
  An event has a specific DATE and usually a TIME. E.g. "meeting with John tomorrow at 3pm", \
  "dentist appointment on March 5 at 10am", "team standup every monday 9am", \
  "lunch with Sarah at noon on Friday". \
  If no time is specified but it's clearly a scheduled event, set all_day = true. \
  *** TASK vs EVENT KEY RULE *** \
  Events = things you ATTEND or are PRESENT at (meetings, dinners, flights, appointments, classes). \
  Tasks = things you DO/COMPLETE (send, buy, fix, submit, draft, call, review, practice). \
  Even if a task has a specific time, it stays add_task — the time is when to DO it, not a slot to attend. \
  "Send email Monday at 9am" → add_task. "Meeting Monday at 9am" → add_event. \
  "Buy gift before Sunday" → add_task. "Birthday party Sunday at 7pm" → add_event. \
  "Book dentist appointment" → add_task. "Dentist appointment Tuesday at 10am" → add_event. \
  *** DURATION *** If duration is given (e.g. "for 45 minutes", "for 1 hour"), compute \
  event_end_time by adding the duration to event_start_time. \
  *** TIMEZONE *** If a timezone is mentioned (e.g. "8pm Doha time", "10am ET"), include it \
  in event_description so the user can see it. Use the local time as event_start_time. \
  *** MULTI-DAY *** For events spanning multiple days (e.g. "March 5 to March 13"), \
  set event_date to the start date and event_end_date to the end date.
- "delete_task": User wants to REMOVE or DELETE an existing task. \
  Trigger words: "delete task", "remove task", "cancel task", "done with task", "drop task". \
  Also matches when user says "remove the [task name] task" or "delete [task name] from tasks". \
  E.g. "delete the bridgewater task", "remove research task". \
  If the user says "move [task] to [note/list]", this is NOT delete_task — use move_item instead.
- "delete_event": User wants to REMOVE or DELETE an existing calendar event. \
  Trigger words: "delete event", "cancel event", "remove event", "cancel meeting", "cancel appointment". \
  E.g. "cancel the dentist appointment", "delete the macro midterm event".

*** CURRENT DATE: {current_date} (use this to resolve "today", "tomorrow", "next monday", etc.) ***

RECENT TASKS (for context — helps with delete/edit AND answering task queries):
{recent_tasks}

UPCOMING EVENTS (for context — helps with delete/edit AND answering schedule queries):
{upcoming_events}

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
- bookmark_title: ONLY set this if the user explicitly provides a title or you are 100% certain \
  of the page title (e.g. well-known sites like "Stripe", "GitHub"). DO NOT guess or fabricate \
  titles for articles, tweets, or blog posts — the system fetches the real title automatically. \
  When unsure, use the domain name (e.g. "nytimes.com", "x.com").
- bookmark_type: ONE of: video, article, startup, website, tool, other. \
  Classify carefully: YouTube/Vimeo/Loom links = video. \
  Substack/Medium/blog posts/news = article. X/Twitter posts = article. \
  GitHub repos/npm packages/dev tools = tool. Company landing pages = website or startup.
- bookmark_description: A brief one-line description ONLY if the user provided context about the link. \
  If the user just pasted a URL with no description, set this to an empty string. \
  DO NOT make up descriptions for content you haven't read.
- summary: Confirmation like "Bookmarked [domain]." Keep it simple.

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
- move_source_name: The name of the source note, list, or TASK to move FROM. \
  Use the slug if it's a list (e.g. "movie-watchlist"), the note title if it's a note, \
  or the task title if it's a task (match against RECENT TASKS above). \
  If user says "it" or "the task", resolve to the most recently mentioned task/item.
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
- event_date: Event START date in YYYY-MM-DD format. Resolve relative dates using CURRENT DATE above.
- event_end_date: Event END date in YYYY-MM-DD format. Only set for multi-day events \
  (e.g. "March 5 to March 13" → event_date="2026-03-05", event_end_date="2026-03-13"). \
  null for single-day events.
- event_start_time: Start time in HH:MM (24h) format. E.g. "14:00", "09:30". null for all-day.
- event_end_time: End time in HH:MM (24h) format. If not specified, default to 1 hour after start. \
  If a duration is given (e.g. "for 45 minutes"), compute end = start + duration. \
  null for all-day events.
- event_all_day: true if no specific time, false if time is specified.
- event_location: Location string if mentioned. null otherwise.
- event_description: Additional details/description. Include timezone info if mentioned \
  (e.g. "8pm Doha time" → description includes "Doha time / AST"). null if none.
- event_color: One of: "blue", "red", "green", "orange", "purple", "teal". Default "blue". \
  Infer from context if possible (work → blue, personal → green, urgent → red).
- summary: Confirmation like "Scheduled: Meeting with John — tomorrow at 3:00 PM."

FOR delete_task:
- delete_target_title: The title (or partial title) of the task to delete. \
  Match against RECENT TASKS above. Use the closest match.
- summary: Confirmation like "Deleted task: Research Bridgewater Associates."

FOR delete_event:
- delete_target_title: The title (or partial title) of the event to delete. \
  Match against recent events. Use the closest match.
- summary: Confirmation like "Deleted event: Macro Midterm."

Leave irrelevant fields as null.\
"""

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class MessageRequest(BaseModel):
    message: str


class NoteResponse(BaseModel):
    intent: Literal["add_note", "append_to_note", "rewrite_note", "add_to_list", "remove_from_list", "move_item", "add_bookmark", "search", "respond", "add_task", "add_event", "delete_task", "delete_event"]
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
    bookmark_type: Optional[str] = None
    bookmark_description: Optional[str] = None
    # search
    search_query: Optional[str] = None
    # respond
    response_text: Optional[str] = None
    # add_task
    task_title: Optional[str] = None
    task_description: Optional[str] = None
    task_due_date: Optional[str] = None
    task_due_time: Optional[str] = None
    task_priority: Optional[int] = None
    task_project: Optional[str] = None
    task_labels: Optional[list[str]] = None
    # add_event
    event_title: Optional[str] = None
    event_date: Optional[str] = None
    event_end_date: Optional[str] = None
    event_start_time: Optional[str] = None
    event_end_time: Optional[str] = None
    event_all_day: Optional[bool] = None
    event_location: Optional[str] = None
    event_description: Optional[str] = None
    event_color: Optional[str] = None
    # delete_task / delete_event
    delete_target_title: Optional[str] = None


class ChatResponse(BaseModel):
    type: Literal["note_saved", "note_updated", "note_rewritten", "list_updated", "list_item_removed", "item_moved", "bookmark_saved", "search_results", "chat_response", "task_created", "event_created", "task_deleted", "event_deleted"]
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
    end_date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    all_day: bool = False
    location: str = ""
    description: str = ""
    color: str = "blue"


class EventUpdateRequest(BaseModel):
    title: Optional[str] = None
    date: Optional[str] = None
    end_date: Optional[str] = None
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

# ---------------------------------------------------------------------------
# CORS — restrict to our own domains
# ---------------------------------------------------------------------------
_allowed_origins = [
    "https://getmemoir.vercel.app",
    "https://smart-notes-psi-ten.vercel.app",
]
if os.environ.get("VERCEL_ENV") != "production":
    _allowed_origins.append("http://localhost:8000")
    _allowed_origins.append("http://localhost:3000")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

# ---------------------------------------------------------------------------
# Sentry (optional — no-op if SENTRY_DSN not set)
# ---------------------------------------------------------------------------
_sentry_dsn = os.environ.get("SENTRY_DSN", "")
if _sentry_dsn:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        sentry_sdk.init(
            dsn=_sentry_dsn,
            integrations=[StarletteIntegration(), FastApiIntegration()],
            traces_sample_rate=0.1,
            send_default_pii=False,
        )
    except ImportError:
        pass

_api_key = os.environ.get("OPENAI_API_KEY", "")
if not _api_key:
    raise RuntimeError(
        "OPENAI_API_KEY environment variable is not set. "
        "Export it before starting the server: export OPENAI_API_KEY='sk-...'"
    )
openai_client = AsyncOpenAI(api_key=_api_key)

# ---------------------------------------------------------------------------
# Auth config
# ---------------------------------------------------------------------------
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
JWT_SECRET = os.environ.get("JWT_SECRET", "")
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET environment variable is required. Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\"")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 30


def get_current_user(request: Request) -> str:
    """Extract and verify JWT from Authorization header. Returns user_id or raises 401."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise ValueError("Missing token")
    token = auth[7:]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload["user_id"]
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError, KeyError):
        raise ValueError("Invalid token")


def _get_email_from_token(request: Request) -> str:
    """Extract email from JWT payload. Returns empty string on failure."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return ""
    try:
        payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload.get("email", "")
    except Exception:
        return ""


def _auth_error():
    return JSONResponse(status_code=401, content={"error": "Not authenticated"})


# Undo / redo stacks (in-memory, per-user — acceptable to lose on cold start)
undo_stacks: dict[str, list[dict]] = {}
redo_stacks: dict[str, list[dict]] = {}
UNDO_MAX = 30

# Conversation history — persisted in DB for cross-device + cold-start resilience
HISTORY_MAX = 10


def _push_undo(user_id: str, action: dict):
    stack = undo_stacks.setdefault(user_id, [])
    action["timestamp"] = datetime.now().isoformat()
    stack.append(action)
    if len(stack) > UNDO_MAX:
        stack.pop(0)
    redo_stacks.setdefault(user_id, []).clear()


def _get_conversation_history(user_id: str) -> list[dict]:
    """Load conversation history from DB."""
    with get_cursor() as cur:
        cur.execute("SELECT history FROM conversation_context WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    return row["history"] if row else []


def _add_to_history(user_id: str, role: str, content: str):
    history = _get_conversation_history(user_id)
    history.append({"role": role, "content": content})
    if len(history) > HISTORY_MAX:
        history = history[-HISTORY_MAX:]
    with get_cursor() as cur:
        cur.execute("""
            INSERT INTO conversation_context (user_id, history, updated) VALUES (%s, %s, NOW())
            ON CONFLICT (user_id) DO UPDATE SET history = %s, updated = NOW()
        """, (user_id, json.dumps(history), json.dumps(history)))


# ---------------------------------------------------------------------------
# Embedding helpers
# ---------------------------------------------------------------------------

async def generate_embedding(text: str) -> list[float]:
    """Generate a 1536-dim embedding using OpenAI text-embedding-3-small."""
    response = await openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=text[:8000],
    )
    return response.data[0].embedding


# ---------------------------------------------------------------------------
# Note storage helpers (all DB-backed)
# ---------------------------------------------------------------------------

async def save_note(note_id: str, category: str, title: str, content: str,
              original_text: str = "", is_list: bool = False,
              list_name: str | None = None, user_id: str = ""):
    """Insert or update a note with its embedding."""
    embedding = await generate_embedding(content)
    with get_cursor() as cur:
        cur.execute("""
            INSERT INTO notes (id, user_id, title, category, content, original_text,
                               is_list, list_name, embedding)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                category = EXCLUDED.category,
                content = EXCLUDED.content,
                original_text = EXCLUDED.original_text,
                is_list = EXCLUDED.is_list,
                list_name = EXCLUDED.list_name,
                embedding = EXCLUDED.embedding,
                updated = NOW()
        """, (note_id, user_id, title, category, content, original_text,
              is_list, list_name, embedding))


def get_note_by_id_from_db(note_id: str, user_id: str = "") -> dict | None:
    """Fetch a single note by ID, scoped to user."""
    with get_cursor() as cur:
        cur.execute("SELECT * FROM notes WHERE id = %s AND user_id = %s", (note_id, user_id))
        row = cur.fetchone()
    return dict(row) if row else None


async def append_to_note_content(note_id: str, new_content: str, user_id: str = "") -> str | None:
    """Append content to an existing note. Returns the full updated content."""
    with get_cursor() as cur:
        cur.execute("SELECT content FROM notes WHERE id = %s AND user_id = %s", (note_id, user_id))
        row = cur.fetchone()
        if not row:
            return None
        updated = row["content"].strip() + "\n\n" + new_content
        embedding = await generate_embedding(updated)
        cur.execute("""
            UPDATE notes SET content = %s, embedding = %s, updated = NOW()
            WHERE id = %s AND user_id = %s
        """, (updated, embedding, note_id, user_id))
    return updated


def get_recent_notes(n: int = 5, user_id: str = "") -> str:
    """Get recent notes as context string for the AI."""
    with get_cursor() as cur:
        cur.execute("""
            SELECT id, title, category, content FROM notes
            WHERE user_id = %s
            ORDER BY created DESC LIMIT %s
        """, (user_id, n))
        rows = cur.fetchall()
    if not rows:
        return "(none yet)"
    lines = []
    for r in rows:
        preview = r["content"][:120].replace("\n", " ")
        lines.append(f"- ID: {r['id']} | Title: {r['title']} | Category: {r['category']} | Preview: {preview}")
    return "\n".join(lines)


def find_existing_list(list_name: str, user_id: str = "") -> dict | None:
    """Find a note by its list_name slug, scoped to user."""
    with get_cursor() as cur:
        cur.execute("""
            SELECT id, title, category, content, original_text, is_list, list_name
            FROM notes WHERE list_name = %s AND user_id = %s LIMIT 1
        """, (list_name, user_id))
        row = cur.fetchone()
    if row:
        return {
            "id": row["id"],
            "document": row["content"],
            "metadata": dict(row),
        }
    return None


async def append_to_list_content(note_id: str, items: list[str], user_id: str = "") -> str:
    """Append bullet items to a list note. Returns updated content."""
    new_lines = "".join(f"- {item}\n" for item in items)
    with get_cursor() as cur:
        cur.execute("SELECT content FROM notes WHERE id = %s AND user_id = %s", (note_id, user_id))
        row = cur.fetchone()
        if not row:
            return new_lines.strip()
        updated = row["content"] + "\n" + new_lines
        embedding = await generate_embedding(updated)
        cur.execute("""
            UPDATE notes SET content = %s, embedding = %s, updated = NOW()
            WHERE id = %s AND user_id = %s
        """, (updated, embedding, note_id, user_id))
    return updated


async def search_notes(query: str, n_results: int = 5, max_distance: float = 0.60, user_id: str = "") -> list:
    """Semantic search using pgvector cosine distance, scoped to user."""
    with get_cursor() as cur:
        cur.execute("SELECT COUNT(*) as cnt FROM notes WHERE user_id = %s", (user_id,))
        cnt = cur.fetchone()["cnt"]
    if cnt == 0:
        return []

    query_embedding = await generate_embedding(query)
    with get_cursor() as cur:
        cur.execute("""
            SELECT id, title, category, content, created,
                   embedding <=> %s::vector AS distance
            FROM notes
            WHERE embedding IS NOT NULL AND user_id = %s
            ORDER BY embedding <=> %s::vector
            LIMIT %s
        """, (query_embedding, user_id, query_embedding, n_results))
        results = []
        for row in cur.fetchall():
            if row["distance"] > max_distance:
                continue
            results.append({
                "id": row["id"],
                "content": row["content"],
                "category": row["category"],
                "title": row["title"],
                "created": str(row["created"]),
                "distance": float(row["distance"]),
            })
    return results


def find_note_by_name(name: str, user_id: str = "") -> dict | None:
    """Find a note by list_name slug OR by fuzzy title match, scoped to user."""
    result = find_existing_list(name, user_id)
    if result:
        return result
    slug = name.lower().replace(" ", "-")
    result = find_existing_list(slug, user_id)
    if result:
        return result

    # SQL-based fuzzy title search using pg_trgm similarity
    query_clean = name.lower().replace("-", " ")
    with get_cursor() as cur:
        # Try exact case-insensitive match first, then ILIKE substring, then trigram similarity
        cur.execute("""
            SELECT id, title, category, content, original_text, is_list, list_name,
                   CASE
                       WHEN LOWER(title) = %s THEN 100
                       WHEN LOWER(COALESCE(REPLACE(list_name, '-', ' '), '')) = %s THEN 100
                       WHEN LOWER(title) ILIKE '%%' || %s || '%%' THEN 80
                       WHEN LOWER(COALESCE(REPLACE(list_name, '-', ' '), '')) ILIKE '%%' || %s || '%%' THEN 70
                       ELSE GREATEST(similarity(LOWER(title), %s), similarity(LOWER(COALESCE(list_name, '')), %s)) * 100
                   END AS score
            FROM notes
            WHERE user_id = %s
              AND (
                  LOWER(title) = %s
                  OR LOWER(COALESCE(REPLACE(list_name, '-', ' '), '')) = %s
                  OR LOWER(title) ILIKE '%%' || %s || '%%'
                  OR LOWER(COALESCE(REPLACE(list_name, '-', ' '), '')) ILIKE '%%' || %s || '%%'
                  OR similarity(LOWER(title), %s) > 0.3
              )
            ORDER BY score DESC
            LIMIT 1
        """, (query_clean, query_clean, query_clean, query_clean, query_clean, query_clean,
              user_id, query_clean, query_clean, query_clean, query_clean, query_clean))
        row = cur.fetchone()
    if row and row["score"] >= 60:
        return {
            "id": row["id"],
            "document": row["content"],
            "metadata": {k: row[k] for k in ("id", "title", "category", "content", "original_text", "is_list", "list_name")},
        }
    return None


async def remove_from_list_content(note_id: str, items_to_remove: list[str], user_id: str = "") -> tuple[str, list[str]]:
    """Remove items from a list note. Returns (updated_content, actually_removed)."""
    with get_cursor() as cur:
        cur.execute("SELECT content FROM notes WHERE id = %s AND user_id = %s", (note_id, user_id))
        row = cur.fetchone()
    if not row:
        return "", []

    body = row["content"]
    lines = body.split("\n")
    remove_lower = [item.lower().strip() for item in items_to_remove]

    kept = []
    removed = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("- "):
            item_text = stripped[2:].strip()
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
    if removed:
        embedding = await generate_embedding(new_body)
        with get_cursor() as cur:
            cur.execute("""
                UPDATE notes SET content = %s, embedding = %s, updated = NOW()
                WHERE id = %s AND user_id = %s
            """, (new_body, embedding, note_id, user_id))
    return new_body.strip(), removed


def _title_from_url(url: str) -> str | None:
    """Extract a readable title from the URL path slug. Fallback when page fetch fails."""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    domain = parsed.netloc.replace("www.", "")
    # Get the last meaningful path segment (the article slug)
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    if not parts:
        return domain
    slug = parts[-1]
    # Remove file extensions
    slug = re.sub(r'\.(html?|php|aspx?)$', '', slug)
    # Skip if slug is just an ID or very short
    if len(slug) < 5 or slug.isdigit():
        return domain
    # Convert slug to title: "alysa-liu-eileen-gu-china" → "Alysa Liu Eileen Gu China"
    readable = re.sub(r'[-_]+', ' ', slug).strip()
    if len(readable) < 5:
        return domain
    return f"{readable.title()} ({domain})"


def _fetch_tweet_text(url: str) -> str | None:
    """Use Twitter's public oembed API to get actual tweet text. No auth needed."""
    import requests as http_requests
    try:
        # Normalise x.com → twitter.com for the oembed endpoint
        oembed_url = url.replace("x.com/", "twitter.com/")
        resp = http_requests.get(
            "https://publish.twitter.com/oembed",
            params={"url": oembed_url, "omit_script": "true"},
            timeout=4,
        )
        resp.raise_for_status()
        data = resp.json()
        # oembed returns HTML like <blockquote>...<p>tweet text</p>...</blockquote>
        html_str = data.get("html", "")
        # Extract text from the first <p> tag (the actual tweet)
        m = re.search(r"<p[^>]*>(.*?)</p>", html_str, re.DOTALL)
        if not m:
            return data.get("author_name")  # at least return who tweeted
        import html as html_mod
        text = re.sub(r"<[^>]+>", "", m.group(1))  # strip inner HTML tags
        text = html_mod.unescape(text).strip()
        if len(text) > 120:
            text = text[:117] + "..."
        author = data.get("author_name", "")
        if author:
            return f"{author}: {text}"
        return text
    except Exception:
        return None


def fetch_page_title(url: str) -> str | None:
    """Fetch the real title from a URL. Uses oembed for tweets, HTML scraping for everything else."""
    # Twitter/X: use oembed API (HTML scraping doesn't work — X blocks it)
    if re.search(r"(twitter\.com|x\.com)/\w+/status/", url):
        return _fetch_tweet_text(url)

    import requests as http_requests
    try:
        resp = http_requests.get(
            url,
            timeout=4,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            allow_redirects=True,
        )
        resp.raise_for_status()
        ctype = resp.headers.get("content-type", "")
        if "html" not in ctype:
            return None
        text = resp.text[:50_000]
        import html as html_mod

        # Try og:title first — usually the cleanest title
        og = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', text, re.IGNORECASE)
        if not og:
            og = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']', text, re.IGNORECASE)

        # Fall back to <title> tag
        title_m = re.search(r"<title[^>]*>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)

        raw = None
        if og:
            raw = html_mod.unescape(og.group(1)).strip()
        if (not raw or len(raw) < 4) and title_m:
            raw = html_mod.unescape(title_m.group(1)).strip()
        if not raw:
            return None

        # Clean platform suffixes
        raw = re.sub(r'\s*-\s*YouTube\s*$', '', raw)
        raw = re.sub(r'\s*[-|]\s*The New York Times\s*$', '', raw)
        raw = re.sub(r'\s*[-|]\s*WSJ\s*$', '', raw)
        raw = re.sub(r'\s*[-|]\s*Bloomberg\s*$', '', raw)
        raw = re.sub(r'\s*[-|]\s*Reuters\s*$', '', raw)
        raw = re.sub(r'\s*[-|]\s*TechCrunch\s*$', '', raw)

        # General: remove trailing " | SiteName"
        parts = raw.rsplit(' | ', 1)
        if len(parts) == 2 and len(parts[0]) > 10:
            raw = parts[0]

        return raw[:200] if raw else None
    except Exception:
        return None


# Canonical section order for the Bookmarks note
_BOOKMARK_SECTIONS = ["article", "video", "startup", "tool", "website", "other"]
_SECTION_LABELS = {
    "article": "Articles",
    "video": "Videos",
    "startup": "Startups",
    "tool": "Tools",
    "website": "Websites",
    "other": "Other",
}


def _parse_bookmark_sections(content: str) -> tuple[str, dict[str, list[str]]]:
    """Parse a bookmarks note into (header, {section: [lines]}).
    Returns the first non-section line as header."""
    lines = content.split("\n")
    header = ""
    sections: dict[str, list[str]] = {s: [] for s in _BOOKMARK_SECTIONS}
    current_section = None

    for line in lines:
        stripped = line.strip()
        # Detect section headers like "## Articles"
        if stripped.startswith("## "):
            label = stripped[3:].strip()
            for key, val in _SECTION_LABELS.items():
                if label.lower() == val.lower():
                    current_section = key
                    break
            continue
        if stripped.startswith("- [") and current_section:
            sections[current_section].append(line)
        elif stripped.startswith("- [") and not current_section:
            # Legacy flat entries — detect type from the entry
            for skey in _BOOKMARK_SECTIONS:
                if f"*{skey}*" in stripped.lower():
                    sections[skey].append(line)
                    break
            else:
                sections["other"].append(line)
        elif not any(sections[s] for s in _BOOKMARK_SECTIONS) and not current_section:
            # Header line (before any sections)
            if header:
                header += "\n" + line
            else:
                header = line
    return header.strip(), sections


def _render_bookmark_sections(header: str, sections: dict[str, list[str]]) -> str:
    """Render bookmarks back into organized markdown."""
    parts = [header] if header else ["Bookmarks — saved links, articles, videos, startups, websites:"]
    for skey in _BOOKMARK_SECTIONS:
        items = sections.get(skey, [])
        if items:
            parts.append(f"\n## {_SECTION_LABELS[skey]}")
            parts.extend(items)
    return "\n".join(parts)


async def append_bookmark_content(note_id: str, url: str, title: str, btype: str, desc: str, user_id: str = "") -> str:
    """Add or update a bookmark entry, organized by type. Returns updated content."""
    with get_cursor() as cur:
        cur.execute("SELECT content FROM notes WHERE id = %s AND user_id = %s", (note_id, user_id))
        row = cur.fetchone()
    if not row:
        return ""

    existing = row["content"]
    entry = f"- [{title}]({url}) — *{btype}* · {desc}"
    url_lower = url.lower().rstrip("/")

    # Parse into sections
    header, sections = _parse_bookmark_sections(existing)

    # Check for duplicates (same URL) across all sections — replace if found
    replaced = False
    for skey in _BOOKMARK_SECTIONS:
        new_items = []
        for item in sections[skey]:
            if url_lower and url_lower in item.lower():
                if not replaced:
                    new_items.append(entry)
                    replaced = True
                # skip the old entry
            else:
                new_items.append(item)
        sections[skey] = new_items

    # If not a replacement, add to the appropriate section
    if not replaced:
        section_key = btype if btype in _BOOKMARK_SECTIONS else "other"
        sections[section_key].append(entry)

    updated = _render_bookmark_sections(header, sections)

    embedding = await generate_embedding(updated)
    with get_cursor() as cur:
        cur.execute("""
            UPDATE notes SET content = %s, embedding = %s, updated = NOW()
            WHERE id = %s AND user_id = %s
        """, (updated, embedding, note_id, user_id))
    return updated


async def generate_answer(question: str, notes: list) -> str:
    """Generate a conversational answer based on found notes."""
    context = "\n\n---\n\n".join(
        f"**{n['title']}** ({n['category']})\n{n['content']}"
        for n in notes
    )
    response = await openai_client.chat.completions.create(
        model=AI_MODEL,
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


def _safe_category(name: str) -> str:
    """Sanitise a category name."""
    name = name.strip().lower()
    name = re.sub(r"[^a-z0-9_-]", "", name)
    if not name or name.startswith("."):
        name = "misc"
    return name


# ---------------------------------------------------------------------------
# Undo/redo helpers (DB-backed snapshots)
# ---------------------------------------------------------------------------

def _capture_note_snapshot(note_id: str, user_id: str = "") -> dict | None:
    """Capture current state of a note for undo/redo."""
    note = get_note_by_id_from_db(note_id, user_id)
    if not note:
        return None
    return {
        "note_id": note_id,
        "document": note["content"],
        "title": note["title"],
        "category": note["category"],
        "is_list": note["is_list"],
        "list_name": note["list_name"],
        "original_text": note["original_text"],
    }


async def _restore_snapshot(snap: dict, user_id: str = ""):
    """Restore a note to a previously captured snapshot state."""
    await save_note(
        note_id=snap["note_id"],
        category=snap["category"],
        title=snap["title"],
        content=snap["document"],
        original_text=snap.get("original_text", ""),
        is_list=snap.get("is_list", False),
        list_name=snap.get("list_name"),
        user_id=user_id,
    )


async def _do_undo(action: dict, user_id: str = "") -> dict | None:
    """Execute an undo action and return a redo entry (or None)."""
    atype = action["type"]

    if atype in ("note_created", "list_created"):
        note_id = action["note_id"]
        snap = _capture_note_snapshot(note_id, user_id)
        with get_cursor() as cur:
            cur.execute("DELETE FROM notes WHERE id = %s AND user_id = %s", (note_id, user_id))
        if snap:
            return {"redo_type": "recreate", "snapshot": snap, "original_action": action}
        return None

    elif atype in ("note_appended", "list_appended"):
        note_id = action["note_id"]
        prev_doc = action["previous_document"]
        prev_title = action.get("previous_title")
        snap = _capture_note_snapshot(note_id, user_id)
        note = get_note_by_id_from_db(note_id, user_id)
        if note:
            title = prev_title or note["title"]
            embedding = await generate_embedding(prev_doc)
            with get_cursor() as cur:
                cur.execute("""
                    UPDATE notes SET content = %s, title = %s, embedding = %s, updated = NOW()
                    WHERE id = %s AND user_id = %s
                """, (prev_doc, title, embedding, note_id, user_id))
        if snap:
            return {"redo_type": "restore", "snapshot": snap, "original_action": action}
        return None

    elif atype == "item_moved":
        src_snap = _capture_note_snapshot(action["source_id"], user_id)
        dest_snap = _capture_note_snapshot(action["dest_id"], user_id)
        src_emb = await generate_embedding(action["source_prev_doc"])
        with get_cursor() as cur:
            cur.execute("""
                UPDATE notes SET content = %s, embedding = %s, updated = NOW()
                WHERE id = %s AND user_id = %s
            """, (action["source_prev_doc"], src_emb, action["source_id"], user_id))
        dest_emb = await generate_embedding(action["dest_prev_doc"])
        with get_cursor() as cur:
            cur.execute("""
                UPDATE notes SET content = %s, embedding = %s, updated = NOW()
                WHERE id = %s AND user_id = %s
            """, (action["dest_prev_doc"], dest_emb, action["dest_id"], user_id))
        return {
            "redo_type": "restore_pair",
            "source_snapshot": src_snap, "dest_snapshot": dest_snap,
            "original_action": action,
        }

    elif atype == "item_moved_new_dest":
        src_snap = _capture_note_snapshot(action["source_id"], user_id)
        dest_snap = _capture_note_snapshot(action["dest_id"], user_id)
        src_emb = await generate_embedding(action["source_prev_doc"])
        with get_cursor() as cur:
            cur.execute("""
                UPDATE notes SET content = %s, embedding = %s, updated = NOW()
                WHERE id = %s AND user_id = %s
            """, (action["source_prev_doc"], src_emb, action["source_id"], user_id))
        with get_cursor() as cur:
            cur.execute("DELETE FROM notes WHERE id = %s AND user_id = %s", (action["dest_id"], user_id))
        return {
            "redo_type": "restore_and_recreate",
            "source_snapshot": src_snap, "dest_snapshot": dest_snap,
            "original_action": action,
        }

    return None


async def _do_redo(entry: dict, user_id: str = ""):
    """Execute a redo and push a corresponding undo entry."""
    rtype = entry["redo_type"]
    undo_stack = undo_stacks.setdefault(user_id, [])

    if rtype == "recreate":
        await _restore_snapshot(entry["snapshot"], user_id)
        undo_stack.append(entry["original_action"])

    elif rtype == "restore":
        current_snap = _capture_note_snapshot(entry["snapshot"]["note_id"], user_id)
        await _restore_snapshot(entry["snapshot"], user_id)
        undo_entry = dict(entry["original_action"])
        if current_snap:
            undo_entry["previous_document"] = current_snap["document"]
        undo_stack.append(undo_entry)

    elif rtype == "restore_pair":
        if entry.get("source_snapshot"):
            await _restore_snapshot(entry["source_snapshot"], user_id)
        if entry.get("dest_snapshot"):
            await _restore_snapshot(entry["dest_snapshot"], user_id)
        undo_stack.append(entry["original_action"])

    elif rtype == "restore_and_recreate":
        if entry.get("source_snapshot"):
            await _restore_snapshot(entry["source_snapshot"], user_id)
        if entry.get("dest_snapshot"):
            await _restore_snapshot(entry["dest_snapshot"], user_id)
        undo_stack.append(entry["original_action"])


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

class GoogleAuthRequest(BaseModel):
    credential: str


@app.post("/api/auth/google")
async def auth_google(req: GoogleAuthRequest):
    """Verify Google ID token, upsert user, return JWT."""
    if google_id_token is None:
        return JSONResponse(status_code=500, content={"error": f"google-auth not available: {_gauth_import_error}"})
    if not GOOGLE_CLIENT_ID:
        return JSONResponse(status_code=500, content={"error": "GOOGLE_CLIENT_ID not configured on server"})
    if not req.credential:
        return JSONResponse(status_code=400, content={"error": "No credential provided"})
    try:
        idinfo = google_id_token.verify_oauth2_token(
            req.credential, google_requests.Request(), GOOGLE_CLIENT_ID
        )
    except ValueError as e:
        return JSONResponse(status_code=401, content={"error": f"Token verification failed: {e}"})
    except Exception as e:
        return JSONResponse(status_code=401, content={"error": f"Authentication error: {type(e).__name__}: {e}"})

    google_id = idinfo["sub"]
    email = idinfo.get("email", "")
    name = idinfo.get("name", "")
    picture = idinfo.get("picture", "")

    # Upsert user
    with get_cursor() as cur:
        cur.execute("SELECT id FROM users WHERE google_id = %s", (google_id,))
        row = cur.fetchone()
        if row:
            user_id = row["id"]
            cur.execute("""
                UPDATE users SET email = %s, name = %s, picture = %s
                WHERE id = %s
            """, (email, name, picture, user_id))
        else:
            user_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO users (id, google_id, email, name, picture)
                VALUES (%s, %s, %s, %s, %s)
            """, (user_id, google_id, email, name, picture))
            _send_welcome_email(email, name)

    token = jwt.encode({
        "user_id": user_id,
        "email": email,
        "name": name,
        "picture": picture,
        "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRY_DAYS),
    }, JWT_SECRET, algorithm=JWT_ALGORITHM)

    return {"token": token, "user": {"name": name, "email": email, "picture": picture}}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    """Verify JWT and return user info."""
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("SELECT id, email, name, picture FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
    if not row:
        return _auth_error()
    return {"user": {"name": row["name"], "email": row["email"], "picture": row["picture"]}}


@app.get("/api/init")
async def app_init(request: Request):
    """Combined config + auth check in a single request (performance optimization)."""
    config = {"google_client_id": GOOGLE_CLIENT_ID}
    user = None
    try:
        user_id = get_current_user(request)
        with get_cursor() as cur:
            cur.execute("SELECT id, email, name, picture FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
        if row:
            user = {"name": row["name"], "email": row["email"], "picture": row["picture"]}
    except ValueError:
        pass
    return {"config": config, "user": user}


@app.get("/api/dashboard")
async def dashboard(request: Request):
    """Batch endpoint: returns all initial app data in one request."""
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    today = datetime.now().strftime("%Y-%m-%d")
    with get_cursor() as cur:
        # Recent notes
        cur.execute("""
            SELECT id, title, category, created FROM notes
            WHERE user_id = %s ORDER BY created DESC LIMIT 10
        """, (user_id,))
        recent = [{"id": r["id"], "title": r["title"], "category": r["category"],
                   "created": str(r["created"])} for r in cur.fetchall()]
        # Categories
        cur.execute("""
            SELECT category, COUNT(*) as count FROM notes
            WHERE user_id = %s GROUP BY category ORDER BY category
        """, (user_id,))
        categories = [{"name": r["category"], "count": r["count"]} for r in cur.fetchall()]
        # Tasks (uncompleted, default view)
        cur.execute("""
            SELECT * FROM tasks WHERE user_id = %s AND completed = FALSE
            ORDER BY priority, sort_order LIMIT 100
        """, (user_id,))
        tasks = []
        for r in cur.fetchall():
            t = dict(r)
            if isinstance(t.get("labels"), str):
                t["labels"] = json.loads(t["labels"])
            for k in ("created", "completed_at"):
                if t.get(k) is not None:
                    t[k] = str(t[k])
            tasks.append(t)
        # Task projects
        cur.execute("""
            SELECT project,
                   COUNT(*) FILTER (WHERE completed = FALSE) as count,
                   COUNT(*) FILTER (WHERE completed = TRUE) as completed
            FROM tasks WHERE user_id = %s GROUP BY project
        """, (user_id,))
        projects = [{"name": r["project"], "count": r["count"], "completed": r["completed"]}
                    for r in cur.fetchall()]
        # Events (current month)
        month = datetime.now().strftime("%Y-%m")
        cur.execute("""
            SELECT * FROM events WHERE user_id = %s AND date LIKE %s
            ORDER BY date, start_time
        """, (user_id, month + "%"))
        events = []
        for r in cur.fetchall():
            e = dict(r)
            if e.get("created") is not None:
                e["created"] = str(e["created"])
            events.append(e)
        # Preferences
        cur.execute("SELECT theme, onboarding_done FROM user_preferences WHERE user_id = %s", (user_id,))
        pref_row = cur.fetchone()
        prefs = {"theme": pref_row["theme"], "onboarding_done": pref_row["onboarding_done"]} if pref_row else {"theme": "dark", "onboarding_done": False}
        # Subscription
        cur.execute("SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = %s", (user_id,))
        sub_row = cur.fetchone()
        subscription = {"plan": sub_row["plan"] if sub_row else "free",
                        "status": sub_row["status"] if sub_row else "active",
                        "current_period_end": str(sub_row["current_period_end"]) if sub_row and sub_row["current_period_end"] else None}
    return {
        "recent": recent, "categories": categories, "tasks": tasks,
        "projects": projects, "events": events, "preferences": prefs,
        "subscription": subscription,
    }


# ---------------------------------------------------------------------------
# Email/Password Auth
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str


class LoginRequest(BaseModel):
    email: str
    password: str


def _hash_password(password: str) -> str:
    import bcrypt
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_password(password: str, hashed: str) -> bool:
    import bcrypt
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


@app.post("/api/auth/register")
async def auth_register(req: RegisterRequest):
    """Register a new user with email and password."""
    email = req.email.strip().lower()
    name = req.name.strip()
    password = req.password

    if not email or "@" not in email:
        return JSONResponse(status_code=400, content={"error": "Valid email is required"})
    if len(password) < 8:
        return JSONResponse(status_code=400, content={"error": "Password must be at least 8 characters"})
    if not name:
        return JSONResponse(status_code=400, content={"error": "Name is required"})

    # Check if email already exists
    with get_cursor() as cur:
        cur.execute("SELECT id, password_hash, google_id FROM users WHERE email = %s", (email,))
        existing = cur.fetchone()

    if existing:
        if existing["password_hash"]:
            return JSONResponse(status_code=409, content={"error": "An account with this email already exists. Please sign in."})
        # User exists via Google OAuth — add password to their account
        password_hash = _hash_password(password)
        with get_cursor() as cur:
            cur.execute("UPDATE users SET password_hash = %s, name = %s WHERE email = %s", (password_hash, name, email))
        user_id = existing["id"]
    else:
        user_id = str(uuid.uuid4())
        password_hash = _hash_password(password)
        with get_cursor() as cur:
            cur.execute("""
                INSERT INTO users (id, google_id, email, name, picture, password_hash)
                VALUES (%s, NULL, %s, %s, '', %s)
            """, (user_id, email, name, password_hash))
        _send_welcome_email(email, name)

    token = jwt.encode({
        "user_id": user_id,
        "email": email,
        "name": name,
        "picture": "",
        "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRY_DAYS),
    }, JWT_SECRET, algorithm=JWT_ALGORITHM)

    return {"token": token, "user": {"name": name, "email": email, "picture": ""}}


@app.post("/api/auth/login")
async def auth_login(req: LoginRequest):
    """Authenticate with email and password."""
    email = req.email.strip().lower()
    password = req.password

    if not email or not password:
        return JSONResponse(status_code=400, content={"error": "Email and password are required"})

    with get_cursor() as cur:
        cur.execute("SELECT id, email, name, picture, password_hash, google_id FROM users WHERE email = %s", (email,))
        user = cur.fetchone()

    if not user:
        return JSONResponse(status_code=401, content={"error": "Invalid email or password"})

    if not user["password_hash"]:
        # User only has Google auth — suggest they use Google sign-in or set a password
        return JSONResponse(status_code=401, content={"error": "This account uses Google Sign-In. Please sign in with Google, or register to set a password."})

    if not _verify_password(password, user["password_hash"]):
        return JSONResponse(status_code=401, content={"error": "Invalid email or password"})

    token = jwt.encode({
        "user_id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "picture": user["picture"] or "",
        "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRY_DAYS),
    }, JWT_SECRET, algorithm=JWT_ALGORITHM)

    return {"token": token, "user": {"name": user["name"], "email": user["email"], "picture": user["picture"] or ""}}


def get_recent_tasks(n: int = 30, user_id: str = "") -> str:
    """Get uncompleted tasks as context string for the AI."""
    with get_cursor() as cur:
        cur.execute("""
            SELECT id, title, due_date, due_time, priority, project FROM tasks
            WHERE user_id = %s AND completed = FALSE
            ORDER BY due_date ASC NULLS LAST, created DESC LIMIT %s
        """, (user_id, n))
        rows = cur.fetchall()
    if not rows:
        return "(none)"
    lines = []
    for r in rows:
        due = f" | Due: {r['due_date']}" if r['due_date'] else ""
        if r.get('due_time'):
            due += f" at {r['due_time']}"
        lines.append(f"- Title: {r['title']}{due} | Priority: {r['priority']} | Project: {r['project']}")
    return "\n".join(lines)


def get_upcoming_events(n: int = 15, user_id: str = "") -> str:
    """Get upcoming events as context string for the AI."""
    today = date_type.today().isoformat()
    with get_cursor() as cur:
        cur.execute("""
            SELECT id, title, date, start_time, end_time, all_day, location FROM events
            WHERE user_id = %s AND date >= %s
            ORDER BY date ASC, start_time ASC NULLS LAST LIMIT %s
        """, (user_id, today, n))
        rows = cur.fetchall()
    if not rows:
        return "(none)"
    lines = []
    for r in rows:
        time_str = "All day" if r['all_day'] else f"{r['start_time'] or '?'}-{r['end_time'] or '?'}"
        loc = f" @ {r['location']}" if r.get('location') else ""
        lines.append(f"- {r['title']} | {r['date']} {time_str}{loc}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/api/message")
async def handle_message(request: Request, body: MessageRequest):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()

    # Validate input BEFORE spending any resources
    if not body.message or not body.message.strip():
        return JSONResponse(status_code=400, content={"error": "Message cannot be empty."})

    if len(body.message) > 8000:
        return JSONResponse(
            status_code=400,
            content={"error": "Message too long (max 8000 characters)."},
        )

    # Check rate limit BEFORE calling OpenAI (saves API credits)
    email = _get_email_from_token(request)
    if email not in UNLIMITED_EMAILS:
        daily_limit = RATE_LIMIT_PRO if get_user_plan(user_id) == "pro" else RATE_LIMIT_FREE
        if not check_and_increment_rate_limit(user_id, limit=daily_limit):
            return JSONResponse(status_code=429, content={"error": f"Daily limit reached ({daily_limit}/day). Try again tomorrow."})

    # Run all DB reads in parallel (each opens its own connection)
    import asyncio, concurrent.futures
    _pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
    loop = asyncio.get_event_loop()
    recent_f = loop.run_in_executor(_pool, get_recent_notes, 5, user_id)
    tasks_f = loop.run_in_executor(_pool, get_recent_tasks, 10, user_id)
    events_f = loop.run_in_executor(_pool, get_upcoming_events, 7, user_id)
    history_f = loop.run_in_executor(_pool, _get_conversation_history, user_id)
    recent, recent_tasks, upcoming_events, history = await asyncio.gather(
        recent_f, tasks_f, events_f, history_f
    )

    today_str = datetime.now().strftime("%A, %B %d, %Y")
    prompt = SYSTEM_PROMPT.replace("{recent_notes}", recent).replace("{recent_tasks}", recent_tasks).replace("{upcoming_events}", upcoming_events).replace("{current_date}", today_str)
    messages = [{"role": "system", "content": prompt}]
    messages.extend(history)
    messages.append({"role": "user", "content": body.message})

    try:
        response = await openai_client.beta.chat.completions.parse(
            model=AI_MODEL,
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
    _add_to_history(user_id, "user", body.message)
    chat_resp = await _handle_intent(result, action_id, body.message, user_id)
    _add_to_history(user_id, "assistant", f"[{result.intent}] {chat_resp.message}")
    return chat_resp


async def _handle_intent(result: NoteResponse, action_id: str, original_message: str, user_id: str = "") -> ChatResponse:
    """Process a parsed intent and return the appropriate ChatResponse."""

    if result.intent == "add_note":
        note_id = str(uuid.uuid4())
        await save_note(
            note_id=note_id, category=result.category, title=result.title,
            content=result.polished_content, original_text=original_message,
            user_id=user_id,
        )
        _push_undo(user_id, {"id": action_id, "type": "note_created", "note_id": note_id})
        return ChatResponse(
            type="note_saved", message=result.summary,
            category=result.category, title=result.title,
            action_id=action_id, note_id=note_id,
        )

    elif result.intent == "append_to_note":
        target_id = result.target_note_id
        existing = get_note_by_id_from_db(target_id, user_id)
        if not existing:
            note_id = str(uuid.uuid4())
            cat = result.category or "personal"
            ttl = result.title or "Untitled"
            await save_note(note_id=note_id, category=cat, title=ttl,
                      content=result.append_content, original_text=original_message,
                      user_id=user_id)
            _push_undo(user_id, {"id": action_id, "type": "note_created", "note_id": note_id})
            return ChatResponse(
                type="note_saved", message=result.summary,
                category=cat, title=ttl,
                action_id=action_id, note_id=note_id,
            )

        prev_doc = existing["content"]
        await append_to_note_content(target_id, result.append_content, user_id)
        _push_undo(user_id, {"id": action_id, "type": "note_appended",
                     "note_id": target_id, "previous_document": prev_doc})
        return ChatResponse(
            type="note_updated", message=result.summary,
            category=existing["category"], title=existing["title"],
            action_id=action_id, note_id=target_id,
        )

    elif result.intent == "rewrite_note":
        target_id = result.target_note_id
        existing = get_note_by_id_from_db(target_id, user_id)
        if not existing:
            return ChatResponse(
                type="chat_response",
                message="I couldn't find that note to rewrite.",
            )

        prev_doc = existing["content"]
        new_content = result.rewrite_content
        embedding = await generate_embedding(new_content)
        with get_cursor() as cur:
            cur.execute("""
                UPDATE notes SET content = %s, embedding = %s, updated = NOW()
                WHERE id = %s AND user_id = %s
            """, (new_content, embedding, target_id, user_id))

        _push_undo(user_id, {"id": action_id, "type": "note_appended",
                     "note_id": target_id, "previous_document": prev_doc})
        return ChatResponse(
            type="note_rewritten", message=result.summary,
            category=existing["category"], title=existing["title"],
            action_id=action_id, note_id=target_id,
        )

    elif result.intent == "add_to_list":
        items = result.list_items or []
        existing = find_existing_list(result.list_name, user_id)

        if existing:
            prev_doc = existing["document"]
            await append_to_list_content(existing["id"], items, user_id)
            _push_undo(user_id, {"id": action_id, "type": "list_appended",
                         "note_id": existing["id"], "previous_document": prev_doc})
            return ChatResponse(
                type="list_updated", message=result.summary,
                category=existing["metadata"]["category"],
                title=existing["metadata"]["title"],
                items=items, action_id=action_id, note_id=existing["id"],
            )
        else:
            note_id = str(uuid.uuid4())
            display_name = result.list_name.replace("-", " ").title()
            content = "\n".join(f"- {item}" for item in items)
            await save_note(
                note_id=note_id, category=result.list_category, title=display_name,
                content=content, original_text=original_message,
                is_list=True, list_name=result.list_name, user_id=user_id,
            )
            _push_undo(user_id, {"id": action_id, "type": "list_created", "note_id": note_id})
            return ChatResponse(
                type="list_updated", message=result.summary,
                category=result.list_category, title=display_name,
                items=items, action_id=action_id, note_id=note_id,
            )

    elif result.intent == "remove_from_list":
        items = result.remove_items or []
        existing = find_existing_list(result.remove_list_name, user_id)

        if not existing:
            return ChatResponse(
                type="chat_response",
                message=f"I couldn't find a list matching \"{result.remove_list_name}\". Try checking your lists first!",
            )

        prev_doc = existing["document"]
        updated_content, actually_removed = await remove_from_list_content(existing["id"], items, user_id)

        if not actually_removed:
            return ChatResponse(
                type="chat_response",
                message=f"I couldn't find {', '.join(items)} in your {existing['metadata']['title']}.",
            )

        _push_undo(user_id, {"id": action_id, "type": "list_appended",
                     "note_id": existing["id"], "previous_document": prev_doc})
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

        source = find_note_by_name(result.move_source_name or "", user_id)

        # If source not found in notes, check if it's a task
        task_source = None
        if not source:
            source_name = (result.move_source_name or "").lower()
            with get_cursor() as cur:
                cur.execute("SELECT id, title, project FROM tasks WHERE user_id = %s AND completed = FALSE", (user_id,))
                task_rows = cur.fetchall()
            for trow in task_rows:
                if source_name in trow["title"].lower() or trow["title"].lower() in source_name:
                    task_source = trow
                    break
            if not task_source:
                # Word overlap
                source_words = set(source_name.split())
                for trow in task_rows:
                    trow_words = set(trow["title"].lower().split())
                    if len(source_words & trow_words) >= max(1, len(source_words) // 2):
                        task_source = trow
                        break

        if not source and not task_source:
            return ChatResponse(
                type="chat_response",
                message=f"I couldn't find a note, list, or task matching \"{result.move_source_name}\".",
            )

        # If source is a task, delete the task and add items to destination
        if task_source and not source:
            clean_items = items if items else [task_source["title"]]
            dest = find_note_by_name(result.move_dest_name or "", user_id)
            if dest:
                await append_to_list_content(dest["id"], clean_items, user_id)
            else:
                dest_slug = (result.move_dest_name or "misc").lower().replace(" ", "-")
                dest_display = dest_slug.replace("-", " ").title()
                dest_note_id = str(uuid.uuid4())
                dest_content = "\n".join(f"- {item}" for item in clean_items)
                await save_note(note_id=dest_note_id, category="personal", title=dest_display,
                          content=dest_content, original_text="", is_list=True,
                          list_name=dest_slug, user_id=user_id)
                dest = {"id": dest_note_id, "metadata": {"title": dest_display, "category": "personal"}}
            # Delete the task
            with get_cursor() as cur:
                cur.execute("DELETE FROM tasks WHERE id = %s AND user_id = %s", (task_source["id"], user_id))
            return ChatResponse(
                type="item_moved",
                message=result.summary or f"Moved {task_source['title']} to {dest['metadata']['title']}.",
                title=dest["metadata"]["title"], category=dest["metadata"].get("category", "personal"),
                items=clean_items, source_title=task_source["title"],
                action_id=action_id, note_id=dest["id"],
            )

        if not source:
            return ChatResponse(
                type="chat_response",
                message=f"I couldn't find a note or list matching \"{result.move_source_name}\".",
            )

        prev_source_doc = source["document"]
        updated_source, actually_removed = await remove_from_list_content(source["id"], items, user_id)

        if not actually_removed:
            return ChatResponse(
                type="chat_response",
                message=f"I couldn't find {', '.join(items)} in {source['metadata']['title']}.",
            )

        clean_items = []
        for item in actually_removed:
            m = re.match(r'\[([^\]]+)\]', item)
            if m:
                clean_items.append(m.group(1))
            else:
                clean_items.append(item)

        dest = find_note_by_name(result.move_dest_name or "", user_id)
        dest_created = False

        if dest:
            prev_dest_doc = dest["document"]
            await append_to_list_content(dest["id"], clean_items, user_id)
        else:
            dest_created = True
            dest_slug = (result.move_dest_name or "misc").lower().replace(" ", "-")
            dest_category = source["metadata"]["category"]
            dest_display = dest_slug.replace("-", " ").title()
            dest_note_id = str(uuid.uuid4())
            dest_content = "\n".join(f"- {item}" for item in clean_items)
            await save_note(
                note_id=dest_note_id, category=dest_category, title=dest_display,
                content=dest_content, original_text=original_message,
                is_list=True, list_name=dest_slug, user_id=user_id,
            )
            prev_dest_doc = ""
            dest = {
                "id": dest_note_id,
                "metadata": {
                    "title": dest_display,
                    "category": dest_category,
                },
            }

        undo_entry = {
            "id": action_id,
            "source_id": source["id"],
            "source_prev_doc": prev_source_doc,
            "dest_id": dest["id"],
            "dest_prev_doc": prev_dest_doc,
        }
        if dest_created:
            undo_entry["type"] = "item_moved_new_dest"
        else:
            undo_entry["type"] = "item_moved"
        _push_undo(user_id, undo_entry)

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
        ai_title = result.bookmark_title or "Untitled"
        btype = result.bookmark_type or "website"
        desc = result.bookmark_description or ""

        # Always use the real page title — never trust the AI-generated one
        title = ai_title
        if url:
            fetched = fetch_page_title(url)
            if fetched and len(fetched) > 3:
                title = fetched
            else:
                # fetch failed — try to extract a readable title from URL slug
                title = _title_from_url(url) or ai_title

        existing = find_existing_list("bookmarks", user_id)
        if existing:
            prev_doc = existing["document"]
            updated_content = await append_bookmark_content(existing["id"], url, title, btype, desc, user_id)
            _push_undo(user_id, {"id": action_id, "type": "list_appended",
                         "note_id": existing["id"], "previous_document": prev_doc})
            return ChatResponse(
                type="bookmark_saved", message=result.summary or f"Bookmarked {title}.",
                category="personal", title=title,
                action_id=action_id, note_id=existing["id"],
                bookmark_url=url, bookmark_type=btype,
            )
        else:
            note_id = str(uuid.uuid4())
            entry = f"- [{title}]({url}) — *{btype}* · {desc}"
            section_key = btype if btype in _BOOKMARK_SECTIONS else "other"
            header = "Bookmarks — saved links, articles, videos, startups, websites:"
            sections = {s: [] for s in _BOOKMARK_SECTIONS}
            sections[section_key].append(entry)
            content = _render_bookmark_sections(header, sections)
            await save_note(
                note_id=note_id, category="personal", title="Bookmarks",
                content=content, original_text=original_message,
                is_list=True, list_name="bookmarks", user_id=user_id,
            )
            _push_undo(user_id, {"id": action_id, "type": "list_created", "note_id": note_id})
            return ChatResponse(
                type="bookmark_saved", message=result.summary or f"Bookmarked {title}.",
                category="personal", title=title,
                action_id=action_id, note_id=note_id,
                bookmark_url=url, bookmark_type=btype,
            )

    elif result.intent == "add_task":
        title = result.task_title or "Untitled task"

        # Deduplicate: if an uncompleted task with the same title exists, update it
        existing_task_id = None
        with get_cursor() as cur:
            cur.execute(
                "SELECT id FROM tasks WHERE user_id = %s AND LOWER(title) = LOWER(%s) AND completed = FALSE LIMIT 1",
                (user_id, title),
            )
            row = cur.fetchone()
            if row:
                existing_task_id = row["id"]

        task_id = existing_task_id or str(uuid.uuid4())
        now = datetime.now().isoformat()
        task = {
            "id": task_id,
            "title": title,
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
        with get_cursor() as cur:
            if existing_task_id:
                cur.execute("""
                    UPDATE tasks SET title=%s, description=%s, due_date=%s, due_time=%s,
                        priority=%s, project=%s, labels=%s::jsonb
                    WHERE id=%s AND user_id=%s
                """, (task["title"], task["description"], task["due_date"],
                      task["due_time"], task["priority"], task["project"],
                      json.dumps(task["labels"]), existing_task_id, user_id))
            else:
                cur.execute("""
                    INSERT INTO tasks (id, user_id, title, description, due_date, due_time,
                                       priority, completed, project, labels, sort_order)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)
                """, (task["id"], user_id, task["title"], task["description"],
                      task["due_date"], task["due_time"], task["priority"],
                      task["completed"], task["project"],
                      json.dumps(task["labels"]), task["sort_order"]))
        return ChatResponse(
            type="task_created",
            message=result.summary or f"Added task: {task['title']}",
            title=task["title"], category=task["project"],
            action_id=action_id,
        )

    elif result.intent == "add_event":
        start = result.event_start_time
        end = result.event_end_time
        all_day = result.event_all_day if result.event_all_day is not None else (start is None)
        if start and not end:
            try:
                sh, sm = map(int, start.split(":"))
                eh, em = sh + 1, sm
                if eh >= 24:
                    eh, em = 23, 59
                end = f"{eh:02d}:{em:02d}"
            except Exception:
                end = None
        title = result.event_title or "Untitled event"
        event_date = result.event_date or datetime.now().strftime("%Y-%m-%d")

        # Deduplicate: if an event with the same title+date already exists, update it
        existing_event_id = None
        with get_cursor() as cur:
            cur.execute(
                "SELECT id FROM events WHERE user_id = %s AND LOWER(title) = LOWER(%s) AND date = %s LIMIT 1",
                (user_id, title, event_date),
            )
            row = cur.fetchone()
            if row:
                existing_event_id = row["id"]

        event_id = existing_event_id or str(uuid.uuid4())
        event = {
            "id": event_id,
            "title": title,
            "date": event_date,
            "end_date": result.event_end_date,
            "start_time": start,
            "end_time": end,
            "all_day": all_day,
            "location": result.event_location or "",
            "description": result.event_description or "",
            "color": result.event_color or "blue",
        }
        with get_cursor() as cur:
            if existing_event_id:
                cur.execute("""
                    UPDATE events SET title=%s, date=%s, end_date=%s, start_time=%s, end_time=%s,
                        all_day=%s, location=%s, description=%s, color=%s
                    WHERE id=%s AND user_id=%s
                """, (event["title"], event["date"], event["end_date"],
                      event["start_time"], event["end_time"], event["all_day"],
                      event["location"], event["description"], event["color"],
                      existing_event_id, user_id))
            else:
                cur.execute("""
                    INSERT INTO events (id, user_id, title, date, end_date, start_time, end_time,
                                        all_day, location, description, color)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """, (event["id"], user_id, event["title"], event["date"],
                      event["end_date"], event["start_time"], event["end_time"],
                      event["all_day"], event["location"], event["description"],
                      event["color"]))
        return ChatResponse(
            type="event_created",
            message=result.summary or f"Scheduled: {event['title']}",
            title=event["title"], category=event["color"],
            action_id=action_id,
        )

    elif result.intent == "delete_task":
        target_title = (result.delete_target_title or "").strip()
        if not target_title:
            return ChatResponse(type="chat_response", message="I need to know which task to delete. Can you be more specific?")
        # Fuzzy match against uncompleted tasks
        with get_cursor() as cur:
            cur.execute("SELECT id, title FROM tasks WHERE user_id = %s AND completed = FALSE", (user_id,))
            rows = cur.fetchall()
        match = None
        target_lower = target_title.lower()
        for row in rows:
            if target_lower == row["title"].lower():
                match = row
                break
            elif target_lower in row["title"].lower() or row["title"].lower() in target_lower:
                match = row
        if not match:
            # Try word overlap
            target_words = set(target_lower.split())
            for row in rows:
                row_words = set(row["title"].lower().split())
                if len(target_words & row_words) >= max(1, len(target_words) // 2):
                    match = row
                    break
        if not match:
            return ChatResponse(type="chat_response", message=f"I couldn't find a task matching \"{target_title}\".")
        with get_cursor() as cur:
            cur.execute("DELETE FROM tasks WHERE id = %s AND user_id = %s", (match["id"], user_id))
        return ChatResponse(
            type="task_deleted",
            message=result.summary or f"Deleted task: {match['title']}.",
            title=match["title"], action_id=action_id,
        )

    elif result.intent == "delete_event":
        target_title = (result.delete_target_title or "").strip()
        if not target_title:
            return ChatResponse(type="chat_response", message="I need to know which event to delete. Can you be more specific?")
        with get_cursor() as cur:
            cur.execute("SELECT id, title, date FROM events WHERE user_id = %s ORDER BY date DESC LIMIT 50", (user_id,))
            rows = cur.fetchall()
        match = None
        target_lower = target_title.lower()
        for row in rows:
            if target_lower == row["title"].lower():
                match = row
                break
            elif target_lower in row["title"].lower() or row["title"].lower() in target_lower:
                match = row
        if not match:
            target_words = set(target_lower.split())
            for row in rows:
                row_words = set(row["title"].lower().split())
                if len(target_words & row_words) >= max(1, len(target_words) // 2):
                    match = row
                    break
        if not match:
            return ChatResponse(type="chat_response", message=f"I couldn't find an event matching \"{target_title}\".")
        with get_cursor() as cur:
            cur.execute("DELETE FROM events WHERE id = %s AND user_id = %s", (match["id"], user_id))
        return ChatResponse(
            type="event_deleted",
            message=result.summary or f"Deleted event: {match['title']}.",
            title=match["title"], action_id=action_id,
        )

    elif result.intent == "search":
        notes = await search_notes(result.search_query, user_id=user_id)
        if not notes:
            notes = await search_notes(result.search_query, max_distance=0.80, user_id=user_id)
        if not notes:
            return ChatResponse(
                type="search_results",
                message="I couldn't find any notes related to that. Try adding some first!",
                results=[],
            )
        answer = await generate_answer(original_message, notes)
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

    return ChatResponse(
        type="chat_response",
        message="I wasn't sure how to handle that. Could you rephrase?",
    )


# ---------------------------------------------------------------------------
# Chat history (cross-device sync)
# ---------------------------------------------------------------------------

@app.get("/api/chat/history")
async def get_chat_history(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("SELECT messages FROM chat_history WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    return {"messages": row["messages"] if row else []}


class ChatHistoryRequest(BaseModel):
    messages: list[dict]


@app.put("/api/chat/history")
async def save_chat_history(request: Request, body: ChatHistoryRequest):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    msgs = body.messages[-500:]
    with get_cursor() as cur:
        cur.execute("""
            INSERT INTO chat_history (user_id, messages, updated) VALUES (%s, %s, NOW())
            ON CONFLICT (user_id) DO UPDATE SET messages = %s, updated = NOW()
        """, (user_id, json.dumps(msgs), json.dumps(msgs)))
    return {"ok": True}


@app.delete("/api/chat/history")
async def clear_chat_history(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("DELETE FROM chat_history WHERE user_id = %s", (user_id,))
        cur.execute("DELETE FROM conversation_context WHERE user_id = %s", (user_id,))
    return {"ok": True}


# ---------------------------------------------------------------------------
# User preferences (synced across devices)
# ---------------------------------------------------------------------------

@app.get("/api/preferences")
async def get_preferences(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("SELECT theme, onboarding_done FROM user_preferences WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    if row:
        return {"theme": row["theme"], "onboarding_done": row["onboarding_done"]}
    return {"theme": "dark", "onboarding_done": False}


class PreferencesRequest(BaseModel):
    theme: Optional[str] = None
    onboarding_done: Optional[bool] = None


@app.put("/api/preferences")
async def save_preferences(request: Request, body: PreferencesRequest):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("SELECT user_id FROM user_preferences WHERE user_id = %s", (user_id,))
        exists = cur.fetchone()
        if exists:
            updates = []
            params = []
            if body.theme is not None:
                updates.append("theme = %s")
                params.append(body.theme)
            if body.onboarding_done is not None:
                updates.append("onboarding_done = %s")
                params.append(body.onboarding_done)
            if updates:
                updates.append("updated = NOW()")
                params.append(user_id)
                cur.execute(f"UPDATE user_preferences SET {', '.join(updates)} WHERE user_id = %s", params)
        else:
            cur.execute("""
                INSERT INTO user_preferences (user_id, theme, onboarding_done)
                VALUES (%s, %s, %s)
            """, (user_id, body.theme or "dark", body.onboarding_done or False))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    try:
        with get_cursor() as cur:
            cur.execute("SELECT COUNT(*) as cnt FROM notes")
            cnt = cur.fetchone()["cnt"]
        return {"status": "ok", "notes_count": cnt}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/config")
async def get_config():
    """Return public config (Google Client ID for frontend)."""
    return {"google_client_id": GOOGLE_CLIENT_ID}


class FeedbackRequest(BaseModel):
    message: str

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
FEEDBACK_EMAIL = os.environ.get("FEEDBACK_EMAIL", "jra131@georgetown.edu")

@app.post("/api/feedback")
async def submit_feedback(req: FeedbackRequest, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    if not req.message.strip():
        return JSONResponse(status_code=400, content={"error": "Feedback message is empty"})

    # Get user email
    with get_cursor() as cur:
        cur.execute("SELECT email FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
    user_email = row["email"] if row else "unknown"

    # Store in DB
    feedback_id = str(uuid.uuid4())
    with get_cursor() as cur:
        cur.execute(
            "INSERT INTO feedback (id, user_id, user_email, message) VALUES (%s, %s, %s, %s)",
            (feedback_id, user_id, user_email, req.message.strip()),
        )

    # Send email via Resend (best-effort)
    if RESEND_API_KEY:
        try:
            import requests as http_requests
            http_requests.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
                json={
                    "from": "Memoir <onboarding@resend.dev>",
                    "to": FEEDBACK_EMAIL,
                    "subject": f"Memoir Feedback from {user_email}",
                    "text": f"From: {user_email}\n\n{req.message.strip()}",
                },
                timeout=5,
            )
        except Exception:
            pass  # Email is best-effort; feedback is already saved in DB

    return {"ok": True, "message": "Thank you for your feedback!"}


@app.delete("/api/account")
async def delete_account(request: Request):
    """Permanently delete user account and all associated data."""
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        for table in ("notes", "tasks", "events", "feedback", "rate_limits", "chat_history", "conversation_context", "user_preferences", "subscriptions"):
            cur.execute(f"DELETE FROM {table} WHERE user_id = %s", (user_id,))
        cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Welcome email (Resend, best-effort)
# ---------------------------------------------------------------------------

def _send_welcome_email(email: str, name: str):
    """Send a welcome email via Resend (best-effort, non-blocking)."""
    if not RESEND_API_KEY:
        return
    try:
        import requests as http_requests
        http_requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            json={
                "from": "Memoir <onboarding@resend.dev>",
                "to": email,
                "subject": "Welcome to Memoir!",
                "html": (
                    f"<h2>Welcome to Memoir, {name}!</h2>"
                    "<p>Your AI-powered second brain is ready. Here's what you can do:</p>"
                    "<ul>"
                    "<li><strong>Save notes</strong> — Just type anything to save it</li>"
                    "<li><strong>Create tasks</strong> — \"Remind me to call mom tomorrow\"</li>"
                    "<li><strong>Add events</strong> — \"Meeting with Alex on Friday at 2pm\"</li>"
                    "<li><strong>Ask questions</strong> — \"What did I note about...?\"</li>"
                    "</ul>"
                    "<p>Start by visiting <a href='https://getmemoir.vercel.app/app'>Memoir</a></p>"
                ),
            },
            timeout=5,
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Stripe Subscriptions (optional — no-op if keys not set)
# ---------------------------------------------------------------------------
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID = os.environ.get("STRIPE_PRICE_ID", "")

_stripe = None
if STRIPE_SECRET_KEY:
    try:
        import stripe as _stripe_mod
        _stripe_mod.api_key = STRIPE_SECRET_KEY
        _stripe = _stripe_mod
    except ImportError:
        pass


@app.get("/api/subscription")
async def get_subscription(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    plan = get_user_plan(user_id)
    with get_cursor() as cur:
        cur.execute("SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    if row:
        return {"plan": plan, "status": row["status"],
                "current_period_end": str(row["current_period_end"]) if row["current_period_end"] else None}
    return {"plan": "free", "status": "active", "current_period_end": None}


@app.post("/api/stripe/create-checkout")
async def create_checkout(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    if not _stripe or not STRIPE_PRICE_ID:
        return JSONResponse(status_code=503, content={"error": "Payments not configured yet."})

    # Get or create Stripe customer
    with get_cursor() as cur:
        cur.execute("SELECT stripe_customer_id FROM subscriptions WHERE user_id = %s", (user_id,))
        row = cur.fetchone()

    customer_id = row["stripe_customer_id"] if row and row.get("stripe_customer_id") else None

    if not customer_id:
        with get_cursor() as cur:
            cur.execute("SELECT email FROM users WHERE id = %s", (user_id,))
            user = cur.fetchone()
        customer = _stripe.Customer.create(email=user["email"], metadata={"user_id": user_id})
        customer_id = customer.id
        with get_cursor() as cur:
            cur.execute("""
                INSERT INTO subscriptions (user_id, stripe_customer_id) VALUES (%s, %s)
                ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = %s, updated = NOW()
            """, (user_id, customer_id, customer_id))

    origin = request.headers.get("origin", "https://getmemoir.vercel.app")
    session = _stripe.checkout.Session.create(
        customer=customer_id,
        payment_method_types=["card"],
        line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
        mode="subscription",
        success_url=origin + "/app?upgraded=true",
        cancel_url=origin + "/app",
        metadata={"user_id": user_id},
    )
    return {"url": session.url}


@app.post("/api/stripe/webhook")
async def stripe_webhook(request: Request):
    if not _stripe or not STRIPE_WEBHOOK_SECRET:
        return JSONResponse(status_code=503, content={"error": "Not configured"})
    body = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = _stripe.Webhook.construct_event(body, sig, STRIPE_WEBHOOK_SECRET)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid signature"})

    data = event["data"]["object"]

    if event["type"] in ("customer.subscription.created", "customer.subscription.updated"):
        customer_id = data["customer"]
        status = data["status"]
        period_end = datetime.utcfromtimestamp(data["current_period_end"])
        sub_id = data["id"]
        plan = "pro" if status == "active" else "free"
        with get_cursor() as cur:
            cur.execute("""
                UPDATE subscriptions
                SET plan = %s, stripe_subscription_id = %s, status = %s,
                    current_period_end = %s, updated = NOW()
                WHERE stripe_customer_id = %s
            """, (plan, sub_id, status, period_end, customer_id))

    elif event["type"] == "customer.subscription.deleted":
        customer_id = data["customer"]
        with get_cursor() as cur:
            cur.execute("""
                UPDATE subscriptions SET plan = 'free', status = 'canceled', updated = NOW()
                WHERE stripe_customer_id = %s
            """, (customer_id,))

    return {"ok": True}


# ---------------------------------------------------------------------------
# Data export
# ---------------------------------------------------------------------------

def _serialize_row(row: dict) -> dict:
    """Convert a DB row to a JSON-safe dict."""
    d = dict(row)
    for k, v in d.items():
        if hasattr(v, 'isoformat'):
            d[k] = str(v)
    return d


@app.get("/api/export")
async def export_data(request: Request):
    """Export all user data as JSON."""
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()

    with get_cursor() as cur:
        cur.execute("SELECT id, title, category, content, original_text, is_list, list_name, created, updated FROM notes WHERE user_id = %s ORDER BY created DESC", (user_id,))
        notes = [_serialize_row(r) for r in cur.fetchall()]

        cur.execute("SELECT id, title, description, due_date, due_time, priority, completed, completed_at, project, labels, created FROM tasks WHERE user_id = %s ORDER BY created DESC", (user_id,))
        tasks = [_serialize_row(r) for r in cur.fetchall()]

        cur.execute("SELECT id, title, date, end_date, start_time, end_time, all_day, location, description, color, created FROM events WHERE user_id = %s ORDER BY date DESC", (user_id,))
        events = [_serialize_row(r) for r in cur.fetchall()]

        cur.execute("SELECT messages FROM chat_history WHERE user_id = %s", (user_id,))
        chat_row = cur.fetchone()
        chat_history = chat_row["messages"] if chat_row else []

        cur.execute("SELECT theme, onboarding_done FROM user_preferences WHERE user_id = %s", (user_id,))
        pref_row = cur.fetchone()
        preferences = dict(pref_row) if pref_row else {}

    export = {
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "notes": notes,
        "tasks": tasks,
        "events": events,
        "chat_history": chat_history,
        "preferences": preferences,
    }
    return JSONResponse(content=export, headers={
        "Content-Disposition": "attachment; filename=memoir-export.json"
    })


# ---------------------------------------------------------------------------
# Notes CRUD
# ---------------------------------------------------------------------------

@app.get("/api/categories")
async def list_categories(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("""
            SELECT category, COUNT(*) as count FROM notes
            WHERE user_id = %s
            GROUP BY category ORDER BY category
        """, (user_id,))
        categories = [{"name": r["category"], "count": r["count"]} for r in cur.fetchall()]
    return {"categories": categories}


@app.get("/api/notes/{category}")
async def list_notes_in_category(category: str, request: Request, limit: int = 50, offset: int = 0):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    category = _safe_category(category)
    limit = min(max(limit, 1), 200)
    with get_cursor() as cur:
        cur.execute("""
            SELECT id, title, category, content, original_text, created
            FROM notes WHERE category = %s AND user_id = %s ORDER BY created DESC
            LIMIT %s OFFSET %s
        """, (category, user_id, limit, offset))
        notes = []
        for r in cur.fetchall():
            notes.append({
                "id": r["id"],
                "title": r["title"],
                "category": r["category"],
                "content": r["content"],
                "original_text": r["original_text"],
                "created": str(r["created"]),
            })
    return {"notes": notes}


@app.get("/api/note/{note_id}")
async def get_note_endpoint(note_id: str, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    note = get_note_by_id_from_db(note_id, user_id)
    if not note:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return {
        "id": note["id"],
        "title": note["title"],
        "category": note["category"],
        "content": note["content"],
        "created": str(note["created"]),
        "is_list": note["is_list"],
        "original_text": note["original_text"],
    }


@app.put("/api/note/{note_id}")
async def edit_note(note_id: str, req: EditNoteRequest, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    note = get_note_by_id_from_db(note_id, user_id)
    if not note:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    new_title = req.title or note["title"]
    new_content = req.content if req.content is not None else note["content"]

    _push_undo(user_id, {
        "id": str(uuid.uuid4()),
        "type": "note_appended",
        "note_id": note_id,
        "previous_document": note["content"],
        "previous_title": note["title"],
    })

    embedding = await generate_embedding(new_content)
    with get_cursor() as cur:
        cur.execute("""
            UPDATE notes SET title = %s, content = %s, embedding = %s, updated = NOW()
            WHERE id = %s AND user_id = %s
        """, (new_title, new_content, embedding, note_id, user_id))
    return {"ok": True}


@app.post("/api/note/{note_id}/ai")
async def ai_transform_note(note_id: str, req: NoteAIRequest, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()

    email = _get_email_from_token(request)
    if email not in UNLIMITED_EMAILS:
        daily_limit = RATE_LIMIT_PRO if get_user_plan(user_id) == "pro" else RATE_LIMIT_FREE
        if not check_and_increment_rate_limit(user_id, limit=daily_limit):
            return JSONResponse(status_code=429, content={"error": f"Daily limit reached ({daily_limit}/day). Try again tomorrow."})

    note = get_note_by_id_from_db(note_id, user_id)
    if not note:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    content = note["content"]
    _push_undo(user_id, {
        "id": str(uuid.uuid4()),
        "type": "note_appended",
        "note_id": note_id,
        "previous_document": content,
    })

    response = await openai_client.chat.completions.create(
        model=AI_MODEL,
        max_tokens=2048,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": (
                "You are an AI assistant helping edit a note. Decide whether the user's instruction "
                "wants to ADD new content below the existing note, or MODIFY/REPLACE the existing content.\n\n"
                "APPEND (action=append) when the user wants to:\n"
                "- Create, generate, draft, write, add, build, plan, list, brainstorm something NEW\n"
                "- Examples: 'create a roadmap', 'add a packing list', 'write a summary below', "
                "'generate talking points', 'add next steps'\n\n"
                "REPLACE (action=replace) when the user wants to:\n"
                "- Reorganize, sort, clean up, reformat, rewrite, improve, enhance, fix the EXISTING content\n"
                "- Examples: 'organize this', 'sort alphabetically', 'clean up', 'add authors to each item', "
                "'rewrite this', 'fix grammar'\n\n"
                "Return JSON with exactly these fields:\n"
                "- action: 'append' or 'replace'\n"
                "- content: the markdown content (if append: ONLY the new section to add, no preamble; "
                "if replace: the full rewritten note content)\n\n"
                "Rules:\n"
                "- Do NOT start content with a heading that repeats the note title.\n"
                "- For append: start directly with the new content (use a ## heading to label the section if appropriate).\n"
                "- For replace: include ALL original items, do NOT create duplicates.\n"
                "- Never wrap in code blocks.\n"
                "- Never add explanation outside the JSON."
            )},
            {"role": "user", "content": (
                f"Note title: {note['title']}\n\n"
                f"Current content:\n{content}\n\n"
                f"Instruction: {req.prompt}"
            )},
        ],
    )
    import json as _json
    result_json = _json.loads(response.choices[0].message.content)
    action = result_json.get("action", "replace")
    ai_content = result_json.get("content", "").strip()

    if action == "append":
        new_content = content.rstrip() + "\n\n" + ai_content
    else:
        new_content = ai_content

    embedding = await generate_embedding(new_content)
    with get_cursor() as cur:
        cur.execute("""
            UPDATE notes SET content = %s, embedding = %s, updated = NOW()
            WHERE id = %s AND user_id = %s
        """, (new_content, embedding, note_id, user_id))
    return {"ok": True, "content": new_content, "action": action}


@app.delete("/api/note/{note_id}")
async def delete_note(note_id: str, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("DELETE FROM notes WHERE id = %s AND user_id = %s RETURNING id", (note_id, user_id))
        if not cur.fetchone():
            return JSONResponse(status_code=404, content={"error": "Not found"})
    return {"ok": True}


@app.patch("/api/note/{note_id}/move")
async def move_note(note_id: str, req: MoveNoteRequest, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    new_cat = _safe_category(req.new_category)
    with get_cursor() as cur:
        cur.execute("""
            UPDATE notes SET category = %s, updated = NOW()
            WHERE id = %s AND user_id = %s RETURNING id
        """, (new_cat, note_id, user_id))
        if not cur.fetchone():
            return JSONResponse(status_code=404, content={"error": "Not found"})
    return {"ok": True, "new_category": new_cat}


@app.delete("/api/category/{name}")
async def delete_category(name: str, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    name = _safe_category(name)
    with get_cursor() as cur:
        cur.execute("DELETE FROM notes WHERE category = %s AND user_id = %s", (name, user_id))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Undo / Redo
# ---------------------------------------------------------------------------

@app.post("/api/undo/{action_id}")
async def undo_action(action_id: str, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    undo_stack = undo_stacks.setdefault(user_id, [])
    redo_stack = redo_stacks.setdefault(user_id, [])
    action = None
    for i, a in enumerate(undo_stack):
        if a["id"] == action_id:
            action = undo_stack.pop(i)
            break
    if not action:
        return JSONResponse(status_code=404,
                            content={"error": "Action expired or already undone"})
    redo_entry = await _do_undo(action, user_id)
    if redo_entry:
        redo_stack.append(redo_entry)
    return {"ok": True, "undone": action["type"],
            "can_undo": len(undo_stack) > 0, "can_redo": len(redo_stack) > 0}


@app.post("/api/undo")
async def undo_last(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    undo_stack = undo_stacks.setdefault(user_id, [])
    redo_stack = redo_stacks.setdefault(user_id, [])
    if not undo_stack:
        return JSONResponse(status_code=404, content={"error": "Nothing to undo"})
    action = undo_stack.pop()
    redo_entry = await _do_undo(action, user_id)
    if redo_entry:
        redo_stack.append(redo_entry)
    return {"ok": True, "undone": action["type"],
            "can_undo": len(undo_stack) > 0, "can_redo": len(redo_stack) > 0}


@app.post("/api/redo")
async def redo_last(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    undo_stack = undo_stacks.setdefault(user_id, [])
    redo_stack = redo_stacks.setdefault(user_id, [])
    if not redo_stack:
        return JSONResponse(status_code=404, content={"error": "Nothing to redo"})
    entry = redo_stack.pop()
    await _do_redo(entry, user_id)
    return {"ok": True, "can_undo": len(undo_stack) > 0, "can_redo": len(redo_stack) > 0}


@app.get("/api/undo-status")
async def undo_status(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    undo_stack = undo_stacks.setdefault(user_id, [])
    redo_stack = redo_stacks.setdefault(user_id, [])
    return {"can_undo": len(undo_stack) > 0, "can_redo": len(redo_stack) > 0}


# ---------------------------------------------------------------------------
# Recent notes
# ---------------------------------------------------------------------------

@app.get("/api/recent")
async def get_recent(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("""
            SELECT id, title, category, created FROM notes
            WHERE user_id = %s
            ORDER BY created DESC LIMIT 10
        """, (user_id,))
        recent = []
        for r in cur.fetchall():
            recent.append({
                "id": r["id"],
                "title": r["title"],
                "category": r["category"],
                "created": str(r["created"]),
            })
    return {"recent": recent}


# ---------------------------------------------------------------------------
# Task CRUD
# ---------------------------------------------------------------------------

@app.get("/api/tasks")
async def get_tasks(request: Request, project: str | None = None, view: str | None = None, limit: int = 100, offset: int = 0):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    limit = min(max(limit, 1), 500)
    today = datetime.now().strftime("%Y-%m-%d")
    with get_cursor() as cur:
        if view == "today":
            cur.execute("""
                SELECT * FROM tasks
                WHERE user_id = %s AND completed = FALSE AND due_date = %s
                ORDER BY priority, sort_order LIMIT %s OFFSET %s
            """, (user_id, today, limit, offset))
        elif view == "upcoming":
            cur.execute("""
                SELECT * FROM tasks
                WHERE user_id = %s AND completed = FALSE AND due_date IS NOT NULL AND due_date >= %s
                ORDER BY due_date, priority LIMIT %s OFFSET %s
            """, (user_id, today, limit, offset))
        elif view == "overdue":
            cur.execute("""
                SELECT * FROM tasks
                WHERE user_id = %s AND completed = FALSE AND due_date IS NOT NULL AND due_date < %s
                ORDER BY due_date, priority LIMIT %s OFFSET %s
            """, (user_id, today, limit, offset))
        elif view == "completed":
            cur.execute("SELECT * FROM tasks WHERE user_id = %s AND completed = TRUE ORDER BY completed_at DESC LIMIT %s OFFSET %s", (user_id, limit, offset))
        elif project:
            cur.execute("""
                SELECT * FROM tasks
                WHERE user_id = %s AND completed = FALSE AND project = %s
                ORDER BY priority, sort_order LIMIT %s OFFSET %s
            """, (user_id, project, limit, offset))
        else:
            cur.execute("SELECT * FROM tasks WHERE user_id = %s AND completed = FALSE ORDER BY priority, sort_order LIMIT %s OFFSET %s", (user_id, limit, offset))

        tasks = []
        for r in cur.fetchall():
            t = dict(r)
            if isinstance(t.get("labels"), str):
                t["labels"] = json.loads(t["labels"])
            for k in ("created", "completed_at"):
                if t.get(k) is not None:
                    t[k] = str(t[k])
            tasks.append(t)
    return {"tasks": tasks}


@app.get("/api/tasks/projects")
async def get_task_projects(request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("""
            SELECT project,
                   COUNT(*) FILTER (WHERE completed = FALSE) as count,
                   COUNT(*) FILTER (WHERE completed = TRUE) as completed
            FROM tasks WHERE user_id = %s GROUP BY project
        """, (user_id,))
        projects = [{"name": r["project"], "count": r["count"], "completed": r["completed"]}
                    for r in cur.fetchall()]
    return {"projects": projects}


@app.post("/api/tasks")
async def create_task(req: TaskCreateRequest, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    task_id = str(uuid.uuid4())
    with get_cursor() as cur:
        cur.execute("""
            INSERT INTO tasks (id, user_id, title, description, due_date, due_time,
                               priority, completed, project, labels, sort_order)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)
            RETURNING *
        """, (task_id, user_id, req.title, req.description, req.due_date, req.due_time,
              req.priority, False, req.project, json.dumps(req.labels), 0))
        task = dict(cur.fetchone())
    for k in ("created", "completed_at"):
        if task.get(k) is not None:
            task[k] = str(task[k])
    if isinstance(task.get("labels"), str):
        task["labels"] = json.loads(task["labels"])
    return {"ok": True, "task": task}


@app.put("/api/tasks/{task_id}")
async def update_task(task_id: str, req: TaskUpdateRequest, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    sets = []
    vals = []
    if req.title is not None:
        sets.append("title = %s"); vals.append(req.title)
    if req.description is not None:
        sets.append("description = %s"); vals.append(req.description)
    if req.due_date is not None:
        sets.append("due_date = %s"); vals.append(req.due_date if req.due_date != "" else None)
    if req.due_time is not None:
        sets.append("due_time = %s"); vals.append(req.due_time if req.due_time != "" else None)
    if req.priority is not None:
        sets.append("priority = %s"); vals.append(req.priority)
    if req.completed is not None:
        sets.append("completed = %s"); vals.append(req.completed)
        sets.append("completed_at = %s"); vals.append(datetime.now().isoformat() if req.completed else None)
    if req.project is not None:
        sets.append("project = %s"); vals.append(req.project)
    if req.labels is not None:
        sets.append("labels = %s::jsonb"); vals.append(json.dumps(req.labels))
    if req.sort_order is not None:
        sets.append("sort_order = %s"); vals.append(req.sort_order)

    if not sets:
        return JSONResponse(status_code=400, content={"error": "No fields to update"})

    vals.extend([task_id, user_id])
    with get_cursor() as cur:
        cur.execute(f"""
            UPDATE tasks SET {', '.join(sets)}
            WHERE id = %s AND user_id = %s RETURNING *
        """, vals)
        row = cur.fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "Task not found"})
    task = dict(row)
    for k in ("created", "completed_at"):
        if task.get(k) is not None:
            task[k] = str(task[k])
    if isinstance(task.get("labels"), str):
        task["labels"] = json.loads(task["labels"])
    return {"ok": True, "task": task}


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("DELETE FROM tasks WHERE id = %s AND user_id = %s", (task_id, user_id))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Event CRUD
# ---------------------------------------------------------------------------

@app.get("/api/events")
async def get_events(request: Request, month: str | None = None, date: str | None = None):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        if date:
            cur.execute("SELECT * FROM events WHERE user_id = %s AND date = %s ORDER BY start_time", (user_id, date))
        elif month:
            cur.execute("SELECT * FROM events WHERE user_id = %s AND date LIKE %s ORDER BY date, start_time",
                        (user_id, month + "%"))
        else:
            cur.execute("SELECT * FROM events WHERE user_id = %s ORDER BY date, start_time LIMIT 200", (user_id,))
        events = []
        for r in cur.fetchall():
            e = dict(r)
            if e.get("created") is not None:
                e["created"] = str(e["created"])
            events.append(e)
    return {"events": events}


@app.post("/api/events")
async def create_event(req: EventCreateRequest, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
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
    with get_cursor() as cur:
        cur.execute("""
            INSERT INTO events (id, user_id, title, date, end_date, start_time, end_time,
                                all_day, location, description, color)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
        """, (event_id, user_id, req.title, req.date, req.end_date, start, end,
              req.all_day, req.location, req.description, req.color))
        event = dict(cur.fetchone())
    if event.get("created") is not None:
        event["created"] = str(event["created"])
    return {"ok": True, "event": event}


@app.put("/api/events/{event_id}")
async def update_event(event_id: str, req: EventUpdateRequest, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    sets = []
    vals = []
    if req.title is not None:
        sets.append("title = %s"); vals.append(req.title)
    if req.date is not None:
        sets.append("date = %s"); vals.append(req.date)
    if req.end_date is not None:
        sets.append("end_date = %s"); vals.append(req.end_date)
    if req.start_time is not None:
        sets.append("start_time = %s"); vals.append(req.start_time)
    if req.end_time is not None:
        sets.append("end_time = %s"); vals.append(req.end_time)
    if req.all_day is not None:
        sets.append("all_day = %s"); vals.append(req.all_day)
    if req.location is not None:
        sets.append("location = %s"); vals.append(req.location)
    if req.description is not None:
        sets.append("description = %s"); vals.append(req.description)
    if req.color is not None:
        sets.append("color = %s"); vals.append(req.color)

    if not sets:
        return JSONResponse(status_code=400, content={"error": "No fields to update"})

    vals.extend([event_id, user_id])
    with get_cursor() as cur:
        cur.execute(f"""
            UPDATE events SET {', '.join(sets)}
            WHERE id = %s AND user_id = %s RETURNING *
        """, vals)
        row = cur.fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "Event not found"})
    event = dict(row)
    if event.get("created") is not None:
        event["created"] = str(event["created"])
    return {"ok": True, "event": event}


@app.delete("/api/events/{event_id}")
async def delete_event(event_id: str, request: Request):
    try:
        user_id = get_current_user(request)
    except ValueError:
        return _auth_error()
    with get_cursor() as cur:
        cur.execute("DELETE FROM events WHERE id = %s AND user_id = %s", (event_id, user_id))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Migration endpoint (temporary — remove after migrating data)
# ---------------------------------------------------------------------------

