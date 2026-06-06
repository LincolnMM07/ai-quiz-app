"""
Gemini API service — multi-subject, multi-language quiz generation.
Prompts are selected dynamically based on subject, study language, study mode, and difficulty.
"""
import json
import logging
import re
from typing import List

from google import genai

from app.core.config import settings
from app.models.quiz import QuizQuestion

logger = logging.getLogger(__name__)

GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"]

# ── Language name maps ──────────────────────────────────────────────────
STUDY_LANG_NAMES = {
    "en": "English",
    "ja": "Japanese",
    "es": "Spanish",
    "fr": "French",
    "ko": "Korean",
    "zh": "Chinese (Mandarin)",
    "pt": "Portuguese",
    "de": "German",
    "it": "Italian",
}

HINT_LANG_NAMES = {
    "ja": "Japanese",
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "ko": "Korean",
    "zh": "Chinese",
    "pt": "Portuguese",
}

# ── Subject-specific prompt templates ───────────────────────────────────
SUBJECT_PROMPTS = {
    "english": """You are an English teacher creating quiz questions for a language learner.
Focus on: vocabulary, grammar, reading comprehension, translation, word ordering.
Mix question types: vocab (4-choice), blank (4-choice), translation (open), order (open).""",

    "japanese": """You are a Japanese language teacher creating quiz questions for a learner.
Focus on: kanji readings, vocabulary, grammar patterns (は/が/を/に particles), reading comprehension.
Mix: vocab (4-choice with hiragana/kanji), blank (4-choice), translation (open).""",

    "spanish": """You are a Spanish teacher creating quiz questions for a language learner.
Focus on: vocabulary, verb conjugation (present/past/future), grammar, reading comprehension.
Mix: vocab (4-choice), blank (4-choice), translation (open).""",

    "french": """You are a French teacher creating quiz questions for a language learner.
Focus on: vocabulary, verb conjugation, gender agreement, grammar, reading comprehension.
Mix: vocab (4-choice), blank (4-choice), translation (open).""",

    "korean": """You are a Korean teacher creating quiz questions for a language learner.
Focus on: vocabulary, grammar endings (아/어요, 이다/입니다), particles, reading comprehension.
Mix: vocab (4-choice), blank (4-choice), translation (open).""",

    "chinese": """You are a Chinese (Mandarin) teacher creating quiz questions for a language learner.
Focus on: vocabulary with pinyin, characters, measure words, grammar patterns, reading comprehension.
Mix: vocab (4-choice), blank (4-choice), translation (open).""",

    "portuguese": """You are a Portuguese teacher creating quiz questions for a language learner.
Focus on: vocabulary, verb conjugation, grammar, reading comprehension.
Mix: vocab (4-choice), blank (4-choice), translation (open).""",

    "math": """You are a math teacher creating quiz questions for students.
IMPORTANT: At least 60% of questions MUST be type "calculation" — actual numerical or algebraic problems.
- "calculation" type: a specific problem to solve. Set options to null. Set answer to the exact numerical result as a plain string (e.g. "4", "36", "0.5", "x=3"). No units unless required.
  Good examples: "Solve for x: 3x + 7 = 22", "Calculate: 15% of 240", "Simplify: (2³ × 4) ÷ 8", "What is the area of a circle with radius 5? (use π≈3.14)"
- "multiple" type (20%): formula recognition or conceptual understanding (4-choice, answer: index 0-3)
- "blank" type (20%): fill in a missing number or term in a formula (4-choice, answer: index 0-3)
Never generate translation or word-ordering questions for math.""",

    "history": """You are a history teacher creating quiz questions.
Focus on: dates, key figures, cause-and-effect relationships, historical significance.
- "multiple" type (50%): factual 4-choice questions (who/what/when/where), answer: index 0-3
- "blank" type (30%): fill in a key date, name, or term in a sentence (4-choice), answer: index 0-3
- "translation" type (20%): short open-answer explanation (e.g. "Why did X happen?", "What was the historical significance of Y?"), options: null, answer: a model answer string
Never generate calculation or code questions for history.""",

    "science": """You are a science teacher creating quiz questions.
- For quantitative topics (physics formulas, chemistry stoichiometry): 40% MUST be type "calculation" — actual formula-based problems. options: null. answer: numerical result as a string (include unit if essential, e.g. "15 N", "6 mol").
  Examples: "F = ma. m=5 kg, a=3 m/s². Find F.", "Calculate the speed: distance=120 km, time=2 h."
- "multiple" type (40%): concept definitions, process identification, classification (4-choice)
- "blank" type (20%): fill-in scientific terms or missing steps in a process (4-choice)""",

    "programming": """You are a programming instructor creating quiz questions.
- "code" type (40%): present a SHORT code snippet (≤10 lines) between triple backticks, then ask a question about it.
  If asking for predicted output or a bug: provide 4 options ["A) ...", "B) ...", "C) ...", "D) ..."] and set answer to the correct index (0-3).
  If asking for an open explanation: set options to null and answer to a model string explanation.
  Example question format: "What does the following code output?\\n```python\\nfor i in range(3):\\n    print(i*2)\\n```"
- "blank" type (30%): fill-in-the-blank for syntax keywords or operators (4-choice), answer: index 0-3
- "multiple" type (30%): conceptual questions on complexity, patterns, best practices (4-choice), answer: index 0-3""",

    "toeic": """You are a TOEIC preparation teacher.
Focus on: business vocabulary, reading comprehension, grammar patterns typical in TOEIC.
Use TOEIC-style Part 5/6/7 question formats.""",

    "default": """You are a teacher creating quiz questions.
Focus on the key concepts, important terms, and main ideas in the provided content.
Mix question types for variety.""",
}

