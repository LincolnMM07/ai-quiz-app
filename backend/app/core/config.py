from __future__ import annotations
from typing import List
from pydantic_settings import BaseSettings
from pydantic import field_validator


class Settings(BaseSettings):
    google_api_key: str = ""
    vagalume_api_key: str = ""
    database_url: str = "sqlite:///./quiz.db"
    cors_origins: List[str] = ["http://localhost:3000"]
    app_env: str = "development"
    chroma_path: str = "./chroma_db"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, v):
        # Accept both JSON array and comma-separated string
        # e.g. CORS_ORIGINS=http://localhost:3000
        # or   CORS_ORIGINS=["http://localhost:3000","http://localhost:5173"]
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                import json
                return json.loads(v)
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v

    class Config:
        env_file = ".env"


settings = Settings()
