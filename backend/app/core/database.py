from sqlalchemy import create_engine, Column, String, Integer, DateTime, Float, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

from app.core.config import settings

_is_sqlite = settings.database_url.startswith("sqlite")
engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
    pool_pre_ping=True,   # 切断されたコネクションを自動で再接続（PostgreSQL本番用）
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class QuizSession(Base):
    __tablename__ = "quiz_sessions"

    id         = Column(Integer, primary_key=True, index=True)
    subject    = Column(String, nullable=False)
    source     = Column(String, nullable=False)   # pdf | youtube | url | text
    title      = Column(String, nullable=False)
    score      = Column(Integer, default=0)
    mc_total   = Column(Integer, default=0)
    total_q    = Column(Integer, default=0)
    accuracy   = Column(Float, default=0.0)
    created_at = Column(DateTime, default=datetime.utcnow)


class QuestionPool(Base):
    __tablename__ = "question_pool"

    id             = Column(Integer, primary_key=True, index=True)
    source_key     = Column(String(64), nullable=False, index=True)
    source_title   = Column(String, nullable=False)
    source_type    = Column(String, nullable=False)
    subject        = Column(String, nullable=False)
    study_language = Column(String, nullable=False)
    quiz_language  = Column(String, nullable=False)
    study_mode     = Column(String, nullable=False)
    q_type         = Column(String, nullable=False)
    question       = Column(Text, nullable=False)
    options_json   = Column(Text, nullable=True)
    answer_json    = Column(Text, nullable=False)
    hint_ja        = Column(Text, nullable=True)
    explanation    = Column(Text, nullable=True)
    times_shown    = Column(Integer, default=0)
    times_correct  = Column(Integer, default=0)
    times_wrong    = Column(Integer, default=0)
    created_at     = Column(DateTime, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