# ── Study mode instructions ──────────────────────────────────────────────
STUDY_MODE_INSTRUCTIONS = {
    "listening": """STUDY MODE — LISTENING COMPREHENSION:
Make 70% of questions fill-in-the-blank (key words removed from sentences).
Make 30% short dictation-style (reproduce a phrase from the text).
hint_ja should indicate this is a listening exercise.""",

    "vocabulary": """STUDY MODE — VOCABULARY:
ALL questions must focus on word/phrase meanings, synonyms, antonyms, or usage in context.
Use 4-choice format for every question. Include the word in a sample sentence.""",

    "grammar": """STUDY MODE — GRAMMAR:
ALL questions must focus on grammar patterns, conjugation, particles, or sentence structure.
Mix 4-choice (error detection, best completion) and short open-answer (transform a sentence).
Always explain WHY in the explanation field.""",

    "reading": """STUDY MODE — READING COMPREHENSION:
ALL questions must test understanding of the passage content.
Include main idea, specific detail, inference, and vocabulary-in-context questions.
Use multiple-choice for factual questions, open-answer for summary/opinion.""",

    "lyrics": """STUDY MODE — SONG LYRICS:
Create questions that make learning through music fun:
- 40% fill-in-the-blank (key lyric words replaced with _____)
- 40% vocabulary (4-choice meaning of words from the lyrics)
- 20% translation of lyric lines
Make hint_ja reference the musical context.""",

    "mixed": "Mix question types for variety (vocab, blank, translation, multiple-choice).",
}

DIFFICULTY_NOTES = {
    "beginner":     "DIFFICULTY: BEGINNER — Keep very simple. Use basic vocabulary. Short sentences.",
    "intermediate": "DIFFICULTY: INTERMEDIATE — Balance conceptual and applied questions.",
    "advanced":     "DIFFICULTY: ADVANCED — Include nuanced, complex questions requiring deep understanding.",
}


