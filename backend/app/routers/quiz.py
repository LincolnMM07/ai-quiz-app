import hashlib
import json
import random

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db, QuizSession, QuestionPool
from app.models.quiz import (
    GenerateRequest, GenerateResponse, SessionSaveRequest,
    QuizQuestion, QuestionResultsRequest,
)
from app.services import rag, gemini

router = APIRouter()

POOL_SIZE = 100


def _make_source_key(req: GenerateRequest) -> str:
    if req.source_url and req.source_type in ('youtube', 'url'):
        raw = f"{req.source_type}|{req.source_url}|{req.subject}|{req.study_language}|{req.quiz_language}|{req.study_mode}"
    else:
        raw = f"{req.source_type}|{req.content[:10000]}|{req.subject}|{req.study_language}|{req.quiz_language}|{req.study_mode}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _pool_to_question(p: QuestionPool) -> QuizQuestion:
    return QuizQuestion(
        id=p.id,
        type=p.q_type,
        question=p.question,
        options=json.loads(p.options_json) if p.options_json else None,
        answer=json.loads(p.answer_json),
        hint_ja=p.hint_ja,
        explanation=p.explanation,
    )


@router.post("/generate", response_model=GenerateResponse)
async def generate_quiz(req: GenerateRequest, db: Session = Depends(get_db)):
    """
    Return numQ questions for this source.
    Checks the pool first — only calls Gemini when the pool has fewer questions than needed.
    """
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")

    source_key = _make_source_key(req)
    gemini_called = False

    pool = db.query(QuestionPool).filter(QuestionPool.source_key == source_key).all()

    if len(pool) < req.num_questions:
        gemini_called = True
        try:
            if req.source_type == "topic":
                new_questions = gemini.generate_from_topic(
                    topic=req.content,
                    subject=req.subject,
                    num_questions=POOL_SIZE,
                    difficulty=req.difficulty,
                    language=req.language,
                    study_language=req.study_language,
                    study_mode=req.study_mode,
                    quiz_language=req.quiz_language,
                )
            else:
                context = rag.retrieve_for_quiz(
                    text=req.content,
                    subject=req.subject,
                    num_questions=POOL_SIZE,
                )
                if not context:
                    context = req.content[:5000]
                new_questions = gemini.generate_questions(
                    context=context,
                    title=req.title,
                    subject=req.subject,
                    num_questions=POOL_SIZE,
                    difficulty=req.difficulty,
                    language=req.language,
                    study_language=req.study_language,
                    study_mode=req.study_mode,
                    quiz_language=req.quiz_language,
                )
        except RuntimeError as e:
            err = str(e)
            if "unavailable" in err.lower():
                raise HTTPException(status_code=503, detail="AI_UNAVAILABLE")
            if "quota" in err.lower() or "429" in err:
                raise HTTPException(status_code=429, detail="AI_QUOTA")
            raise HTTPException(status_code=500, detail=f"AI_ERROR: {err[:200]}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"AI_ERROR: {str(e)[:200]}")

        if not new_questions:
            raise HTTPException(status_code=500, detail="Failed to generate questions")

        for q in new_questions:
            db.add(QuestionPool(
                source_key=source_key,
                source_title=req.title,
                source_type=req.source_type,
                subject=req.subject,
                study_language=req.study_language,
                quiz_language=req.quiz_language,
                study_mode=req.study_mode,
                q_type=q.type,
                question=q.question,
                options_json=json.dumps(q.options, ensure_ascii=False) if q.options is not None else None,
                answer_json=json.dumps(q.answer, ensure_ascii=False),
                hint_ja=q.hint_ja,
                explanation=q.explanation,
            ))
        db.commit()
        pool = db.query(QuestionPool).filter(QuestionPool.source_key == source_key).all()

    count = min(req.num_questions, len(pool))
    selected = random.sample(pool, count)

    return GenerateResponse(
        questions=[_pool_to_question(p) for p in selected],
        title=req.title,
        subject=req.subject,
        study_language=req.study_language,
        study_mode=req.study_mode,
        quiz_language=req.quiz_language,
        pool_size=len(pool),
        gemini_called=gemini_called,
    )


@router.get("/health")
async def health_check():
    """Lightweight check — only verifies API key is configured. Does NOT call Gemini."""
    from app.core.config import settings
    if not getattr(settings, 'google_api_key', None):
        return {"status": "no_key"}
    return {"status": "ok"}


@router.post("/questions/results")
async def save_question_results(req: QuestionResultsRequest, db: Session = Depends(get_db)):
    """Record right/wrong outcome per pool question."""
    for result in req.results:
        q = db.query(QuestionPool).filter(QuestionPool.id == result.id).first()
        if q:
            q.times_shown += 1
            if result.correct:
                q.times_correct += 1
            else:
                q.times_wrong += 1
    db.commit()
    return {"status": "saved"}


@router.post("/session")
async def save_session(req: SessionSaveRequest, db: Session = Depends(get_db)):
    """Save a completed quiz session to the database."""
    accuracy = round(req.score / req.mc_total * 100, 1) if req.mc_total > 0 else 0.0
    session = QuizSession(
        subject=req.subject,
        source=req.source,
        title=req.title,
        score=req.score,
        mc_total=req.mc_total,
        total_q=req.total_q,
        accuracy=accuracy,
    )
    db.add(session)
    db.commit()
    return {"status": "saved", "accuracy": accuracy}


@router.get("/sessions")
async def get_sessions(limit: int = 10, db: Session = Depends(get_db)):
    """Retrieve recent quiz sessions."""
    sessions = (
        db.query(QuizSession)
        .order_by(QuizSession.created_at.desc())
        .limit(limit)
        .all()
    )
    return sessions


@router.get("/stats")
async def get_stats(db: Session = Depends(get_db)):
    """Return cumulative learning stats."""
    from sqlalchemy import func
    row = db.query(
        func.count(QuizSession.id).label("sessions"),
        func.coalesce(func.sum(QuizSession.total_q), 0).label("total_q"),
        func.coalesce(func.avg(QuizSession.accuracy), 0).label("avg_accuracy"),
    ).first()
    return {
        "sessions":     row.sessions,
        "total_q":      row.total_q,
        "avg_accuracy": round(row.avg_accuracy, 1),
    }
