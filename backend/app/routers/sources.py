"""
Sources router — PDF upload, YouTube transcript, URL scraping, AI resource search.
"""
import logging
import re
import tempfile
import os
from typing import Tuple

import requests
from bs4 import BeautifulSoup
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()


class UrlRequest(BaseModel):
    url: str


class AiSearchRequest(BaseModel):
    topic: str
    study_language: str = "en"
    ui_language: str = "ja"


@router.post("/youtube")
async def youtube_source(req: UrlRequest):
    try:
        title, text = extract_youtube(req.url)
        return {"title": title, "text": text, "length": len(text), "source_type": "youtube"}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/url")
async def url_source(req: UrlRequest):
    try:
        title, text = extract_url(req.url)
        return {"title": title, "text": text, "length": len(text), "source_type": "url"}
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/pdf")
async def pdf_source(file: UploadFile = File(...)):
    try:
        content = await file.read()
        title, text = extract_pdf(content, file.filename or "upload.pdf")
        return {"title": title, "text": text, "length": len(text), "source_type": "pdf"}
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/ai-search")
async def ai_search(req: AiSearchRequest):
    """Use AI to suggest free educational websites and PDFs for a topic."""
    from app.services import gemini
    results = gemini.search_educational_resources(req.topic, req.study_language, req.ui_language)
    return {"results": results}

MAX_TEXT_LENGTH = 10_000


# ── PDF ──────────────────────────────────────────────────────
def extract_pdf(file_bytes: bytes, filename: str) -> Tuple[str, str]:
    """Extract text from PDF bytes. Returns (title, text)."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name

        text = ""
        try:
            import pdfplumber
            with pdfplumber.open(tmp_path) as pdf:
                text = "\n".join(p.extract_text() or "" for p in pdf.pages).strip()
        except Exception as e:
            logger.warning("pdfplumber failed: %s", e)

        if not text:
            from pypdf import PdfReader
            reader = PdfReader(tmp_path)
            text = "\n".join(page.extract_text() or "" for page in reader.pages)

        text = re.sub(r'\s+', ' ', text).strip()
        if not text:
            raise ValueError("No text extracted — may be a scanned PDF")

        return filename, text[:MAX_TEXT_LENGTH]

    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


# ── YouTube ───────────────────────────────────────────────────
def extract_youtube(url: str) -> Tuple[str, str]:
    """
    Extract transcript from a YouTube video.
    Uses youtube-transcript-api v1.x (instance-based API).
    Returns (title, transcript_text).
    """
    import urllib.parse
    from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound

    # Extract video ID from various URL formats
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    video_id = qs.get("v", [None])[0]

    if not video_id:
        # Handle youtu.be/VIDEO_ID and /shorts/VIDEO_ID
        path = parsed.path.lstrip("/")
        if path.startswith("shorts/"):
            video_id = path.split("/")[1]
        else:
            video_id = path.split("/")[0]

    if not video_id:
        raise ValueError(f"Could not extract video ID from URL: {url}")

    try:
        # v1.x API: instantiate the class, then call instance methods
        ytt = YouTubeTranscriptApi()

        # Try to get English transcript; fall back to any auto-generated one
        try:
            transcript_list = ytt.list(video_id)
            try:
                transcript = transcript_list.find_transcript(["en", "en-US", "en-GB"])
            except NoTranscriptFound:
                # Fall back to first available transcript and translate to English
                transcript = next(iter(transcript_list))
                try:
                    transcript = transcript.translate("en")
                except Exception:
                    pass  # Use original language if translation fails

            entries = transcript.fetch()

        except Exception:
            # Last resort: direct fetch with language preference
            fetched = ytt.fetch(video_id, languages=["en", "en-US", "en-GB", "a.en"])
            entries = fetched

        # FetchedTranscript supports iteration; each entry has .text
        text_parts = []
        for entry in entries:
            # v1.x entries may be objects or dicts depending on sub-version
            if hasattr(entry, "text"):
                text_parts.append(entry.text)
            elif isinstance(entry, dict):
                text_parts.append(entry.get("text", ""))

        text = " ".join(text_parts)
        text = re.sub(r'\s+', ' ', text).strip()

        if not text:
            raise ValueError("Transcript is empty")

        title = _get_youtube_title(video_id) or f"YouTube: {video_id}"
        return title, text[:MAX_TEXT_LENGTH]

    except Exception as e:
        raise ValueError(f"Could not fetch YouTube transcript: {e}")


def _get_youtube_title(video_id: str) -> str:
    try:
        resp = requests.get(
            f"https://www.youtube.com/oembed"
            f"?url=https://www.youtube.com/watch?v={video_id}&format=json",
            timeout=10,
        )
        return resp.json().get("title", "")
    except Exception:
        return ""


# ── URL scraping ──────────────────────────────────────────────
def extract_url(url: str) -> Tuple[str, str]:
    """
    Scrape main text content from a URL.
    Returns (title, text).
    """
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    }
    resp = requests.get(url, headers=headers, timeout=15)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")

    for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
        tag.decompose()

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else url

    content = (
        soup.find("article")
        or soup.find("main")
        or soup.find("div", class_=re.compile(r"content|article|post|body"))
        or soup.find("body")
    )
    text = content.get_text(separator="\n", strip=True) if content else soup.get_text()
    text = re.sub(r'\n{3,}', '\n\n', text).strip()

    return title, text[:MAX_TEXT_LENGTH]