# ── Core Gemini call ─────────────────────────────────────────────────────
def _call_gemini(prompt: str) -> str:
    client = genai.Client(api_key=settings.google_api_key)
    quota_hit = False
    for model in GEMINI_MODELS:
        try:
            resp = client.models.generate_content(model=model, contents=prompt)
            return resp.text
        except Exception as e:
            err = str(e)
            if "quota" in err.lower() or "429" in err:
                logger.warning("Model %s quota exceeded", model)
                quota_hit = True
                continue
            if any(x in err for x in ["503", "UNAVAILABLE"]):
                logger.warning("Model %s unavailable, trying next", model)
                continue
            logger.error("Gemini error (%s): %s", model, err)
            raise
    if quota_hit:
        raise RuntimeError("API quota exceeded for all models")
    raise RuntimeError("All Gemini models are currently unavailable")


def _parse_json_list(raw: str) -> List[dict]:
    raw = re.sub(r"```json|```", "", raw).strip()
    try:
        result = json.loads(raw)
        return result if isinstance(result, list) else []
    except Exception:
        m = re.search(r'\[.*\]', raw, re.DOTALL)
        if m:
            try:
                result = json.loads(m.group())
                return result if isinstance(result, list) else []
            except Exception:
                pass
    return []


# ── Shared prompt builder ─────────────────────────────────────────────────
def _build_question_prompt(
    *,
    context_block: str,
    title: str,
    subject: str,
    num_questions: int,
    difficulty: str,
    language: str,
    study_language: str,
    quiz_language: str,
    study_mode: str,
    extra_instruction: str = "",
) -> str:
    subject_prompt   = SUBJECT_PROMPTS.get(subject, SUBJECT_PROMPTS["default"])
    mode_instruction = STUDY_MODE_INSTRUCTIONS.get(study_mode, STUDY_MODE_INSTRUCTIONS["mixed"])
    difficulty_note  = DIFFICULTY_NOTES.get(difficulty, DIFFICULTY_NOTES["intermediate"])

    # quiz_language controls what language questions are WRITTEN in.
    # If not set, fall back to study_language (old behaviour).
    effective_quiz_lang = quiz_language.strip() if quiz_language else study_language
    quiz_lang_name = STUDY_LANG_NAMES.get(effective_quiz_lang, "English")
    hint_lang_name = HINT_LANG_NAMES.get(language, "Japanese")

    return f"""{subject_prompt}

{mode_instruction}
{difficulty_note}
{extra_instruction}

{context_block}

Generate exactly {num_questions} quiz questions.

Language rules:
- Questions MUST be written in {quiz_lang_name}
- options (if any) MUST be written in {quiz_lang_name}
- hint_ja field MUST be in {hint_lang_name}
- explanation field MUST be in {hint_lang_name}
- For "translation" type: translate FROM {quiz_lang_name} TO {hint_lang_name}

Return ONLY a valid JSON array, no markdown, no extra text:
[
  {{
    "type": "vocab",
    "question": "Question in {quiz_lang_name}",
    "options": ["A) option1", "B) option2", "C) option3", "D) option4"],
    "answer": 0,
    "hint_ja": "Hint in {hint_lang_name}",
    "explanation": "Explanation in {hint_lang_name}"
  }},
  {{
    "type": "blank",
    "question": "Fill in: The _____ is important.",
    "options": ["A) word1", "B) word2", "C) word3", "D) word4"],
    "answer": 0,
    "hint_ja": "Hint in {hint_lang_name}",
    "explanation": "Explanation in {hint_lang_name}"
  }},
  {{
    "type": "translation",
    "question": "Translate: 'example sentence in {quiz_lang_name}'",
    "options": null,
    "answer": "Translation in {hint_lang_name}",
    "hint_ja": "Hint in {hint_lang_name}",
    "explanation": "Grammar note in {hint_lang_name}"
  }}
]"""


def _parse_questions(raw: str) -> List[QuizQuestion]:
    questions = []
    for item in _parse_json_list(raw):
        try:
            questions.append(QuizQuestion(**item))
        except Exception as e:
            logger.warning("Skipping malformed question: %s", e)
    return questions


