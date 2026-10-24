"""
RAG Pipeline — the core of this portfolio project.

Flow:
  raw text → chunk → embed (Gemini, multilingual) → store in ChromaDB
  → cluster embeddings (k-means) → pick the chunk nearest each centroid
  → pass to Gemini for question generation

Why clustering instead of a similarity query:
  Quiz generation has no user question to match against. What matters is
  coverage — every topic in the material should be able to produce questions.
  Clustering groups chunks by meaning, and taking one representative per
  cluster spreads the selection across the whole document instead of
  concentrating it on whatever happens to resemble a fixed query string.
"""
import logging
import uuid
from typing import List

import chromadb
import numpy as np
from google import genai
from google.genai import types
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.core.config import settings

logger = logging.getLogger(__name__)

# ── Embedding settings ──
EMBED_MODEL      = "gemini-embedding-001"   # multilingual (ja / en / pt / es ...)
EMBED_DIM        = 256                      # enough for clustering, keeps payload small
EMBED_BATCH      = 100                      # max texts per embed_content call
MAX_EMBED_CHUNKS = 150                      # cap API usage on very long material

# ── ChromaDB client (in-memory; collections are per-request and discarded) ──
_client: chromadb.ClientAPI | None = None


def _get_client() -> chromadb.ClientAPI:
    global _client
    if _client is None:
        _client = chromadb.EphemeralClient()
    return _client


# ── Text splitter settings ──
_splitter = RecursiveCharacterTextSplitter(
    chunk_size=800,
    chunk_overlap=100,
    separators=["\n\n", "\n", "。", ".", " ", ""],
    keep_separator="end",   # keep "。" / "." on the sentence it ends, not the next chunk
)


def split(text: str) -> List[str]:
    return _splitter.split_text(text)


def embed(texts: List[str]) -> np.ndarray:
    """Embed texts with Gemini. Returns L2-normalised vectors (n, EMBED_DIM)."""
    client = genai.Client(api_key=settings.google_api_key)
    config = types.EmbedContentConfig(task_type="CLUSTERING", output_dimensionality=EMBED_DIM)
    vectors: List[List[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        resp = client.models.embed_content(
            model=EMBED_MODEL, contents=texts[i:i + EMBED_BATCH], config=config,
        )
        vectors.extend(e.values for e in resp.embeddings)
    arr = np.asarray(vectors, dtype=np.float32)
    # Truncated gemini-embedding-001 outputs are not normalised
    return arr / np.linalg.norm(arr, axis=1, keepdims=True)


def _even_indices(n: int, k: int) -> List[int]:
    """k indices spread evenly over range(n)."""
    return sorted(set(np.linspace(0, n - 1, k).round().astype(int).tolist()))


def _kmeans(x: np.ndarray, k: int, iters: int = 25, seed: int = 0) -> np.ndarray:
    """Spherical k-means with k-means++ init. Returns normalised centroids (k, dim)."""
    rng = np.random.default_rng(seed)
    centroids = [x[rng.integers(len(x))]]
    for _ in range(1, k):
        dist = 1 - np.max(x @ np.stack(centroids).T, axis=1)
        dist = np.clip(dist, 0, None)
        probs = dist / dist.sum() if dist.sum() > 0 else None
        centroids.append(x[rng.choice(len(x), p=probs)])
    c = np.stack(centroids)
    for _ in range(iters):
        labels = np.argmax(x @ c.T, axis=1)
        new_c = np.stack([
            x[labels == j].mean(axis=0) if np.any(labels == j) else c[j]
            for j in range(k)
        ])
        new_c /= np.linalg.norm(new_c, axis=1, keepdims=True)
        if np.allclose(new_c, c):
            break
        c = new_c
    return c


def select_diverse(chunks: List[str], k: int) -> List[str]:
    """
    Pick k chunks that together cover the material's topics.
    Falls back to evenly spaced chunks if embedding fails (quota, network).
    Result is in document order.
    """
    if len(chunks) <= k:
        return chunks

    # Very long material: pre-sample evenly so embedding cost stays bounded
    candidates = _even_indices(len(chunks), MAX_EMBED_CHUNKS) if len(chunks) > MAX_EMBED_CHUNKS \
        else list(range(len(chunks)))

    try:
        vectors = embed([chunks[i] for i in candidates])
    except Exception as e:
        logger.warning("Embedding failed, using evenly spaced chunks: %s", e)
        return [chunks[i] for i in _even_indices(len(chunks), k)]

    centroids = _kmeans(vectors, k)

    collection_name = f"quiz_{uuid.uuid4().hex[:8]}"
    col = _get_client().create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
        embedding_function=None,
    )
    try:
        col.add(
            ids=[str(i) for i in candidates],
            embeddings=vectors.tolist(),
        )
        # Nearest stored chunk to each centroid; extra results cover collisions
        res = col.query(query_embeddings=centroids.tolist(), n_results=min(k, len(candidates)))
    finally:
        _get_client().delete_collection(collection_name)

    picked: List[int] = []
    for ids in res["ids"]:
        for chunk_id in ids:
            if int(chunk_id) not in picked:
                picked.append(int(chunk_id))
                break

    logger.info("Selected %d/%d chunks via k-means", len(picked), len(chunks))
    return [chunks[i] for i in sorted(picked)]


def retrieve_for_quiz(text: str, subject: str, num_questions: int) -> str:
    """
    Full RAG flow: chunk → embed → cluster → pick representatives.
    Returns a condensed context string for the quiz generation prompt.
    """
    chunks = split(text)
    selected = select_diverse(chunks, max(5, num_questions // 2))
    return "\n\n---\n\n".join(selected)
