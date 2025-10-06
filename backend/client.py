import asyncio
import hashlib
import json
import logging
import os
import sys
from typing import Dict, Optional, Union

from websockets.asyncio.client import connect, ClientConnection
from websockets.asyncio.server import ServerConnection
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK, WebSocketException

from backend.models import ErrorPayload, ErrorCode
from common import create_body
from config import config
from crypto import (
    generate_rsa_keypair, load_private_key, load_public_key,
    rsa_encrypt, rsa_decrypt, compute_content_sig, verify_content_sig, compute_public_content_sig, aes_encrypt, aes_decrypt, verify_public_content_sig
)
from models import MsgType, current_timestamp, generate_uuid, ProtocolMessage, UserDeliverPayload, CommandResponsePayload, UserAdvertisePayload, \
    MsgDirectPayload, MsgPublicChannelPayload, CommandPayload, UserHelloPayload, UserRemovePayload, \
    FileStartPayload, FileChunkPayload, FileEndPayload

logging.basicConfig(level=config.logging_level, format=config.logging_format)
logger = logging.getLogger("Client")


class Client:
    def __init__(self, server_host: str, server_port: int, reconnect_attempts: int = 3):
        self._is_closed = False
        self.server_uri = f"ws://{server_host}:{server_port}/ws"
        self.user_id: Optional[str] = None
        self.private_key_b64: Optional[str] = None
        self.public_key_b64: Optional[str] = None
        self.websocket: Optional[Union[ClientConnection, ServerConnection]] = None
        self.known_pubkeys: Dict[str, str] = {}  # user_id -> pubkey
        self.group_keys: Dict[str, bytes] = {}  # "public" -> AES key
        self.file_transfers: Dict[str, Dict] = {}  # file_id -> {'name': str, 'chunks': Dict[int, bytes], 'size': int, 'sha256': str, 'mode': str}
        self.received_dir: str | None = None
        self._listen_task: Optional[asyncio.Task] = None
        self._reconnect_attempts = max(1, reconnect_attempts)

    def init_user(self, user_id: Optional[str] = None):
        self.user_id = user_id or generate_uuid()
        self.private_key_b64, self.public_key_b64 = generate_rsa_keypair()
        self.received_dir = os.path.join(os.getcwd(), "received", user_id)
        os.makedirs(self.received_dir, exist_ok=True)
        logger.info(f"user_id={self.user_id}")

    async def connect(self):
        """Connect once, send USER_HELLO, then start the listener task."""
        attempt = 0
        last_err: Optional[Exception] = None
        while attempt < self._reconnect_attempts:
            attempt += 1
            try:
                logger.info(f"connecting to {self.server_uri} (attempt {attempt}/{self._reconnect_attempts})")
                # Small open timeout to fail fast if server isn’t listening.
                self.websocket = await asyncio.wait_for(connect(self.server_uri, logger=logger), timeout=6)
                await self._send_user_hello()
                logger.info("connected and sent USER_HELLO")
                # Start background listener
                self._listen_task = asyncio.create_task(self.listen(), name="client-listen")
                return
            except (asyncio.TimeoutError, ConnectionClosedError, ConnectionClosedOK, WebSocketException, OSError) as e:
                last_err = e
                logger.warning(f"connect failed: {e!r}")
                await asyncio.sleep(1.0)

        # Exhausted retries
        raise RuntimeError(f"Unable to connect to {self.server_uri}") from last_err

    async def _send_user_hello(self):
        assert self.websocket is not None, "websocket not connected"
        hello_pl = UserHelloPayload(client="local-cli-v1", pubkey=self.public_key_b64).model_dump()
        body = create_body(MsgType.USER_HELLO, self.user_id, "server", hello_pl)
        await self.websocket.send(body)

    async def listen(self):
        """Background listener; exits when the socket closes."""
        assert self.websocket is not None
        ws = self.websocket
        try:
            async for message in ws:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    logger.error("Invalid JSON from server")
                    continue
                msg = ProtocolMessage(**data)
                await self.handle_message(msg)
        except (ConnectionClosedOK, ConnectionClosedError) as e:
            logger.info(f"Connection closed: {e!r}")
        except Exception as e:
            logger.error(f"Listen loop crashed: {e!r}")

    async def handle_message(self, msg: ProtocolMessage):
        mtype = msg.type

        match mtype:
            case MsgType.USER_DELIVER:
                await self._on_user_deliver(msg)
            case MsgType.COMMAND_RESPONSE:
                await self._handle_command_response(msg)
            case MsgType.USER_ADVERTISE:
                await self._handle_user_advertise(msg)
            case MsgType.USER_REMOVE:
                await self._handle_user_remove(msg)
            case MsgType.PUBLIC_CHANNEL_KEY_SHARE:
                await self._handle_public_key_share(msg)
            case MsgType.PUBLIC_CHANNEL_UPDATED:
                await self._handle_public_updated(msg)
            case MsgType.FILE_START:
                await self._handle_file_start(msg)
            case MsgType.FILE_CHUNK:
                await self._handle_file_chunk(msg)
            case MsgType.FILE_END:
                await self._handle_file_end(msg)
            case MsgType.ERROR:
                await self._handle_error(msg)
            case _:
                logger.error(f"Unknown message type: {mtype} for request: {msg}")

    async def _on_user_deliver(self, data: ProtocolMessage):
        payload = UserDeliverPayload(**data.payload)
        try:
            ciphertext = payload.ciphertext
            sender_id = payload.sender
            sender_pub = payload.sender_pub

            # Try to decrypt as DM first
            try:
                plaintext = rsa_decrypt(load_private_key(self.private_key_b64), ciphertext)
                # Verify sig for DM
                if verify_content_sig(load_public_key(sender_pub), ciphertext, sender_id, data.to, data.ts, payload.content_sig):
                    print(f"[DM] {sender_id}: {plaintext.decode('utf-8', errors='replace')}")
                    return
            except Exception:
                pass  # Not a DM

            # Try to decrypt as public message
            if "public" not in self.group_keys:
                logger.error("No group key for public, message discarded")
                return
            else:
                try:
                    plaintext = aes_decrypt(self.group_keys["public"], ciphertext)
                    # Verify sig for public
                    if verify_public_content_sig(load_public_key(sender_pub), ciphertext, sender_id, data.ts, payload.content_sig):
                        print(f"[PUB] {sender_id}: {plaintext.decode('utf-8', errors='replace')}")
                        return
                except Exception as e:
                    logger.error(f"Failed to decrypt public message: {e!r}")

            logger.error("Unable to decrypt message: neither DM nor public")
        except Exception as e:
            logger.exception(f"message processing failed: {e!r}")

    async def _handle_command_response(self, data: ProtocolMessage):
        payload = CommandResponsePayload(**data.payload)
        command = payload.command
        response = json.loads(payload.response)
        match command:
            case "/list":
                users = response.get("users", [])
                logger.info("Online users: %s", ", ".join(users))
            case _:
                logger.error(f"Unknown command response: {command}")

    async def _handle_user_advertise(self, data: ProtocolMessage):
        payload = UserAdvertisePayload(**data.payload)
        uid = payload.user_id
        pub = payload.pubkey
        if uid and pub:
            exists = uid in self.known_pubkeys
            self.known_pubkeys[uid] = pub
            if not exists:
                logger.info("user online: %s", uid)

    async def _handle_user_remove(self, data: ProtocolMessage):
        try:
            pl = UserRemovePayload(**data.payload)
            if pl.user_id not in self.known_pubkeys:
                return
            self.known_pubkeys.pop(pl.user_id, None)
            logger.info("User offline: %s", pl.user_id)
        except Exception as e:
            logger.error(f"Bad USER_REMOVE payload: {e!r}")

    async def _handle_public_updated(self, data: ProtocolMessage):
        pass

    async def _handle_public_key_share(self, data: ProtocolMessage):
        from models import PublicChannelKeySharePayload
        payload = PublicChannelKeySharePayload(**data.payload)
        for share in payload.shares:
            if share['member'] == self.user_id:
                wrapped = share['wrapped_public_channel_key']
                try:
                    group_key = rsa_decrypt(load_private_key(self.private_key_b64), wrapped)
                    self.group_keys["public"] = group_key
                    logger.info("Received group key for public channel")
                except Exception as e:
                    logger.error(f"Failed to decrypt public channel key: {e!r}")
                break

    async def _handle_file_start(self, msg):
        payload = FileStartPayload(**msg.payload)
        file_id = payload.file_id
        self.file_transfers[file_id] = {
            'name': payload.name,
            'chunks': {},
            'size': payload.size,
            'sha256': payload.sha256,
            'mode': payload.mode
        }
        logger.info(f"Receiving file: {payload.name} ({payload.size} bytes)")

    async def _handle_file_chunk(self, msg):
        payload = FileChunkPayload(**msg.payload)
        file_id = payload.file_id
        transfer = self.file_transfers.get(file_id)
        if not transfer:
            return
        index = payload.index
        ciphertext = payload.ciphertext
        try:
            if transfer['mode'] == "public":
                plaintext = aes_decrypt(self.group_keys["public"], ciphertext)
            else:
                plaintext = rsa_decrypt(load_private_key(self.private_key_b64), ciphertext)
            transfer['chunks'][index] = plaintext
        except Exception as e:
            logger.error(f"Failed to decrypt chunk {index} for {file_id}: {e!r}")

    async def _handle_file_end(self, msg):
        payload = FileEndPayload(**msg.payload)
        file_id = payload.file_id
        transfer = self.file_transfers.pop(file_id, None)
        if not transfer:
            return
        chunks = transfer['chunks']
        expected_sha = transfer['sha256']
        expected_size = transfer['size']
        # sort by index
        keys = sorted(chunks.keys())
        data = b''.join(chunks[i] for i in keys)
        if len(data) != expected_size:
            logger.error(f"File {transfer['name']} size mismatch: got {len(data)}, expected {expected_size}")
            return
        actual_sha = hashlib.sha256(data).hexdigest()
        if actual_sha != expected_sha:
            logger.error(f"File {transfer['name']} hash mismatch")
            return
        # save
        safe_name = os.path.basename(transfer['name'])
        file_path = os.path.join(self.received_dir, safe_name)
        try:
            with open(file_path, 'wb') as f:
                f.write(data)
            logger.info(f"File saved: {file_path}")
        except Exception as e:
            logger.error(f"Failed to save file {file_path}: {e!r}")

    async def _handle_error(self, msg):
        payload = ErrorPayload(**msg.payload)
        match payload.code:
            case ErrorCode.NAME_IN_USE:
                logger.error("Name already in use. Exiting...")
                await self.close()
                self._is_closed = True
            case _:
                logger.error(f"ERROR: {payload}")

    async def send_command(self, line: str):
        if not self.websocket:
            logger.error("not connected")
            return

        parts = line.split()
        if not parts:
            return
        cmd = parts[0]

        if cmd == "/tell" and len(parts) >= 3:
            target = parts[1]
            msg_text = " ".join(parts[2:])
            if target not in self.known_pubkeys:
                logger.error("Unknown user: %s", target)
                return
            target_pk = load_public_key(self.known_pubkeys[target])
            ciphertext = rsa_encrypt(target_pk, msg_text.encode("utf-8"))
            ts = current_timestamp()
            content_sig = compute_content_sig(load_private_key(self.private_key_b64), ciphertext, self.user_id, target, ts)
            dm_pl = MsgDirectPayload(ciphertext=ciphertext, sender_pub=self.public_key_b64, content_sig=content_sig).model_dump()
            body = create_body(MsgType.MSG_DIRECT, self.user_id, target, dm_pl, ts=ts)
            await self.websocket.send(body)
            return

        if cmd == "/all" and len(parts) >= 2:
            msg_text = " ".join(parts[1:])
            if "public" not in self.group_keys:
                logger.error("No group key for public channel")
                return
            ciphertext = aes_encrypt(self.group_keys['public'], msg_text.encode("utf-8"))
            ts = current_timestamp()
            content_sig = compute_public_content_sig(load_private_key(self.private_key_b64), ciphertext, self.user_id, ts)
            pub_pl = MsgPublicChannelPayload(ciphertext=ciphertext, sender_pub=self.public_key_b64, content_sig=content_sig).model_dump()
            body = create_body(MsgType.MSG_PUBLIC_CHANNEL, self.user_id, "public", pub_pl, ts=ts)
            await self.websocket.send(body)
            return

        if cmd == "/list":
            comm_pl = CommandPayload(command="/list").model_dump()
            body = create_body(MsgType.COMMAND, self.user_id, "server", comm_pl)
            await self.websocket.send(body)
            return

        if cmd == "/file" and len(parts) >= 3:
            mode = parts[1]
            if mode == "dm" and len(parts) >= 4:
                target = parts[2]
                file_path = " ".join(parts[3:])
                await self._send_file(mode, target, file_path)
            elif mode == "public" and len(parts) >= 3:
                file_path = " ".join(parts[2:])
                await self._send_file(mode, "public", file_path)
            else:
                logger.error("Invalid /file command. Use /file dm <user> <path> or /file public <path>")
            return

        logger.error("Unknown command: %s", cmd)

    async def _send_file(self, mode, to, path):
        if not os.path.isfile(path):
            logger.error("File not found: %s", path)
            return
        file_id = generate_uuid()
        name = os.path.basename(path)
        with open(path, "rb") as f:
            data = f.read()
        size = len(data)
        sha256 = hashlib.sha256(data).hexdigest()
        # send FILE_START
        start_pl = FileStartPayload(file_id=file_id, name=name, size=size, sha256=sha256, mode=mode).model_dump()
        body = create_body(MsgType.FILE_START, self.user_id, to, start_pl)
        await self.websocket.send(body)
        # chunk data
        chunk_size = 400
        chunks = [data[i:i + chunk_size] for i in range(0, len(data), chunk_size)]
        for index, chunk in enumerate(chunks):
            if mode == "public":
                ciphertext = aes_encrypt(self.group_keys['public'], chunk)
                content_sig = compute_public_content_sig(load_private_key(self.private_key_b64), ciphertext, self.user_id, current_timestamp())
            else:
                if to not in self.known_pubkeys:
                    logger.error("Unknown user: %s", to)
                    return
                target_pk = load_public_key(self.known_pubkeys[to])
                ciphertext = rsa_encrypt(target_pk, chunk)
                ts = current_timestamp()
                content_sig = compute_content_sig(load_private_key(self.private_key_b64), ciphertext, self.user_id, to, ts)
            chunk_pl = FileChunkPayload(file_id=file_id, index=index, ciphertext=ciphertext).model_dump()
            ts = current_timestamp()
            body = create_body(MsgType.FILE_CHUNK, self.user_id, to, chunk_pl, ts=ts)
            await self.websocket.send(body)
        # send FILE_END
        end_pl = FileEndPayload(file_id=file_id).model_dump()
        body = create_body(MsgType.FILE_END, self.user_id, to, end_pl)
        await self.websocket.send(body)
        logger.info("File sent: %s", path)

    async def close(self):
        """Close the socket and cancel listener."""
        try:
            if self._listen_task and not self._listen_task.done():
                self._listen_task.cancel()
                try:
                    await self._listen_task
                except asyncio.CancelledError:
                    pass
        finally:
            if self.websocket:
                try:
                    await self.websocket.close()
                except Exception:
                    logger.debug("close() failed", exc_info=True)
            self.websocket = None
            self._is_closed = True

    async def is_closed(self):
        return self.websocket is None or self._is_closed


