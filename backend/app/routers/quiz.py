import hashlib
import json
import random
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from app.core.database import get_db, SessionLocal, QuizSession, QuestionPool
from app.models.quiz import (
    GenerateRequest, GenerateResponse, SessionSaveRequest,
    QuizQuestion, QuestionResultsRequest, QuestionEditRequest,
)
from app.services import rag, gemini

router = APIRouter()
logger = logging.getLogger(__name__)

POOL_SIZE     = 100
INITIAL_BATCH = 25   # Generated synchronously; rest filled in background


# ── Helpers ────────────────────────────────────────────────────────────────

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
        ease_factor=p.ease_factor or 2.5,
        interval_days=p.interval_days or 0,
    )


def _sm2_weight(p: QuestionPool) -> float:
    """Weight for spaced repetition selection. Higher = show sooner."""
    if p.times_shown == 0:
        return 1.0
    error_rate = p.times_wrong / p.times_shown if p.times_shown > 0 else 0
    ef = p.ease_factor or 2.5
    interval = p.interval_days or 0
    # Questions due for review get high weight; mastered get low weight
    weight = (1 + error_rate * 2) / max(ef, 1.3) * (1 / max(interval, 1))
    return weight


def _select_by_sm2(pool: list, count: int) -> list:
    """Select questions weighted by SM-2 priority (weak/due questions first)."""
    if len(pool) <= count:
        return pool
    weights = [_sm2_weight(p) for p in pool]
    total = sum(weights)
    probs = [w / total for w in weights]
    indices = random.choices(range(len(pool)), weights=probs, k=count * 3)
    seen = set()
    result = []
    for i in indices:
        if i not in seen:
            seen.add(i)
            result.append(pool[i])
        if len(result) == count:
            break
    # Fallback if not enough unique
    if len(result) < count:
        remaining = [p for j, p in enumerate(pool) if j not in seen]
        result.extend(remaining[:count - len(result)])
    return result


def _save_questions_to_db(questions: list, req: GenerateRequest, source_key: str, db: Session):
    for q in questions:
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


