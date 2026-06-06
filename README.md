# 🎓 AI Quiz App

**あらゆる教材からAIが問題を自動生成する学習アプリ**

[![CI](https://github.com/LincolnMM07/ai-quiz-app/actions/workflows/ci.yml/badge.svg)](https://github.com/LincolnMM07/ai-quiz-app/actions)
[![Python](https://img.shields.io/badge/Python-3.11-blue)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-green)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18-61DAFB)](https://react.dev)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## 🌐 ライブデモ

> **→ [https://ai-quiz-app.vercel.app](https://ai-quiz-app.vercel.app)**
>
> ※ バックエンドは Render 無料枠のため、**初回アクセスは30〜60秒** かかる場合があります（スリープ解除のため）。

---

## ✨ 機能

| 機能 | 説明 |
|------|------|
| 📚 マルチ科目対応 | 英語・日本語・スペイン語・数学・歴史・理科・プログラミング・TOEIC など12科目 |
| 🧠 RAGパイプライン | PDF/URLをベクトル化して関連箇所を抽出し、高品質な問題を生成 |
| 🎥 YouTube字幕対応 | 動画の字幕から自動で問題生成 |
| 🎵 歌詞対応 | 洋楽・邦楽・ポルトガル語楽曲の歌詞から語学問題を生成 |
| 💾 問題プールシステム | 同一ソースから100問生成・DB保存 → 2回目以降はAPI不使用で即時提供 |
| 🔊 Neural音声 | Microsoft Edge TTSによるネイティブ品質のTTS（通常・スロー速度） |
| 📊 学習履歴 | 全セッションをDBに永続化、正解率・学習統計を表示 |
| 🃏 フラッシュカードモード | 問題/解答のフリップカード練習 |
| ⏱ タイマーモード | 制限時間付きで緊張感のある学習 |
| 🔀 シャッフルモード | ランダム順で繰り返し練習 |
| 🌐 7言語UI | 日本語・英語・スペイン語・フランス語・韓国語・中国語・ポルトガル語 |

---

## 🏗️ アーキテクチャ

```
┌──────────────────────────────────────────────────────────┐
│  React + TypeScript  (Vercel — 無料)                      │
│  科目選択 / 素材入力 / クイズUI / 音声再生 / 7言語i18n     │
└──────────────────────┬───────────────────────────────────┘
                       │ REST API
┌──────────────────────▼───────────────────────────────────┐
│  FastAPI (Python 3.11)  (Render.com — 無料枠)             │
│                                                           │
│  ┌─────────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ RAGパイプライン  │  │ 問題生成     │  │ TTS         │  │
│  │ ChromaDB        │  │ Gemini 2.5   │  │ Edge TTS    │  │
│  └────────┬────────┘  └──────────────┘  └─────────────┘  │
│           │                                               │
│  ┌────────▼──────────────────────────────────────────┐   │
│  │  問題プールシステム                                 │   │
│  │  同一ソース → 100問生成・保存 → 再利用（API節約）   │   │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  PostgreSQL  (Neon — 無料枠)                               │
│  quiz_sessions / question_pool テーブル                    │
└──────────────────────────────────────────────────────────┘
```

---

## 🚀 ローカル開発

```bash
git clone https://github.com/LincolnMM07/ai-quiz-app.git
cd ai-quiz-app

# バックエンド
cd backend
pip install -r requirements.txt
cp .env.example .env          # GOOGLE_API_KEY を入力
uvicorn app.main:app --reload  # → http://localhost:8000

# フロントエンド（別ターミナル）
cd ../frontend
npm install
cp .env.example .env          # VITE_API_URL=http://localhost:8000 のまま
npm run dev                    # → http://localhost:3000
```

---

## ☁️ 本番デプロイ（全て無料）

### Step 1 — Neon（PostgreSQL）

1. [neon.tech](https://neon.tech) でアカウント作成
2. **New Project** → データベース名: `ai_quiz`
3. **Connection String** をコピー（後で使用）
   ```
   postgresql://user:pass@ep-xxxx.region.aws.neon.tech/ai_quiz?sslmode=require
   ```

### Step 2 — GitHub

```bash
# GitHubで新しいリポジトリを作成後:
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/あなたのユーザー名/ai-quiz-app.git
git push -u origin main
```

### Step 3 — Render（バックエンド）

1. [render.com](https://render.com) でアカウント作成
2. **New → Web Service** → GitHubリポジトリを接続
3. 以下を設定:

| 項目 | 値 |
|------|-----|
| Root Directory | `backend` |
| Runtime | `Python 3` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |

4. **Environment Variables** を追加:

| 変数名 | 値 |
|--------|-----|
| `DATABASE_URL` | Step 1 の Neon 接続文字列 |
| `GOOGLE_API_KEY` | Google AI Studio の APIキー |
| `CORS_ORIGINS` | （Step 4 で Vercel URL 確定後に設定） |

5. **Deploy** → デプロイURL をメモ（例: `https://ai-quiz-backend.onrender.com`）

### Step 4 — Vercel（フロントエンド）

1. [vercel.com](https://vercel.com) でアカウント作成
2. **New Project** → GitHubリポジトリをインポート
3. **Root Directory** を `frontend` に変更
4. **Environment Variables** を追加:

| 変数名 | 値 |
|--------|-----|
| `VITE_API_URL` | Step 3 の Render URL（例: `https://ai-quiz-backend.onrender.com`） |

5. **Deploy** → Vercel URL をメモ（例: `https://ai-quiz-app.vercel.app`）

### Step 5 — CORS の設定（最後）

Render ダッシュボード → Environment → `CORS_ORIGINS` を Vercel URL に更新 → **Manual Deploy**

---

## 🛠️ 技術スタック

| カテゴリ | 技術 |
|---------|------|
| バックエンド | FastAPI, Python 3.11, Pydantic v2 |
| AI / LLM | Google Gemini 2.5 Flash（無料枠 500回/日） |
| RAG / Vector DB | ChromaDB, LangChain Text Splitters |
| データベース | PostgreSQL (Neon), SQLAlchemy 2.0 |
| 音声合成 | Microsoft Edge TTS (Neural) |
| フロントエンド | React 18, TypeScript, Tailwind CSS v3, Vite |
| インフラ | Docker, Docker Compose, GitHub Actions CI |
| デプロイ | Render（API）+ Vercel（Frontend）+ Neon（DB）— 全て無料枠 |

---

## 📁 プロジェクト構成

```
ai-quiz-app/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI エントリーポイント
│   │   ├── core/
│   │   │   ├── config.py        # 設定管理（pydantic-settings）
│   │   │   └── database.py      # SQLAlchemy + QuizSession / QuestionPool
│   │   ├── routers/
│   │   │   ├── quiz.py          # 問題生成・プール管理・セッション保存
│   │   │   ├── sources.py       # PDF / YouTube / URL 抽出
│   │   │   ├── audio.py         # TTS エンドポイント
│   │   │   └── lyrics.py        # 歌詞検索エンドポイント
│   │   ├── models/
│   │   │   └── quiz.py          # Pydantic モデル
│   │   └── services/
│   │       ├── rag.py           # RAGパイプライン（ChromaDB）
│   │       ├── gemini.py        # Gemini API + マルチ科目プロンプト
│   │       ├── tts.py           # Edge TTS
│   │       └── sources.py       # PDF / YouTube / URL 抽出ロジック
│   ├── tests/
│   │   └── test_api.py
│   ├── Dockerfile
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── api/client.ts        # APIクライアント（axios）
│   │   ├── pages/
│   │   │   ├── Home.tsx         # 素材入力・設定・統計ダッシュボード
│   │   │   └── Quiz.tsx         # クイズ・フラッシュカード・結果画面
│   │   ├── i18n.ts              # 7言語対応
│   │   └── App.tsx
│   ├── vercel.json              # Vercel SPA ルーティング設定
│   ├── Dockerfile
│   └── package.json
├── render.yaml                  # Render デプロイ設定
├── docker-compose.yml
└── README.md
```

---

## 🧪 テスト

```bash
cd backend
pytest tests/ -v
```

---

## 👤 Author

**Lincoln Masuyama（増山リンコン正義）**
Full-Stack Engineer / AI Application Developer

- 🌐 Trilingual: 🇧🇷 Portuguese / 🇯🇵 Japanese N1 / 🇪🇸 Spanish
- 🐙 [GitHub](https://github.com/LincolnMM07)

---

## 📄 License

MIT License
