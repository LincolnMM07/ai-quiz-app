"""
AI Quiz App — FastAPI Backend
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import quiz, sources, audio, lyrics
from app.core.config import settings
from app.core.database import init_db

app = FastAPI(
    title="AI Quiz App API",
    description="AI-powered quiz generation from any subject material",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(quiz.router,    prefix="/api/quiz",    tags=["quiz"])
app.include_router(sources.router, prefix="/api/sources", tags=["sources"])
app.include_router(audio.router,   prefix="/api/audio",   tags=["audio"])
app.include_router(lyrics.router,  prefix="/api/lyrics",  tags=["lyrics"])


@app.on_event("startup")
async def startup():
    init_db()


@app.get("/health")
async def health():
    return {"status": "ok"}