async def interactive_client():
    # Resolve host/port/user from CLI or env; defaults align with server defaults.
    host = os.getenv("SERVER_HOST", "127.0.0.1")
    port = int(os.getenv("SERVER_PORT", "8080"))
    uid = None

    # CLI: python client.py [user_id] [host] [port]
    if len(sys.argv) >= 2 and sys.argv[1]:
        uid = sys.argv[1]
    if len(sys.argv) >= 3 and sys.argv[2]:
        host = sys.argv[2]
    if len(sys.argv) >= 4 and sys.argv[3]:
        try:
            port = int(sys.argv[3])
        except ValueError:
            logger.error("Invalid port: %s", sys.argv[3])

    client = Client(server_host=host, server_port=port, reconnect_attempts=3)
    client.init_user(uid)

    try:
        await client.connect()
    except Exception as e:
        logger.error("giving up connecting to %s:%s: %r", host, port, e)
        return

    await asyncio.sleep(1.0) # wait a bit

    if await client.is_closed():
        logger.error("CONNECTION CLOSED")
        return

    print("Commands:")
    print("- /list")
    print("- /tell <user> <msg>")
    print("- /all <msg>")
    print("- /file dm <user> <file path>")
    print("- /file public <file path>")
    print("- /quit")

    loop = asyncio.get_running_loop()
    try:
        while True:
            try:
                line = await loop.run_in_executor(None, input, "")
            except EOFError:
                break
            line = (line or "").strip()
            if not line:
                continue
            if line == "/quit":
                break
            await client.send_command(line)
    except KeyboardInterrupt:
        pass
    except Exception as e:
        logger.error(f"Interactive loop error: {e!r}")
    finally:
        await client.close()


if __name__ == "__main__":
    try:
        asyncio.run(interactive_client())
    except KeyboardInterrupt:
        print()
