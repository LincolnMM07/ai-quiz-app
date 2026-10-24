"""
Backend tests — run with: pytest tests/ -v
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.services import gemini
from app.services.gemini import _parse_questions
from app.services import sources as svc

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
