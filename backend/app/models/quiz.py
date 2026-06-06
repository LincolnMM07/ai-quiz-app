from pydantic import BaseModel, Field
from typing import List, Optional, Union


class QuizQuestion(BaseModel):
    id: Optional[int] = None           # pool question ID (None for non-pool questions)
    type: str                          # vocab | blank | translation | order | multiple
    question: str
    options: Optional[List[str]] = None
    answer: Union[int, str]
    hint_ja: Optional[str] = None      # hint in the user's native language
    explanation: Optional[str] = None


class GenerateRequest(BaseModel):
    subject: str = "english"
    source_type: str                   # text | pdf | youtube | url | lyrics | topic
    content: str
    title: str
    num_questions: int = Field(default=10, ge=1, le=100)
    language: str = "ja"               # hint/explanation language
    study_language: str = "en"         # language being studied (drives TTS voice)
    quiz_language: str = ""            # language questions are WRITTEN in (empty = same as study_language)
    difficulty: str = "intermediate"   # beginner | intermediate | advanced
    study_mode: str = "mixed"          # mixed | listening | vocabulary | grammar | reading | lyrics
    source_url: Optional[str] = None   # stable URL identifier (youtube/url sources)


class GenerateResponse(BaseModel):
    questions: List[QuizQuestion]
    title: str
    subject: str
    study_language: str = "en"
    study_mode: str = "mixed"
    quiz_language: str = ""
    pool_size: Optional[int] = None    # total questions available in pool
    gemini_called: bool = False        # true when a new batch was generated


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


class QuestionResultsRequest(BaseModel):
    results: List[QuestionResult]
