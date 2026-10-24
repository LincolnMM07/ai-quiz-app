"""
Backend tests — run with: pytest tests/ -v
"""
import json
import numpy as np
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.services import gemini
from app.services.gemini import _parse_questions
from app.services import sources as svc
from app.services import rag

client = TestClient(app)


# ── parse_questions ──────────────────────────────────
class TestParseQuestions:
    def test_clean_json(self):
        raw = '[{"type":"vocab","question":"Q?","options":["A","B"],"answer":0}]'
        result = _parse_questions(raw)
        assert len(result) == 1

    def test_strips_markdown(self):
        raw = '```json\n[{"type":"blank","question":"Q?","options":["a","b"],"answer":1}]\n```'
        result = _parse_questions(raw)
        assert result[0].answer == 1

    def test_empty_returns_empty(self):
        assert _parse_questions("") == []

    def test_invalid_returns_empty(self):
        assert _parse_questions("not json") == []


# ── generate_questions ───────────────────────────────
class TestGenerateQuestionsContext:
    def test_uses_all_retrieved_chunks(self, monkeypatch):
        # 50 chunks of 800 chars = what retrieve_for_quiz returns for 100 questions
        chunks = [f"CHUNK{i:02d}" + "x" * 793 for i in range(50)]
        context = "\n\n---\n\n".join(chunks)
        captured = {}

        def fake_call(prompt):
            captured["prompt"] = prompt
            return "[]"

        monkeypatch.setattr(gemini, "_call_gemini", fake_call)
        gemini.generate_questions(
            context=context, title="t", subject="english",
            num_questions=100, difficulty="intermediate", language="ja",
        )
        assert "CHUNK00" in captured["prompt"]
        assert "CHUNK49" in captured["prompt"]


# ── sources service ──────────────────────────────────
class TestExtractUrl:
    def test_raises_on_http_error(self, monkeypatch):
        import requests as req
        monkeypatch.setattr(
            req, "get",
            MagicMock(side_effect=req.exceptions.HTTPError("404"))
        )
        with pytest.raises(Exception):
            svc.extract_url("https://example.com")

    def test_extracts_title_and_text(self, monkeypatch):
        import requests as req
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.text = "<html><head><title>Test Page</title></head><body><p>Hello world</p></body></html>"
        monkeypatch.setattr(req, "get", MagicMock(return_value=resp))
        title, text = svc.extract_url("https://example.com")
        assert title == "Test Page"
        assert "Hello" in text


# ── API health check ──────────────────────────────────
class TestHealth:
    def test_health_ok(self):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"


# ── Audio endpoint ────────────────────────────────────
class TestAudioVoices:
    def test_list_voices(self):
        response = client.get("/api/audio/voices")
        assert response.status_code == 200
        voices = response.json()["voices"]
        assert any(v["id"] == "en-US-female" for v in voices)


# ── RAG chunk selection ──────────────────────────────
class TestRagSelection:
    @staticmethod
    def _clustered(n_topics, per_topic, dim=16):
        """Chunks grouped into topics; embeddings are near-identical within a topic."""
        rng = np.random.default_rng(1)
        centers = np.eye(dim)[:n_topics]
        chunks, vecs = [], []
        for t in range(n_topics):
            for i in range(per_topic):
                chunks.append(f"topic{t}-chunk{i}")
                v = centers[t] + rng.normal(0, 0.01, dim)
                vecs.append(v / np.linalg.norm(v))
        return chunks, {c: v for c, v in zip(chunks, vecs)}

    def test_covers_every_topic(self, monkeypatch):
        # Topic 0 dominates the material; a similarity query would over-pick it
        chunks, table = self._clustered(n_topics=4, per_topic=10)
        monkeypatch.setattr(rag, "embed", lambda texts: np.stack([table[t] for t in texts]))
        picked = rag.select_diverse(chunks, k=4)
        assert len(picked) == 4
        assert {p.split("-")[0] for p in picked} == {"topic0", "topic1", "topic2", "topic3"}

    def test_keeps_document_order(self, monkeypatch):
        chunks, table = self._clustered(n_topics=5, per_topic=6)
        monkeypatch.setattr(rag, "embed", lambda texts: np.stack([table[t] for t in texts]))
        picked = rag.select_diverse(chunks, k=5)
        assert picked == sorted(picked, key=chunks.index)

    def test_short_material_returns_all(self, monkeypatch):
        monkeypatch.setattr(rag, "embed", MagicMock(side_effect=AssertionError("should not embed")))
        assert rag.select_diverse(["a", "b", "c"], k=5) == ["a", "b", "c"]

    def test_falls_back_to_even_spacing_when_embedding_fails(self, monkeypatch):
        monkeypatch.setattr(rag, "embed", MagicMock(side_effect=RuntimeError("429 quota")))
        chunks = [f"c{i}" for i in range(100)]
        picked = rag.select_diverse(chunks, k=5)
        assert picked == ["c0", "c25", "c50", "c74", "c99"]

    def test_caps_embedding_calls_on_long_material(self, monkeypatch):
        seen = {}

        def fake_embed(texts):
            seen["n"] = len(texts)
            rng = np.random.default_rng(0)
            v = rng.normal(size=(len(texts), 8))
            return v / np.linalg.norm(v, axis=1, keepdims=True)

        monkeypatch.setattr(rag, "embed", fake_embed)
        picked = rag.select_diverse([f"c{i}" for i in range(1000)], k=10)
        assert seen["n"] == rag.MAX_EMBED_CHUNKS
        assert len(picked) == 10

    def test_retrieve_for_quiz_splits_japanese_on_kuten(self, monkeypatch):
        monkeypatch.setattr(rag, "embed", MagicMock(side_effect=RuntimeError("offline")))
        text = "これは日本語の文章です。" * 300   # ~3600 chars, no newlines
        context = rag.retrieve_for_quiz(text, subject="japanese", num_questions=10)
        for chunk in context.split("\n\n---\n\n"):
            assert len(chunk) <= 800
            assert chunk.endswith("。")
