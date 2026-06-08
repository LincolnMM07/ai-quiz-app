from pydantic import BaseModel, Field
from typing import List, Optional, Union


class QuizQuestion(BaseModel):
    id: Optional[int] = None
    type: str
    question: str
    options: Optional[List[str]] = None
    answer: Union[int, str]
    hint_ja: Optional[str] = None
    explanation: Optional[str] = None
    ease_factor: float = 2.5
    interval_days: int = 0


class GenerateRequest(BaseModel):
    subject: str = "english"
    source_type: str
    content: str
    title: str
    num_questions: int = Field(default=10, ge=1, le=100)
    language: str = "ja"
    study_language: str = "en"
    quiz_language: str = ""
    difficulty: str = "intermediate"
    study_mode: str = "mixed"
    source_url: Optional[str] = None


class GenerateResponse(BaseModel):
    questions: List[QuizQuestion]
    title: str
    subject: str
    study_language: str = "en"
    study_mode: str = "mixed"
    quiz_language: str = ""
    pool_size: Optional[int] = None
    gemini_called: bool = False
    pool_generating: bool = False  # True when background generation is in progress


class SessionSaveRequest(BaseModel):
    subject: str
    source: str
    title: str
    score: int
    mc_total: int
    total_q: int


class QuestionResult(BaseModel):
    id: int
    correct: bool
    quality: int = 3  # SM-2 quality 0-5 (3=correct, 1=wrong)


class QuestionResultsRequest(BaseModel):
    results: List[QuestionResult]


class QuestionEditRequest(BaseModel):
    question: Optional[str] = None
    options: Optional[List[str]] = None
    answer: Optional[Union[int, str]] = None
    hint_ja: Optional[str] = None
    explanation: Optional[str] = None