def _generate_background(source_key: str, req: GenerateRequest, already_have: int):
    """Background task: generate remaining questions to fill pool."""
    remaining = POOL_SIZE - already_have
    if remaining <= 0:
        return
    db = SessionLocal()
    try:
        try:
            if req.source_type == "topic":
                new_questions = gemini.generate_from_topic(
                    topic=req.content,
                    subject=req.subject,
                    num_questions=remaining,
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
                    num_questions=remaining,
                )
                if not context:
                    context = req.content[:5000]
                new_questions = gemini.generate_questions(
                    context=context,
                    title=req.title,
                    subject=req.subject,
                    num_questions=remaining,
                    difficulty=req.difficulty,
                    language=req.language,
                    study_language=req.study_language,
                    study_mode=req.study_mode,
                    quiz_language=req.quiz_language,
                )
            if new_questions:
                _save_questions_to_db(new_questions, req, source_key, db)
                logger.info("Background: added %d questions for key %s", len(new_questions), source_key[:8])
        except Exception as e:
            logger.warning("Background generation failed: %s", e)
    finally:
        db.close()


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/generate", response_model=GenerateResponse)
async def generate_quiz(
    req: GenerateRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")

    source_key = _make_source_key(req)
    gemini_called = False
    pool_generating = False

    pool = db.query(QuestionPool).filter(QuestionPool.source_key == source_key).all()

    if len(pool) < req.num_questions:
        gemini_called = True
        # Generate only INITIAL_BATCH synchronously for fast response
        sync_count = max(req.num_questions, INITIAL_BATCH)
        try:
            if req.source_type == "topic":
                new_questions = gemini.generate_from_topic(
                    topic=req.content,
                    subject=req.subject,
                    num_questions=sync_count,
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
                    num_questions=sync_count,
                )
                if not context:
                    context = req.content[:5000]
                new_questions = gemini.generate_questions(
                    context=context,
                    title=req.title,
                    subject=req.subject,
                    num_questions=sync_count,
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

        _save_questions_to_db(new_questions, req, source_key, db)
        pool = db.query(QuestionPool).filter(QuestionPool.source_key == source_key).all()

        # If pool still below POOL_SIZE, fill rest in background
        if len(pool) < POOL_SIZE:
            pool_generating = True
            background_tasks.add_task(_generate_background, source_key, req, len(pool))

    count = min(req.num_questions, len(pool))
    selected = _select_by_sm2(pool, count)

    return GenerateResponse(
        questions=[_pool_to_question(p) for p in selected],
        title=req.title,
        subject=req.subject,
        study_language=req.study_language,
        study_mode=req.study_mode,
        quiz_language=req.quiz_language,
        pool_size=len(pool),
        gemini_called=gemini_called,
        pool_generating=pool_generating,
    )


@router.get("/health")
async def health_check():
    from app.core.config import settings
    if not getattr(settings, 'google_api_key', None):
        return {"status": "no_key"}
    return {"status": "ok"}


@router.post("/questions/results")
async def save_question_results(req: QuestionResultsRequest, db: Session = Depends(get_db)):
    """Record right/wrong and update SM-2 ease factor + interval."""
    for result in req.results:
        q = db.query(QuestionPool).filter(QuestionPool.id == result.id).first()
        if not q:
            continue
        q.times_shown += 1
        quality = result.quality if hasattr(result, 'quality') else (3 if result.correct else 1)
        if result.correct:
            q.times_correct += 1
        else:
            q.times_wrong += 1
        # SM-2 update
        ef = q.ease_factor or 2.5
        ef = max(1.3, ef + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
        q.ease_factor = ef
        if quality < 3:
            q.interval_days = 0
        elif q.interval_days == 0:
            q.interval_days = 1
        elif q.interval_days == 1:
            q.interval_days = 6
        else:
            q.interval_days = round(q.interval_days * ef)
    db.commit()
    return {"status": "saved"}


@router.patch("/questions/{question_id}")
async def edit_question(
    question_id: int,
    req: QuestionEditRequest,
    db: Session = Depends(get_db),
):
    """Edit a question in the pool."""
    q = db.query(QuestionPool).filter(QuestionPool.id == question_id).first()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")
    if req.question is not None:
        q.question = req.question
    if req.options is not None:
        q.options_json = json.dumps(req.options, ensure_ascii=False)
    if req.answer is not None:
        q.answer_json = json.dumps(req.answer, ensure_ascii=False)
    if req.hint_ja is not None:
        q.hint_ja = req.hint_ja
    if req.explanation is not None:
        q.explanation = req.explanation
    db.commit()
    return {"status": "updated"}


@router.get("/pool/{source_key}/status")
async def pool_status(source_key: str, db: Session = Depends(get_db)):
    """Check how many questions are in the pool for a given source key."""
    count = db.query(QuestionPool).filter(QuestionPool.source_key == source_key).count()
    return {"pool_size": count, "source_key": source_key}


@router.get("/export/anki/{source_key}")
async def export_anki(source_key: str, db: Session = Depends(get_db)):
    """Export questions as Anki-compatible CSV."""
    from fastapi.responses import StreamingResponse
    import io
    import csv

    pool = db.query(QuestionPool).filter(QuestionPool.source_key == source_key).all()
    if not pool:
        raise HTTPException(status_code=404, detail="No questions found for this source")

    output = io.StringIO()
    writer = csv.writer(output, delimiter='\t')
    for q in pool:
        options = json.loads(q.options_json) if q.options_json else []
        answer = json.loads(q.answer_json)
        # Front: question (+ options if MC)
        front = q.question
        if options:
            opts_text = " / ".join(f"{chr(65+i)}) {o}" for i, o in enumerate(options))
            front = f"{q.question}\n{opts_text}"
        # Back: answer + explanation
        if options and isinstance(answer, int) and 0 <= answer < len(options):
            back = options[answer]
        else:
            back = str(answer)
        if q.explanation:
            back += f"\n\n{q.explanation}"
        if q.hint_ja:
            back += f"\n💡 {q.hint_ja}"
        writer.writerow([front, back, q.subject, q.q_type])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/tab-separated-values",
        headers={"Content-Disposition": f"attachment; filename=anki_{source_key[:8]}.txt"},
    )


@router.post("/session")
async def save_session(req: SessionSaveRequest, db: Session = Depends(get_db)):
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
    sessions = (
        db.query(QuizSession)
        .order_by(QuizSession.created_at.desc())
        .limit(limit)
        .all()
    )
    return sessions


@router.get("/sessions/history")
async def get_sessions_history(days: int = 30, db: Session = Depends(get_db)):
    """Return daily aggregated stats for the past N days (for charts)."""
    from sqlalchemy import func, cast, Date
    since = datetime.utcnow() - timedelta(days=days)
    rows = (
        db.query(
            cast(QuizSession.created_at, Date).label("date"),
            func.count(QuizSession.id).label("sessions"),
            func.coalesce(func.sum(QuizSession.total_q), 0).label("total_q"),
            func.coalesce(func.avg(QuizSession.accuracy), 0).label("avg_accuracy"),
        )
        .filter(QuizSession.created_at >= since)
        .group_by(cast(QuizSession.created_at, Date))
        .order_by(cast(QuizSession.created_at, Date))
        .all()
    )
    return [
        {
            "date": str(r.date),
            "sessions": r.sessions,
            "total_q": r.total_q,
            "avg_accuracy": round(r.avg_accuracy, 1),
        }
        for r in rows
    ]


@router.get("/stats")
async def get_stats(db: Session = Depends(get_db)):
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
