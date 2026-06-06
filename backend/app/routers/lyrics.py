"""
Lyrics router — search songs via lyrics.ovh (Western) and Vagalume (Portuguese).
Returns song metadata and lyrics-page URLs; actual lyric text is pasted manually by the user.
"""
import logging
import urllib.parse

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

_SUGGEST  = "https://api.lyrics.ovh/suggest/"
_FETCH    = "https://api.lyrics.ovh/v1/"
_VAGALUME = "https://api.vagalume.com.br/search.php"
_TIMEOUT  = 12
_MAX_LEN  = 8_000


class FetchRequest(BaseModel):
    artist: str
    title:  str


@router.get("/search")
async def search_songs(q: str):
    """Search songs by artist/title. Returns up to 20 results."""
    if not q.strip():
        raise HTTPException(status_code=400, detail="Search query required")
    try:
        resp = requests.get(
            _SUGGEST + urllib.parse.quote(q.strip()),
            timeout=_TIMEOUT,
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        hits = resp.json().get("data", [])[:20]
        return {
            "results": [
                {
                    "artist": h.get("artist", {}).get("name", ""),
                    "title":  h.get("title", ""),
                    "album":  (h.get("album") or {}).get("title", ""),
                }
                for h in hits
            ]
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Lyrics search failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Search failed: {e}")


@router.post("/fetch")
async def fetch_lyrics(req: FetchRequest):
    """Fetch lyrics for artist + song title."""
    if not req.artist.strip() or not req.title.strip():
        raise HTTPException(status_code=400, detail="Artist and title are required")
    try:
        url = (
            _FETCH
            + urllib.parse.quote(req.artist.strip())
            + "/"
            + urllib.parse.quote(req.title.strip())
        )
        resp = requests.get(url, timeout=_TIMEOUT, headers={"Accept": "application/json"})
        resp.raise_for_status()
        lyrics = resp.json().get("lyrics", "").strip()
        if not lyrics:
            raise HTTPException(status_code=404, detail="Lyrics not found for this song")
        return {
            "artist":  req.artist,
            "title":   req.title,
            "lyrics":  lyrics[:_MAX_LEN],
            "length":  len(lyrics),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Lyrics fetch failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Lyrics fetch failed: {e}")


@router.get("/vagalume")
async def vagalume_search(q: str):
    """
    Search Portuguese/Brazilian songs on Vagalume.
    Returns song title, artist, and the Vagalume lyrics-page URL.
    The actual lyrics are NOT fetched — the user visits the URL and copies them manually.
    """
    from app.core.config import settings

    api_key = settings.vagalume_api_key.strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "Vagalume API key が未設定です。"
                " .env に VAGALUME_API_KEY を追加してください。"
                " 取得先: https://auth.vagalume.com.br/settings/api/"
            ),
        )
    if not q.strip():
        raise HTTPException(status_code=400, detail="Search query required")

    try:
        resp = requests.get(
            _VAGALUME,
            params={"apikey": api_key, "q": q.strip()},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Vagalume search failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Vagalume search failed: {e}")

    doc_type = data.get("type", "notFound")
    doc      = data.get("doc", {})
    results  = []

    if doc_type == "notFound" or not doc:
        return {"results": [], "type": "notFound"}

    # ── Exact match: doc is a dict with "artist" and "music" keys ──────────
    if isinstance(doc, dict) and "artist" in doc:
        artist_name = doc["artist"].get("name", "")
        music = doc.get("music", {})
        if isinstance(music, dict):
            # Single song
            if music.get("url"):
                results.append({
                    "artist": artist_name,
                    "title":  music.get("name", ""),
                    "url":    music["url"],
                })
        elif isinstance(music, list):
            for m in music[:15]:
                if m.get("url"):
                    results.append({
                        "artist": artist_name,
                        "title":  m.get("name", ""),
                        "url":    m["url"],
                    })

    # ── Approximate matches: doc is a list of artists each with "msc" ──────
    elif isinstance(doc, list):
        for artist in doc[:6]:
            artist_name = artist.get("name", "")
            for song in artist.get("msc", [])[:4]:
                if song.get("url"):
                    results.append({
                        "artist": artist_name,
                        "title":  song.get("name", ""),
                        "url":    song["url"],
                    })

    return {"results": results, "type": doc_type}
