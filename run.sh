#!/bin/bash
export OPENAI_API_KEY="your-key-here"
cd "$(dirname "$0")" && python3 -m uvicorn app:app --reload --port 8000
