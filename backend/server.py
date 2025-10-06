import asyncio
import json
import logging
import time
from typing import Dict, Tuple, Optional

from websockets.asyncio.client import connect, ClientConnection
from websockets.asyncio.server import ServerConnection
from websockets.exceptions import (
    ConnectionClosedError,
    ConnectionClosedOK,
    WebSocketException,
)

from base_server import BaseServer
from common import Peer, create_body
from config import config
from crypto import load_private_key, compute_transport_sig, compute_key_share_sig, rsa_decrypt
from database import Database
from models import (
    MsgType, ErrorCode,
    ProtocolMessage,
    ServerHelloJoinPayload, ServerAnnouncePayload, ServerWelcomePayload, ServerGoodbyePayload,
    UserAdvertisePayload, UserRemovePayload, ServerDeliverPayload, UserHelloPayload, MsgDirectPayload,
    MsgPublicChannelPayload, ErrorPayload,
    UserDeliverPayload, CommandPayload,
    ServerType, CommandResponsePayload,
    PublicChannelUpdatedPayload, PublicChannelKeySharePayload,
    FileStartPayload, FileChunkPayload, FileEndPayload, current_timestamp
)


class Server(BaseServer):

    def __init__(self):
        super().__init__(
            server_type=ServerType.SERVER,
            logger=logging.getLogger("Server"),
            ping_interval=config.heartbeat_interval,
            ping_timeout=config.timeout_threshold
        )
        self.db = Database(config.db_path)
        self.introducer_ws: ClientConnection | None = None

        # remote servers
        self.server_addrs: Dict[str, Tuple[str, int]] = {}  # sid -> (host, port)

        # local presence + routing (user clients)
        self.local_users: Dict[str, ServerConnection] = {}  # user_id -> ws
        self.user_locations: Dict[str, str] = {}  # user_id -> "local" | f"server_id"
        self.ws_to_user: Dict[ServerConnection, str] = {}

        # duplicate suppression for forwarded deliveries
        self.seen_ids: set[str] = set()

    async def on_start(self):
        self._bg_tasks.add(asyncio.create_task(self.bootstrap_to_network(), name="bootstrap"))

    async def on_shutdown(self, reason: str):
        await self._broadcast_goodbye(reason=reason)

    async def on_shutdown_cleanup(self):
        # close local user sockets
        for uid, ws in list(self.local_users.items()):
            try:
                await ws.close()
            except Exception as e:
                self.logger.error(f"[CLOSE] closing user {uid} failed: {e!r}")

        self.local_users.clear()

    # executed on startup - connect with an introducer and link with servers and get a list of connected clients
    async def bootstrap_to_network(self):
        self.logger.info("[BOOTSTRAP] Starting bootstrap to introducers...")
        backoff = 2
        for attempt in range(1, 6):
            for introducer in config.bootstrap_servers:
                host, port = introducer.get("host"), introducer.get("port")
                if not host or not port:
                    continue
                uri = f"ws://{host}:{port}/ws"
                try:
                    async for ws in connect(uri, logger=self.logger):
                        # send SERVER_HELLO_JOIN to introducer
                        payload = ServerHelloJoinPayload(
                            host=config.host, port=config.port, pubkey=self.server_public_key
                        ).model_dump()
                        sig = compute_transport_sig(load_private_key(self.server_private_key), payload)
                        req = create_body(MsgType.SERVER_HELLO_JOIN, self.server_id, f"{host}:{port}", payload, sig)
                        await ws.send(req)
                        self.logger.info(f"[BOOTSTRAP] Sent SERVER_HELLO_JOIN to Introducer at {uri}")

                        # receive SERVER_WELCOME from introducer
                        raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
                        raw_json = json.loads(raw)
                        data = ProtocolMessage(**raw_json)
                        if data.type != MsgType.SERVER_WELCOME:
                            self.logger.warning(
                                f"[BOOTSTRAP] Unexpected response: {data.get('type')} was expecting SERVER_WELCOME from Introducer")
                            continue

                        welcome = ServerWelcomePayload(**data.payload)
                        self.server_id = welcome.assigned_id
                        self.introducer_ws = ws
                        self.logger.info(f"[BOOTSTRAP] Assigned ID: {self.server_id}")
                        self.logger.info("[BOOTSTRAP] Introducer connection successful")

                        # connect to other servers on the network by sending SERVER_ANNOUNCE
                        remote_servers_cnt = len(welcome.servers)
                        if remote_servers_cnt > 0:
                            self.logger.info(
                                f"[BOOTSTRAP] Connecting to remote servers ({remote_servers_cnt} found)...")
                        else:
                            self.logger.info("[BOOTSTRAP] No remote servers found...")

                        for si in welcome.servers:
                            await self._connect_to_server(si.server_id, si.host, int(si.port), si.pubkey)

                        # maintain a list of clients connected already
                        remote_clients_cnt = len(welcome.clients)
                        if remote_clients_cnt > 0:
                            self.logger.info(f"[BOOTSTRAP] Got {remote_clients_cnt} remote clients...")
                        else:
                            self.logger.info("[BOOTSTRAP] No remote clients found...")

                        for ci in welcome.clients:
                            self.user_locations[ci.user_id] = ci.server_id
                            # Add to db for pubkey access
                            self.db.add_user(ci.user_id, ci.pubkey, "", "", {})

                        self.logger.info("[BOOTSTRAP] Bootstrap complete")

                        # wait for this connection to close
                        await ws.wait_closed()

                        # when we get here, the async-for will attempt a reconnect
                except (asyncio.TimeoutError, ConnectionClosedError, ConnectionClosedOK, WebSocketException) as e:
                    self.logger.warning(f"[BOOTSTRAP] {uri} failed: {e!r}")
                except Exception as e:
                    self.logger.error(f"[BOOTSTRAP] {uri} unexpected error: {e!r}")

            self.logger.info(f"[BOOTSTRAP] Retry in {backoff}s (attempt {attempt}/5)")
            await asyncio.sleep(backoff)
            backoff *= 2

        self.logger.warning("[BOOTSTRAP] All introducers unreachable; operating standalone for now.")

    async def _connect_to_server(self, sid: str, host: str, port: int, pubkey: Optional[str]):
        uri = f"ws://{host}:{port}/ws"
        try:
            # connect to the remote server
            ws: ClientConnection = await connect(uri, logger=self.logger)
            peer = Peer(sid=sid, ws=ws, host=host, port=port, pubkey=pubkey, outbound=True)
            self.peers[sid] = peer
            self.server_addrs[sid] = (host, port)

            # send SERVER_ANNOUNCE to the remote server
            payload = ServerAnnouncePayload(
                host=config.host,
                port=config.port,
                pubkey=self.server_public_key,
            ).model_dump()
            sig = compute_transport_sig(load_private_key(self.server_private_key), payload)
            req = create_body(MsgType.SERVER_ANNOUNCE, self.server_id, sid, payload, sig)
            await ws.send(req)

            # start listener for that server
            self._bg_tasks.add(asyncio.create_task(self._listen_server(peer), name=f"listen-{sid}"))
            self.logger.info(f"[LINK] Connected to {sid} @ {host}:{port}")
        except (ConnectionClosedError, ConnectionClosedOK, WebSocketException) as e:
            self.logger.error(f"[LINK] Failed to connect {uri}: {e!r}")
            self._forget_peer(sid)
        except Exception as e:
            self.logger.error(f"[LINK] Failed to connect {uri}: {e!r}")
            self._forget_peer(sid)

    async def _broadcast_goodbye(self, reason: str = "shutdown"):
        payload = ServerGoodbyePayload(reason=reason).model_dump()
        for sid, p in self.peers.items():
            req = create_body(MsgType.SERVER_GOODBYE, self.server_id, sid, payload)
            try:
                await p.ws.send(req)
            except Exception:
                pass

    # ---------- peer close ----------
    def _forget_peer(self, sid: str):
        self.peers.pop(sid, None)

    # ---------- incoming handling ----------
    async def handle_incoming(self, websocket: ServerConnection, req_type: str, data: ProtocolMessage):
        await self._handle(websocket, req_type, data)

    async def on_client_disconnect(self, websocket: ServerConnection):
        user_id = self.ws_to_user.get(websocket)
        if user_id:
            await self._cleanup_local_user(user_id, reason="socket-closed", is_remote_call=False)

    async def _listen_server(self, peer: Peer):
        sid = peer.sid
        try:
            async for raw in peer.ws:
                try:
                    raw_json = json.loads(raw)
                except json.JSONDecodeError as e:
                    self.logger.error(f"[LISTEN {sid}] invalid JSON: {e!r}")
                    continue

                pr = self.peers.get(sid)
                if pr:
                    pr.last_seen = time.time()
                    pr.missed = 0

                try:
                    data = ProtocolMessage(**raw_json)
                    await self._handle(pr.ws, data.type, data)
                except Exception as e:
                    self.logger.error(f"[LISTEN {sid}] handler error: {e!r}")
        except (ConnectionClosedError, ConnectionClosedOK) as e:
            self.logger.info(f"[LISTEN {sid}] connection closed: {e!r}")
            await self._on_peer_closed(sid)
        except WebSocketException as e:
            self.logger.warning(f"[LISTEN {sid}] websocket error: {e!r}")
        except Exception as e:
            self.logger.error(f"[LISTEN {sid}] unexpected failure: {e!r}")

    async def _handle(self, websocket: ServerConnection, req_type: str, data: ProtocolMessage):
        if req_type != MsgType.HEARTBEAT:
            self.logger.info(f"[INCOMING] Request: {data}")

        match req_type:
            case MsgType.SERVER_DELIVER:
                await self._handle_server_deliver(data)
            case MsgType.SERVER_ANNOUNCE:
                await self._handle_server_announce(websocket, data)
            case MsgType.SERVER_GOODBYE:
                await self._handle_server_goodbye(data)
                await websocket.close()
            case MsgType.USER_ADVERTISE:
                await self._handle_user_advertise(data)
            case MsgType.USER_REMOVE:
                await self._handle_user_remove(data)
            case _:  # assume user message
                await self._handle_user_connection(websocket, req_type, data)

    async def _handle_server_deliver(self, data: ProtocolMessage):
        try:
            payload = ServerDeliverPayload(**data.payload)
            key = f"{data.ts}_{data.from_}_{data.to}_{hash(json.dumps(data.payload, sort_keys=True))}"
            if key in self.seen_ids:
                return
            self.seen_ids.add(key)

            if payload.user_id in self.local_users:
                deliver_pl = UserDeliverPayload(
                    ciphertext=payload.ciphertext,
                    sender=payload.sender,
                    sender_pub=payload.sender_pub,
                    content_sig=payload.content_sig
                ).model_dump()
                sig = compute_transport_sig(load_private_key(self.server_private_key), deliver_pl)
                req = create_body(MsgType.USER_DELIVER, self.server_id, payload.user_id, deliver_pl, sig, ts=data.ts)
                try:
                    await self.local_users[payload.user_id].send(req)
                except Exception as e:
                    self.logger.error(f"[FWD] deliver to {payload.user_id} failed: {e!r}")
        except Exception as e:
            self.logger.error(f"[FWD] server_deliver failed: {e!r}")

    async def _handle_server_announce(self, websocket: ServerConnection, data: ProtocolMessage):
        try:
            pl = ServerAnnouncePayload(**data.payload)
            sid = data.from_

            is_new_server = sid not in self.peers

            if sid in self.peers:
                peer = self.peers[sid]
                peer.ws = websocket
                peer.host = pl.host
                peer.port = pl.port
                peer.pubkey = pl.pubkey
                peer.last_seen = time.time()
                peer.missed = 0
            else:
                self.peers[sid] = Peer(sid=sid, ws=websocket, host=pl.host, port=pl.port, pubkey=pl.pubkey)

            self.server_addrs[sid] = (pl.host, pl.port)

            # If this is a new server (first connection), send current public channel state
            if is_new_server:
                await self._send_public_channel_to_server(sid)
        except Exception as e:
            self.logger.error(f"[ANNOUNCE] failed: {e!r}")

    async def _handle_server_goodbye(self, data: ProtocolMessage):
        try:
            sid = data.from_
            await self._on_peer_closed(sid)
        except Exception as e:
            self.logger.error(f"[GOODBYE] failed: {e!r}")

    async def _handle_user_advertise(self, data: ProtocolMessage):
        try:
            payload = UserAdvertisePayload(**data.payload)
            origin_sid = data.from_
            self.user_locations[payload.user_id] = origin_sid
            # save or update remote user to db
            self.db.add_user(payload.user_id, payload.pubkey, "", "", payload.meta or {})
            self.logger.info(f"[GOSSIP] user {payload.user_id} @ server {origin_sid}")
            # advertise to local clients about this new user
            await self._broadcast_local_user_advertise(payload.user_id, payload.pubkey)
        except Exception as e:
            self.logger.error(f"[GOSSIP] user_advertise failed: {e!r}")

    async def _handle_user_remove(self, data: ProtocolMessage):
        try:
            payload = UserRemovePayload(**data.payload)
            origin_sid = data.from_
            user_id = payload.user_id
            if self.user_locations.get(user_id) == origin_sid:
                await self._cleanup_local_user(user_id, reason=f"gossip-removed-by-{origin_sid}", is_remote_call=True)
                self.logger.info(f"[GOSSIP] user {payload.user_id} removed")
                await self._broadcast_local_user_remove(user_id)
        except Exception as e:
            self.logger.error(f"[GOSSIP] _handle_user_remove failed: {e!r}")

    async def _handle_user_connection(self, websocket: ServerConnection, req_type: str, data: ProtocolMessage):
        try:
            match req_type:
                case MsgType.USER_HELLO:
                    await self._handle_user_hello(websocket, data)
                case MsgType.MSG_DIRECT:
                    await self._handle_msg_direct(data)
                case MsgType.MSG_PUBLIC_CHANNEL:
                    await self._handle_msg_public(data)
                case MsgType.COMMAND:
                    await self._handle_command(websocket, data)
                case MsgType.PUBLIC_CHANNEL_UPDATED:
                    await self._handle_public_channel_updated(data)
                    await self._forward_public_channel_updated(data)
                case MsgType.PUBLIC_CHANNEL_KEY_SHARE:
                    await self._handle_public_channel_key_share(data)
                    await self._forward_public_channel_key_share(data)
                case MsgType.FILE_START:
                    await self._handle_file_start(data)
                case MsgType.FILE_CHUNK:
                    await self._handle_file_chunk(data)
                case MsgType.FILE_END:
                    await self._handle_file_end(data)
                case _:
                    self.logger.error(f"[USER] Unknown request type: {req_type}")
        except (ConnectionClosedOK, ConnectionClosedError):
            pass
        except Exception as e:
            self.logger.error(f"[USER] error: {e!r}")

    async def _handle_user_hello(self, websocket: ServerConnection, msg: ProtocolMessage):
        payload = UserHelloPayload(**msg.payload)
        user_id = msg.from_
        if user_id in self.user_locations:
            await self._error_to(ws=websocket, code=ErrorCode.NAME_IN_USE, detail="User ID already in use")
            return

        self.local_users[user_id] = websocket
        self.user_locations[user_id] = "local"
        self.ws_to_user[websocket] = user_id
        self.db.add_user(user_id, payload.pubkey, "", "", {})

        # Add user to public channel and broadcast updated
        if self.db.add_user_to_public_channel(user_id, payload.pubkey, self.server_private_key, self.server_public_key):
            await self._broadcast_public_channel_updated_and_key_share()

        # when a new user connects, we first advertise their identity to all other servers/peers and the introducer
        # then we send the existing roster to the new user (both local and remote users) to ensure the new user learns about earlier users' pubkeys'
        # finally we advertise the new user to all local users (including the new one)

        # gossip advertise to other servers (including the introducer)
        await self._gossip_user_advertise(user_id, payload.pubkey)

        # send the existing roster to the NEW user
        await self._send_roster_to_user(websocket, user_id)

        # tell all local users (including the new one) about this new user
        await self._broadcast_local_user_advertise(user_id, payload.pubkey)

    async def _gossip_user_advertise(self, user_id: str, pubkey: str):
        payload = UserAdvertisePayload(user_id=user_id, server_id=self.server_id, pubkey=pubkey, meta={}).model_dump()
        sig = compute_transport_sig(load_private_key(self.server_private_key), payload)
        req = create_body(MsgType.USER_ADVERTISE, self.server_id, "*", payload, sig)

        # fan-out to all connected servers
        for sid, peer in self.peers.items():
            self.logger.info(f"[GOSSIP] advertising user: '{user_id}' to server: '{sid}'")
            await peer.ws.send(req)

        # fan-out to the introducer
        if self.introducer_ws:
            self.logger.info(f"[GOSSIP] advertising user: '{user_id}' to Introducer")
            await self.introducer_ws.send(req)

    async def _send_roster_to_user(self, websocket: ServerConnection, new_user: str):
        """
        Send USER_ADVERTISE for all known LOCAL and REMOTE users to a single websocket.
        This ensures a newly joined user learns about earlier users' pubkeys.
        """
        # Local users first
        for uid in list(self.local_users.keys()):
            if uid == new_user:
                continue

            rec = self.db.get_user(uid)
            if not rec:
                continue

            payload = UserAdvertisePayload(user_id=uid, server_id=self.server_id, pubkey=rec["pubkey"], meta={}).model_dump()
            req = create_body(MsgType.USER_ADVERTISE, self.server_id, new_user, payload)

            try:
                await websocket.send(req)
                self.logger.info(f"[ROSTER] sent local user: '{uid}' to new user: '{new_user}'")
            except Exception as e:
                self.logger.error(f"[ROSTER] failed sending local user {uid} to {new_user}: {e!r}")

        # Remote users (learned via gossip)
        for uid, sid in list(self.user_locations.items()):
            if sid == "local" or uid == new_user:
                continue

            rec = self.db.get_user(uid)
            if not rec:
                continue

            payload = UserAdvertisePayload(user_id=uid, server_id=self.server_id, pubkey=rec["pubkey"], meta={}).model_dump()
            req = create_body(MsgType.USER_ADVERTISE, self.server_id, sid, payload)

            try:
                await websocket.send(req)
                self.logger.info(f"[ROSTER] sent remote user: '{uid}' to new user: '{new_user}'")
            except Exception as e:
                self.logger.error(f"[ROSTER] failed sending remote user {uid} to {sid}: {e!r}")

    async def _broadcast_local_user_advertise(self, user_id: str, pubkey: str):
        payload = UserAdvertisePayload(user_id=user_id, server_id=self.server_id, pubkey=pubkey, meta={}).model_dump()

        for uid, ws in list(self.local_users.items()):
            req = create_body(MsgType.USER_ADVERTISE, self.server_id, uid, payload)
            try:
                self.logger.info(f"[LOCAL-ADV] sending new user: '{user_id}' to local user: '{uid}'")
                await ws.send(req)
            except (ConnectionClosedError, ConnectionClosedOK):
                pass
            except Exception as e:
                self.logger.error(f"[LOCAL-ADV] failed to send to client: {e!r}")

    async def _broadcast_local_user_remove(self, user_id: str):
        """
        Tell all LOCAL clients that 'user_id' went offline, so they can forget its pubkey.
        """
        payload = UserRemovePayload(user_id=user_id, server_id=self.server_id).model_dump()
        for uid, ws in list(self.local_users.items()):
            req = create_body(MsgType.USER_REMOVE, self.server_id, uid, payload)
            try:
                self.logger.info(f"[LOCAL-RM] telling local user '{uid}' to forget '{user_id}'")
                await ws.send(req)
            except (ConnectionClosedError, ConnectionClosedOK):
                pass
            except Exception as e:
                self.logger.error(f"[LOCAL-RM] failed to send USER_REMOVE to {uid}: {e!r}")

    async def _handle_msg_direct(self, msg: ProtocolMessage):
        payload = MsgDirectPayload(**msg.payload)
        target = msg.to

        # deliver locally if present
        if target in self.local_users:
            deliver_pl = UserDeliverPayload(
                ciphertext=payload.ciphertext,
                sender=msg.from_,
                sender_pub=payload.sender_pub,
                content_sig=payload.content_sig
            ).model_dump()
            sig = compute_transport_sig(load_private_key(self.server_private_key), deliver_pl)
            req = create_body(MsgType.USER_DELIVER, self.server_id, target, deliver_pl, sig, ts=msg.ts)
            try:
                await self.local_users[target].send(req)
            except Exception as e:
                self.logger.error(f"[DM] failed to deliver to local user {target}: {e!r}")
            return

        # else route to remote server if we know it
        sid = self.user_locations.get(target)
        if sid and sid != "local" and sid in self.peers:
            fwd_pl = ServerDeliverPayload(
                user_id=target,
                ciphertext=payload.ciphertext,
                sender=msg.from_,
                sender_pub=payload.sender_pub,
                content_sig=payload.content_sig
            ).model_dump()
            sig = compute_transport_sig(load_private_key(self.server_private_key), fwd_pl)
            req = create_body(MsgType.SERVER_DELIVER, self.server_id, sid, fwd_pl, sig, ts=msg.ts)
            await self.peers[sid].ws.send(req)
            return

        self.logger.warning(f"[ERROR-UP] {ErrorCode.USER_NOT_FOUND}: {target} not registered")

    async def _handle_msg_public(self, msg: ProtocolMessage):
        payload = MsgPublicChannelPayload(**msg.payload)
        key = f"pub_{msg.ts}_{msg.from_}_{hash(json.dumps(msg.payload, sort_keys=True))}"
        if key in self.seen_ids:
            return
        self.seen_ids.add(key)

        # broadcast to local users
        for uid, ws in list(self.local_users.items()):
            deliver_pl = UserDeliverPayload(
                ciphertext=payload.ciphertext,
                sender=msg.from_,
                sender_pub=payload.sender_pub,
                content_sig=payload.content_sig
            ).model_dump()
            sig = compute_transport_sig(load_private_key(self.server_private_key), deliver_pl)
            req = create_body(MsgType.USER_DELIVER, self.server_id, uid, deliver_pl, sig, ts=msg.ts)
            try:
                await ws.send(req)
            except (ConnectionClosedError, ConnectionClosedOK):
                pass
            except Exception as e:
                self.logger.error(f"[PUB] local deliver to {uid} failed: {e!r}")

        # fan-out to other servers
        for sid, p in self.peers.items():
            req = create_body(MsgType.MSG_PUBLIC_CHANNEL, msg.from_, "*", payload.model_dump(), ts=msg.ts)
            try:
                await p.ws.send(req)
            except Exception as e:
                self.logger.error(f"[PUB] fan-out to {sid} failed: {e!r}")

    async def _handle_command(self, websocket: ServerConnection, data: ProtocolMessage):
        payload = CommandPayload(**data.payload)
        cmd = payload.command.strip().lower()
        if cmd == "/list":
            users = sorted(
                list(self.local_users.keys())
                + [u for u, loc in self.user_locations.items() if loc != "local"]
            )
            response = {
                "users": users,
            }
            res_pl = CommandResponsePayload(command=cmd, response=json.dumps(response)).model_dump()
            body = create_body(MsgType.COMMAND_RESPONSE, self.server_id, data.from_, res_pl)
            try:
                await websocket.send(body)
            except Exception as e:
                self.logger.error(f"[CMD] /list response failed: {e!r}")

    async def _gossip_user_remove(self, user_id: str):
        """Tell all remotes + introducer that a user is gone."""
        pl = UserRemovePayload(user_id=user_id, server_id=self.server_id).model_dump()
        req = create_body(MsgType.USER_REMOVE, self.server_id, "*", pl)

        # send to peers
        for sid, peer in list(self.peers.items()):
            try:
                await peer.ws.send(req)
                self.logger.info(f"[GOSSIP] USER_REMOVE '{user_id}' -> server '{sid}'")
            except Exception as e:
                self.logger.warning(f"[GOSSIP] USER_REMOVE to {sid} failed: {e!r}")

        # send to introducer
        if self.introducer_ws:
            try:
                await self.introducer_ws.send(req)
                self.logger.info(f"[GOSSIP] USER_REMOVE '{user_id}' -> Introducer")
            except Exception as e:
                self.logger.warning(f"[GOSSIP] USER_REMOVE to Introducer failed: {e!r}")

    async def _cleanup_local_user(self, user_id: str, reason: str = "disconnect", is_remote_call: bool = False):
        """Idempotent local cleanup: routing maps, DB, and gossip."""
        # remove routing/locals
        ws = self.local_users.pop(user_id, None)
        self.user_locations.pop(user_id, None)

        # drop reverse index
        if ws:
            self.ws_to_user.pop(ws, None)

        # delete from DB
        try:
            self.db.delete_user(user_id)  # you'll add this in database.py below
        except Exception as e:
            self.logger.warning(f"[CLEANUP] DB delete for {user_id} failed: {e!r}")

        # remove user from local clients
        await self._broadcast_local_user_remove(user_id)

        # gossip to others only if not a remote call (i.e. a user disconnect)
        if not is_remote_call:
            await self._gossip_user_remove(user_id)

        self.logger.info(f"[CLEANUP] user {user_id} removed ({reason})")

    async def _broadcast_public_channel_updated_and_key_share(self):
        group = self.db.get_group("public")
        if not group:
            return

        members = self.db.get_group_members("public")
        if not members:
            return

        version = group['version']
        wraps = [{"member_id": uid, "wrapped_key": info['wrapped_key']} for uid, info in members.items()]

        # Broadcast UPDATED
        updated_pl = PublicChannelUpdatedPayload(version=version, wraps=wraps).model_dump()
        sig_updated = compute_transport_sig(load_private_key(self.server_private_key), updated_pl)
        req_updated = create_body(MsgType.PUBLIC_CHANNEL_UPDATED, self.server_id, "*", updated_pl, sig_updated, ts=current_timestamp())

        # to local users
        for uid, ws in list(self.local_users.items()):
            try:
                self.logger.info(f"[PUB-UPDATED] sending to user: {uid}")
                await ws.send(req_updated)
            except Exception as e:
                self.logger.error(f"[PUB-UPDATED] failed to user: {uid}: {e!r}")

        # to peers
        for sid, p in self.peers.items():
            try:
                self.logger.info(f"[PUB-UPDATED] sending to server {sid}")
                await p.ws.send(req_updated)
            except Exception as e:
                self.logger.error(f"[PUB-UPDATED] failed to server {sid}: {e!r}")

        # Broadcast KEY_SHARE
        shares = [{"member": uid, "wrapped_public_channel_key": info['wrapped_key']} for uid, info in members.items()]
        content_sig = compute_key_share_sig(load_private_key(self.server_private_key), shares, self.server_public_key)
        key_share_pl = PublicChannelKeySharePayload(shares=shares, creator_pub=self.server_public_key, content_sig=content_sig).model_dump()
        sig_ks = compute_transport_sig(load_private_key(self.server_private_key), key_share_pl)
        req_key_share = create_body(MsgType.PUBLIC_CHANNEL_KEY_SHARE, self.server_id, "*", key_share_pl, sig_ks, ts=current_timestamp())

        # Send to all same places
        for uid, ws in list(self.local_users.items()):
            try:
                self.logger.info(f"[PUB-KEY-SHARE] sending to user: {uid}")
                await ws.send(req_key_share)
            except Exception as e:
                self.logger.error(f"[PUB-KEY-SHARE] failed to user: {uid}: {e!r}")

        for sid, p in self.peers.items():
            try:
                self.logger.info(f"[PUB-KEY-SHARE] sending to server {sid}")
                await p.ws.send(req_key_share)
            except Exception as e:
                self.logger.error(f"[PUB-KEY-SHARE] failed to server {sid}: {e!r}")

    async def _forward_public_channel_updated(self, data: ProtocolMessage):
        req = create_body(data.type, data.from_, "*", data.payload, ts=data.ts)

        # Send to local clients
        for uid, ws in list(self.local_users.items()):
            try:
                self.logger.info(f"[FORWARD-PUB-UPDATED] to user: {uid}")
                await ws.send(req)
            except Exception as e:
                self.logger.error(f"[FORWARD-PUB-UPDATED] to {uid} failed: {e!r}")

        # Send to peers (avoid echo)
        for sid, p in self.peers.items():
            if sid != data.from_:
                try:
                    self.logger.info(f"[FORWARD-PUB-UPDATED] to server: {sid}")
                    await p.ws.send(req)
                except Exception as e:
                    self.logger.error(f"[FORWARD-PUB-UPDATED] to server {sid} failed: {e!r}")

    async def _forward_public_channel_key_share(self, data: ProtocolMessage):
        req = create_body(data.type, data.from_, "*", data.payload, ts=data.ts)

        # Send to local clients
        for uid, ws in list(self.local_users.items()):
            try:
                self.logger.info(f"[FORWARD-PUB-KEY-SHARE] to user: {uid}")
                await ws.send(req)
            except Exception as e:
                self.logger.error(f"[FORWARD-PUB-KEY-SHARE] to {uid} failed: {e!r}")

        # Send to peers (avoid echo)
        for sid, p in self.peers.items():
            if sid != data.from_:
                try:
                    self.logger.info(f"[FORWARD-PUB-KEY-SHARE] to server: {sid}")
                    await p.ws.send(req)
                except Exception as e:
                    self.logger.error(f"[FORWARD-PUB-KEY-SHARE] to server {sid} failed: {e!r}")

    async def _handle_public_channel_updated(self, data: ProtocolMessage):
        if data.from_ == self.server_id:
            return  # skip self

        payload = PublicChannelUpdatedPayload(**data.payload)
        group = self.db.get_group("public")
        if group and payload.version > group['version']:
            self.db.update_group_version("public", payload.version)
            for wrap in payload.wraps:
                self.db.add_group_member("public", wrap['member_id'], "member", wrap['wrapped_key'])
                # DB is updated; clients will handle shares

    async def _handle_public_channel_key_share(self, data: ProtocolMessage):
        if data.from_ == self.server_id:
            return

        payload = PublicChannelKeySharePayload(**data.payload)
        for share in payload.shares:
            uid = share['member']
            user = self.db.get_user(uid)
            if user:
                try:
                    group_key = rsa_decrypt(load_private_key(user['pubkey']), share['wrapped_public_channel_key'])
                    self.db.set_group_key("public", group_key, self.server_public_key)
                    self.logger.info("Updated group key from key share")
                    return  # no need to try others
                except:
                    pass

    async def _send_public_channel_to_server(self, sid: str):
        group = self.db.get_group("public")
        if not group or group.get('version', 1) <= 1:
            return  # no data to send

        members = self.db.get_group_members("public")
        if not members:
            return

        # Send PUBLIC_CHANNEL_UPDATED
        wraps = [{"member_id": uid, "wrapped_key": info['wrapped_key']} for uid, info in members.items()]
        updated_pl = PublicChannelUpdatedPayload(version=group['version'], wraps=wraps).model_dump()
        sig = compute_transport_sig(load_private_key(self.server_private_key), updated_pl)
        req_upd = create_body(MsgType.PUBLIC_CHANNEL_UPDATED, self.server_id, sid, updated_pl, sig, ts=current_timestamp())

        # Send PUBLIC_CHANNEL_KEY_SHARE
        shares = [{"member": uid, "wrapped_public_channel_key": info['wrapped_key']} for uid, info in members.items()]
        content_sig = compute_key_share_sig(load_private_key(self.server_private_key), shares, self.server_public_key)
        ks_pl = PublicChannelKeySharePayload(shares=shares, creator_pub=self.server_public_key, content_sig=content_sig).model_dump()
        sig_ks = compute_transport_sig(load_private_key(self.server_private_key), ks_pl)
        req_ks = create_body(MsgType.PUBLIC_CHANNEL_KEY_SHARE, self.server_id, sid, ks_pl, sig_ks, ts=current_timestamp())

        peer = self.peers.get(sid)
        if peer:
            try:
                await peer.ws.send(req_upd)
                await peer.ws.send(req_ks)
                self.logger.info(f"[SYNC-PUB] Sent current public channel to new server {sid}")
            except Exception as e:
                self.logger.error(f"[SYNC-PUB] Failed to send to {sid}: {e!r}")
        else:
            self.logger.warning(f"[SYNC-PUB] No peer found for {sid}")

    async def _handle_file_start(self, data: ProtocolMessage):
        try:
            payload = FileStartPayload(**data.payload)
            _key = f"file_start_{payload.file_id}_{hash(json.dumps(data.payload, sort_keys=True))}"

            if payload.mode == "public":
                # broadcast to local users
                for uid, ws in list(self.local_users.items()):
                    key = f"{_key}_{uid}"
                    if key in self.seen_ids:
                        continue
                    self.seen_ids.add(key)

                    req = create_body(data.type, data.from_, data.to, payload.model_dump(), ts=data.ts)
                    try:
                        await ws.send(req)
                    except Exception as e:
                        self.logger.error(f"[FILE-START] to {uid} failed: {e!r}")

                # fan-out to other servers
                for sid, p in self.peers.items():
                    key = f"{_key}_{sid}"
                    if key in self.seen_ids:
                        continue
                    self.seen_ids.add(key)

                    req = create_body(data.type, data.from_, "*", payload.model_dump(), ts=data.ts)
                    try:
                        await p.ws.send(req)
                    except Exception as e:
                        self.logger.error(f"[FILE-START] to {sid} failed: {e!r}")
            else:
                # treat like DM
                target = data.to

                key = f"{_key}_{target}"
                if key in self.seen_ids:
                    return
                self.seen_ids.add(key)

                if target in self.local_users:
                    req = create_body(data.type, data.from_, target, payload.model_dump(), ts=data.ts)
                    try:
                        await self.local_users[target].send(req)
                    except Exception as e:
                        self.logger.error(f"[FILE-START] to {target} failed: {e!r}")
                    return

                sid = self.user_locations.get(target)
                if sid and sid != "local" and sid in self.peers:
                    req = create_body(data.type, data.from_, target, payload.model_dump(), ts=data.ts)
                    await self.peers[sid].ws.send(req)
                    return

                self.logger.warning(f"[FILE-START] {ErrorCode.USER_NOT_FOUND}: {target} not registered")
        except Exception as e:
            self.logger.error(f"[FILE-START] failed: {e!r}")

    async def _handle_file_chunk(self, data: ProtocolMessage):
        try:
            payload = FileChunkPayload(**data.payload)
            _key = f"file_chunk_{payload.file_id}_{payload.index}_{hash(json.dumps(data.payload, sort_keys=True))}"

            # Reconstruct target from start, but since to is the same as start
            to = data.to
            if to == "*" or to == "public":
                # fan-out like public
                for uid, ws in list(self.local_users.items()):
                    key = f"{_key}_{uid}"
                    if key in self.seen_ids:
                        continue
                    self.seen_ids.add(key)

                    req = create_body(data.type, data.from_, uid, payload.model_dump(), ts=data.ts)
                    try:
                        await ws.send(req)
                    except Exception as e:
                        self.logger.error(f"[FILE-CHUNK] to {uid} failed: {e!r}")

                for sid, p in self.peers.items():
                    key = f"{_key}_{sid}"
                    if key in self.seen_ids:
                        continue
                    self.seen_ids.add(key)

                    req = create_body(data.type, data.from_, "*", payload.model_dump(), ts=data.ts)
                    try:
                        await p.ws.send(req)
                    except Exception as e:
                        self.logger.error(f"[FILE-CHUNK] to {sid} failed: {e!r}")
            else:
                # route like DM
                if to in self.local_users:
                    key = f"{_key}_{to}"
                    if key in self.seen_ids:
                        return
                    self.seen_ids.add(key)

                    req = create_body(data.type, data.from_, to, payload.model_dump(), ts=data.ts)
                    try:
                        await self.local_users[to].send(req)
                    except Exception as e:
                        self.logger.error(f"[FILE-CHUNK] to {to} failed: {e!r}")
                    return

                sid = self.user_locations.get(to)
                if sid and sid != "local" and sid in self.peers:
                    req = create_body(data.type, data.from_, to, payload.model_dump(), ts=data.ts)
                    await self.peers[sid].ws.send(req)
                    return

                self.logger.warning(f"[FILE-CHUNK] no route to {to}")
        except Exception as e:
            self.logger.error(f"[FILE-CHUNK] failed: {e!r}")

    async def _handle_file_end(self, data: ProtocolMessage):
        try:
            payload = FileEndPayload(**data.payload)
            _key = f"file_end_{payload.file_id}_{hash(json.dumps(data.payload, sort_keys=True))}"

            to = data.to
            if to == "*" or to == "public":
                for uid, ws in list(self.local_users.items()):
                    key = f"{_key}_{uid}"
                    if key in self.seen_ids:
                        continue
                    self.seen_ids.add(key)

                    req = create_body(data.type, data.from_, uid, payload.model_dump(), ts=data.ts)
                    try:
                        await ws.send(req)
                    except Exception as e:
                        self.logger.error(f"[FILE-END] to {uid} failed: {e!r}")

                for sid, p in self.peers.items():
                    key = f"{_key}_{sid}"
                    if key in self.seen_ids:
                        continue
                    self.seen_ids.add(key)

                    req = create_body(data.type, data.from_, "*", payload.model_dump(), ts=data.ts)
                    try:
                        await p.ws.send(req)
                    except Exception as e:
                        self.logger.error(f"[FILE-END] to {sid} failed: {e!r}")
            else:
                if to in self.local_users:
                    key = f"{_key}_{to}"
                    if key in self.seen_ids:
                        return
                    self.seen_ids.add(key)

                    req = create_body(data.type, data.from_, to, payload.model_dump(), ts=data.ts)
                    try:
                        await self.local_users[to].send(req)
                    except Exception as e:
                        self.logger.error(f"[FILE-END] to {to} failed: {e!r}")
                    return

                sid = self.user_locations.get(to)
                if sid and sid != "local" and sid in self.peers:
                    req = create_body(data.type, data.from_, to, payload.model_dump(), ts=data.ts)
                    await self.peers[sid].ws.send(req)
                    return

                self.logger.warning(f"[FILE-END] no route to {to}")
        except Exception as e:
            self.logger.error(f"[FILE-END] failed: {e!r}")

    # ---------- utilities ----------
    async def _error_to(self, ws: ServerConnection, code: ErrorCode, detail: str):
        payload = ErrorPayload(code=code, detail=detail).model_dump()
        body = create_body(MsgType.ERROR, self.server_id, "*", payload)
        try:
            await ws.send(body)
        except Exception as e:
            self.logger.error(f"[ERROR->client] failed to send error: {e!r}")


if __name__ == "__main__":
    srv = Server()
    try:
        asyncio.run(srv.start())
    except KeyboardInterrupt:
        try:
            asyncio.run(srv.shutdown("keyboard"))
        except RuntimeError:
            pass
        print("\n[STOP] Bye.")