# ── Quiz generation from document ────────────────────────────────────────
def generate_questions(
    context: str,
    title: str,
    subject: str,
    num_questions: int,
    difficulty: str,
    language: str,
    study_language: str = "en",
    study_mode: str = "mixed",
    quiz_language: str = "",
) -> List[QuizQuestion]:
    """Generate quiz questions from RAG-retrieved context using Gemini."""
    context_block = f"CONTENT (from: {title}):\n{context[:5000]}"
    prompt = _build_question_prompt(
        context_block=context_block,
        title=title,
        subject=subject,
        num_questions=num_questions,
        difficulty=difficulty,
        language=language,
        study_language=study_language,
        quiz_language=quiz_language,
        study_mode=study_mode,
    )
    return _parse_questions(_call_gemini(prompt))


# ── Quiz generation from topic (knowledge-based, fact-checked) ────────────
_TOPIC_ACCURACY_INSTRUCTION = """
CRITICAL ACCURACY REQUIREMENTS — YOU MUST FOLLOW THESE:
- You are generating questions PURELY from your training knowledge
- Only include facts you are HIGHLY CONFIDENT (>95% certain) are correct
- If you are even slightly unsure about a date, number, name, or attribution → SKIP that question
- Never guess or extrapolate; never combine facts in uncertain ways
- Prefer well-known, consensus facts over obscure or disputed ones
- It is FAR BETTER to generate fewer questions than to include anything inaccurate
- Do NOT hallucinate sources, quotes, or specifics you cannot verify with certainty"""


def generate_from_topic(
    topic: str,
    subject: str,
    num_questions: int,
    difficulty: str,
    language: str,
    study_language: str = "en",
    study_mode: str = "mixed",
    quiz_language: str = "",
) -> List[QuizQuestion]:
    """
    Generate factually accurate questions directly from Gemini's training knowledge.
    Uses strict accuracy constraints — only high-confidence facts become questions.
    """
    context_block = (
        f"TOPIC: {topic}\n"
        f"Generate questions about this topic using only facts you are certain are correct."
    )
    prompt = _build_question_prompt(
        context_block=context_block,
        title=topic,
        subject=subject,
        num_questions=num_questions,
        difficulty=difficulty,
        language=language,
        study_language=study_language,
        quiz_language=quiz_language,
        study_mode=study_mode,
        extra_instruction=_TOPIC_ACCURACY_INSTRUCTION,
    )
    return _parse_questions(_call_gemini(prompt))


# ── Educational resource search ──────────────────────────────────────────
def search_educational_resources(
    topic: str,
    study_language: str = "en",
    ui_language: str = "ja",
) -> list:
    """Use Gemini to suggest free educational websites and PDFs for a topic."""
    lang_name  = STUDY_LANG_NAMES.get(study_language, "English")
    hint_lang  = HINT_LANG_NAMES.get(ui_language, "Japanese")

    prompt = f"""Suggest 6-8 FREE, publicly accessible educational resources for studying {lang_name} about: "{topic}"

Return ONLY a valid JSON array (no markdown):
[
  {{
    "title": "Resource name",
    "url": "https://actual-real-url.com/page",
    "type": "website",
    "description": "Brief description in {hint_lang}"
  }}
]

Include varied resource types:
- Official language learning sites (e.g. NHK Web Easy for Japanese, BBC Learning English)
- Wikipedia articles in {lang_name}
- Free PDF textbooks or study guides (type: "pdf")
- Open university courses or lecture notes
- YouTube educational channels

Important: Only include REAL URLs that actually exist and are publicly accessible.
Descriptions must be in {hint_lang}."""

    raw = _call_gemini(prompt)
    data = _parse_json_list(raw)
    return [
        item for item in data
        if isinstance(item, dict) and item.get("title") and item.get("url")
    ]
