import os
from typing import List, Dict, Any

class Config:
    def __init__(self):
        # Server configuration
        self.host: str = os.getenv("SOCP_HOST", "0.0.0.0")
        self.port: int = int(os.getenv("SOCP_PORT", "8080"))
        self.is_introducer: bool = os.getenv("SOCP_IS_INTRODUCER", "false").lower() == "true"

        # Bootstrap servers (introducers)
        self.bootstrap_servers: List[Dict[str, Any]] = [
            {
                "host": os.getenv("BOOTSTRAP_HOST_1", "127.0.0.1").strip(),
                "port": int(os.getenv("BOOTSTRAP_PORT_1", "8082").strip()),
                "pubkey": os.getenv("BOOTSTRAP_PUBKEY_1")  # base64url encoded
            },
            {
                "host": os.getenv("BOOTSTRAP_HOST_2", "127.0.0.1").strip(),
                "port": int(os.getenv("BOOTSTRAP_PORT_2", "8082").strip()),
                "pubkey": os.getenv("BOOTSTRAP_PUBKEY_2")
            },
            {
                "host": os.getenv("BOOTSTRAP_HOST_3", "127.0.0.1").strip(),
                "port": int(os.getenv("BOOTSTRAP_PORT_3", "8083").strip()),
                "pubkey": os.getenv("BOOTSTRAP_PUBKEY_3")
            }
        ]

        # Database
        self.db_path: str = os.getenv("SOCP_DB_PATH", "socp.db")

        # Heartbeat settings
        self.heartbeat_interval: int = int(os.getenv("HEARTBEAT_INTERVAL", "15"))  # seconds
        self.timeout_threshold: int = int(os.getenv("TIMEOUT_THRESHOLD", "45"))  # seconds

config = Config()
