import json
import logging
import os
from typing import List, Dict, Any


class Config:
    def __init__(self):
        # Core server settings
        self.host: str = os.getenv("HOST", "0.0.0.0")
        self.port: int = int(os.getenv("PORT", "8081"))
        self.logging_level = logging.INFO
        self.logging_format = "[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s"

        # DB
        self.db_path: str = os.getenv("DB_PATH", "chat.db")

        # Health
        self.heartbeat_interval: int = int(os.getenv("HEARTBEAT_INTERVAL", "15"))  # seconds
        self.timeout_threshold: int = int(os.getenv("TIMEOUT_THRESHOLD", "45"))  # seconds

        # Introducer JSON file (preferred)
        introducer_json_path = os.getenv("INTRODUCERS_JSON", "introducers.json")
        self.bootstrap_servers: List[Dict[str, Any]] = []
        try:
            with open(introducer_json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.bootstrap_servers = data.get("bootstrap_servers", [])
        except Exception:
            # Fallback to envs (compatible with old scripts)
            self.bootstrap_servers = [
                {
                    "host": os.getenv("BOOTSTRAP_HOST_1", "127.0.0.1").strip(),
                    "port": int(os.getenv("BOOTSTRAP_PORT_1", "8000").strip()),
                    "pubkey": os.getenv("BOOTSTRAP_PUBKEY_1", "")
                },
                {
                    "host": os.getenv("BOOTSTRAP_HOST_2", "127.0.0.1").strip(),
                    "port": int(os.getenv("BOOTSTRAP_PORT_2", "8001").strip()),
                    "pubkey": os.getenv("BOOTSTRAP_PUBKEY_2", "")
                },
                {
                    "host": os.getenv("BOOTSTRAP_HOST_3", "127.0.0.1").strip(),
                    "port": int(os.getenv("BOOTSTRAP_PORT_3", "8002").strip()),
                    "pubkey": os.getenv("BOOTSTRAP_PUBKEY_3", "")
                }
            ]


config = Config()
