"""
RAG Pipeline — the core of this portfolio project.

Flow:
  raw text → chunk → embed → store in ChromaDB → retrieve relevant chunks
  → pass to Gemini for question generation

This demonstrates:
  - Text chunking strategy
  - Vector similarity search
  - Retrieval-Augmented Generation (RAG)
"""
import logging
import uuid
from typing import List

import chromadb
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.core.config import settings

logger = logging.getLogger(__name__)

# ── ChromaDB client (persistent local storage) ──
_client: chromadb.ClientAPI | None = None


def _get_client() -> chromadb.ClientAPI:
    global _client
    if _client is None:
        _client = chromadb.PersistentClient(path=settings.chroma_path)
    return _client


# ── Text splitter settings ──
_splitter = RecursiveCharacterTextSplitter(
    chunk_size=800,
    chunk_overlap=100,
    separators=["\n\n", "\n", "。", ".", " ", ""],
)


def ingest(text: str, collection_name: str) -> int:
    """
    Chunk text and store in ChromaDB.
    Returns the number of chunks stored.
    """
    chunks = _splitter.split_text(text)
    if not chunks:
        return 0

    client = _get_client()
    col = client.get_or_create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )

    # ChromaDB generates embeddings automatically via its default model
    col.add(
        documents=chunks,
        ids=[str(uuid.uuid4()) for _ in chunks],
    )
    logger.info("Ingested %d chunks into collection '%s'", len(chunks), collection_name)
    return len(chunks)


def retrieve(query: str, collection_name: str, n_results: int = 5) -> List[str]:
    """
    Retrieve the most relevant chunks for a given query.
    """
    client = _get_client()
    try:
        col = client.get_collection(collection_name)
    except Exception:
        logger.warning("Collection '%s' not found", collection_name)
        return []

    results = col.query(
        query_texts=[query],
        n_results=min(n_results, col.count()),
    )
    docs: List[str] = results.get("documents", [[]])[0]
    logger.info("Retrieved %d chunks from '%s'", len(docs), collection_name)
    return docs


def retrieve_for_quiz(text: str, subject: str, num_questions: int) -> str:
    """
    Full RAG flow: ingest text → retrieve quiz-relevant passages.
    Returns a condensed context string for the quiz generation prompt.
    """
    collection_name = f"quiz_{uuid.uuid4().hex[:8]}"

    ingest(text, collection_name)

    query = f"Important concepts, vocabulary, and key sentences for a {subject} quiz"
    chunks = retrieve(query, collection_name, n_results=max(5, num_questions // 2))

    # Clean up temporary collection
    _get_client().delete_collection(collection_name)

    return "\n\n---\n\n".join(chunks)
