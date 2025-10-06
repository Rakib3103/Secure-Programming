/* eslint-disable no-unused-vars */
import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useEffect,
  useCallback,
} from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import {
  generateRsaKeypair,
  loadPrivateKey as loadPrivateKeyOAEP, // forge privateKeyFromPem
  loadPublicKey as loadPublicKeyOAEP, // forge publicKeyFromPem
  rsaDecrypt,
  aesDecrypt,
  verifyContentSig,
  verifyPublicContentSig,
  rsaEncrypt,
  computeContentSig,
  aesEncrypt,
  computePublicContentSig,
  utf8ToBytes,
} from './crypto';
import { sha256 } from 'js-sha256';

const currentTimestamp = () => Math.floor(Date.now() / 1000);

const createBody = (type, from, to, payload, sig = '', ts = null) => {
  return {
    type,
    from,
    to,
    ts: ts ?? currentTimestamp(),
    payload,
    sig,
  };
};

const MESSAGE_TYPES = {
  USER_HELLO: 'USER_HELLO',
  USER_DELIVER: 'USER_DELIVER',
  MSG_DIRECT: 'MSG_DIRECT',
  MSG_PUBLIC_CHANNEL: 'MSG_PUBLIC_CHANNEL',
  PUBLIC_CHANNEL_ADD: 'PUBLIC_CHANNEL_ADD',
  PUBLIC_CHANNEL_UPDATED: 'PUBLIC_CHANNEL_UPDATED',
  PUBLIC_CHANNEL_KEY_SHARE: 'PUBLIC_CHANNEL_KEY_SHARE',
  COMMAND_RESPONSE: 'COMMAND_RESPONSE',
  COMMAND: 'COMMAND',
  FILE_START: 'FILE_START',
  FILE_CHUNK: 'FILE_CHUNK',
  FILE_END: 'FILE_END',
  USER_ADVERTISE: 'USER_ADVERTISE',
  USER_REMOVE: 'USER_REMOVE',
  SERVER_DELIVER: 'SERVER_DELIVER',
  HEARTBEAT: 'HEARTBEAT',
  ERROR: 'ERROR',
};

const SocpCtx = createContext(null);

export function SocpProvider({ children }) {
  const serverUri = process.env.REACT_APP_WS_URL || 'ws://127.0.0.1:8080/ws';
  const [userId, setUserId] = useState('');
  const [privateKeyB64, setPrivateKeyB64] = useState(null);
  const [publicKeyB64, setPublicKeyB64] = useState(null);
  const [knownPubkeys, setKnownPubkeys] = useState({});
  const [groupKeys, setGroupKeys] = useState({});
  const [fileTransfers, setFileTransfers] = useState({});
  // onlineUsers: [{ userId, meta }]
  const [onlineUsers, setOnlineUsers] = useState([]);
  // messages: { [peerId]: [{dir: "in"|"out", text: string, ts: number}] }
  const [messages, setMessages] = useState({});
  const [activePeerId, setActivePeerId] = useState(null);

  console.log({ messages });

  useEffect(() => {
    const generatedUserId = process.env.REACT_APP_USER_ID || crypto.randomUUID();
    setUserId(generatedUserId);
    generateRsaKeypair().then(({ private_key_b64, public_key_b64 }) => {
      setPrivateKeyB64(private_key_b64);
      setPublicKeyB64(public_key_b64);
    });
  }, []);

  const sendUserHello = useCallback(
    sendMessage => {
      if (!publicKeyB64 || !userId) return;

      const payload = {
        client: 'local-cli-v1',
        pubkey: publicKeyB64,
        enc_pubkey: publicKeyB64,
      };
      const body = createBody(
        MESSAGE_TYPES.USER_HELLO,
        userId,
        'server',
        payload,
      );
      sendMessage(body);
      console.info('[SOCP] → USER_HELLO sent', body);
    },
    [publicKeyB64, userId],
  );

  const {
    sendJsonMessage,
    lastJsonMessage: msg,
    readyState,
  } = useWebSocket(serverUri, {
    share: true,
    shouldReconnect: () => true,
    reconnectAttempts: Number(process.env.RECONNECT_ATTEMPTS) || 3,
    reconnectInterval: 2000,
    onOpen: () => {
      console.log('[SOCP] WebSocket connection opened');
    },
    onClose: event => console.warn('[SOCP] 🔴 Connection closed', event),
    onError: event => console.error('[SOCP] ⚠️ WebSocket error', event),
  });

  useEffect(() => {
    if (
      readyState === ReadyState.OPEN &&
      publicKeyB64 &&
      privateKeyB64 &&
      userId
    ) {
      console.log('[SOCP] Conditions met → sending USER_HELLO');
      sendUserHello(sendJsonMessage);
    }
  }, [
    readyState,
    publicKeyB64,
    privateKeyB64,
    userId,
    sendJsonMessage,
    sendUserHello,
  ]);

  const onUserDeliver = useCallback(
    async msg => {
      try {
        const payload = msg.payload;
        const ciphertext = payload.ciphertext;
        const senderId = payload.sender;
        const senderPubB64 = payload.sender_pub;
        const contentSig = payload.content_sig;
        const to = msg.to;
        const ts = msg.ts;

        const privKey = await loadPrivateKeyOAEP(privateKeyB64);
        const senderPub = await loadPublicKeyOAEP(senderPubB64);

        // 1️⃣ Try decrypt as Direct Message (RSA)
        try {
          const plaintext = await rsaDecrypt(privKey, ciphertext);
          const verified = await verifyContentSig(
            senderPub,
            ciphertext,
            senderId,
            to,
            ts,
            contentSig,
          );
          if (verified) {
            const text = new TextDecoder().decode(plaintext);
            console.info(`[DM] ${senderId}: ${text}`);
            return { type: 'dm', senderId, text };
          }
        } catch (err) {
          console.error('[SOCP] Failed to decrypt direct message:', err);
        }

        // 2️⃣ Try decrypt as Public Message (AES)
        if (!groupKeys['public']) {
          console.error("[SOCP] No group key for 'public', message discarded");
          return null;
        }

        try {
          const aesKey = groupKeys['public'];
          const plaintext = await aesDecrypt(aesKey, ciphertext);
          const verified = await verifyPublicContentSig(
            senderPub,
            ciphertext,
            senderId,
            ts,
            contentSig,
          );
          if (verified) {
            console.info(`[PUB] ${senderId}: ${plaintext}`);
            return { type: 'public', senderId, text: plaintext };
          }
        } catch (err) {
          console.error('[SOCP] Failed to decrypt public message:', err);
        }

        console.error(
          '[SOCP] Unable to decrypt message: neither DM nor public',
        );
        return null;
      } catch (err) {
        console.error('[SOCP] message processing failed:', err);
        return null;
      }
    },
    [privateKeyB64, groupKeys],
  );

  const onUserAdvertise = useCallback(
    msg => {
      try {
        const { user_id: uid, pubkey: pub, meta } = msg.payload || {};
        if (!uid || !pub) return;

        setKnownPubkeys(prev => {
          return { ...prev, [uid]: pub };
        });

        if (uid === userId) return;

        setOnlineUsers(prev => {
          if (prev.some(u => u.userId === uid)) return prev;
          console.info('[SOCP] user online:', uid);
          return [...prev, { userId: uid, meta: meta || {} }];
        });
      } catch (err) {
        console.error('[SOCP] Failed to handle USER_ADVERTISE:', err);
      }
    },
    [userId],
  );

  const onPublicChannelKeyShare = useCallback(
    async msg => {
      try {
        const payload = msg.payload || {};
        const shares = payload.shares || []; // [{ member, wrapped_public_channel_key }]
        if (!privateKeyB64 || !Array.isArray(shares) || shares.length === 0)
          return;

        const myShare = shares.find(s => s.member === userId);
        if (!myShare || !myShare.wrapped_public_channel_key) return;

        try {
          const privKey = await loadPrivateKeyOAEP(privateKeyB64);
          const groupKeyBuf = await rsaDecrypt(
            privKey,
            myShare.wrapped_public_channel_key,
          );

          setGroupKeys(prev => ({
            ...prev,
            public: groupKeyBuf,
          }));

          console.info('[SOCP] Received group key for public channel');
        } catch (e) {
          console.error('[SOCP] Failed to decrypt public channel key:', e);
        }
      } catch (err) {
        console.error('[SOCP] Bad PUBLIC_CHANNEL_KEY_SHARE payload:', err);
      }
    },
    [userId, privateKeyB64],
  );

  const onUserRemove = useCallback(msg => {
    try {
      const { user_id: uid } = msg.payload || {};
      if (!uid) return;
      let hadKey = false;
      setKnownPubkeys(prev => {
        if (!(uid in prev)) return prev;
        hadKey = true;
        // eslint-disable-next-line no-unused-vars
        const { [uid]: _removed, ...rest } = prev;
        return rest;
      });
      if (!hadKey) return;

      console.info('[SOCP] User offline:', uid);

      setOnlineUsers(prev => prev.filter(u => u.userId !== uid));

      setActivePeerId(curr => (curr === uid ? null : curr));

    } catch (err) {
      console.error('[SOCP] Bad USER_REMOVE payload:', err);
    }
  }, []);

  const sendDirectDM = useCallback(
    async (targetId, messageText) => {
      if (!targetId || !messageText?.trim()) return;

      const targetPubB64 = knownPubkeys[targetId];
      if (!targetPubB64) {
        console.error(`[SOCP] Unknown user: ${targetId}`);
        return;
      }

      try {
        const targetPubKey = await loadPublicKeyOAEP(targetPubB64); // encrypt
        const privKey = await loadPrivateKeyOAEP(privateKeyB64); // sign

        const ciphertext = await rsaEncrypt(targetPubKey, messageText);

        const ts = currentTimestamp();

        const contentSig = await computeContentSig(
          privKey,
          ciphertext,
          userId,
          targetId,
          ts,
        );

        const dmPayload = {
          ciphertext,
          sender_pub: publicKeyB64, // public key của mình (base64url)
          content_sig: contentSig,
        };
        const body = createBody(
          'MSG_DIRECT',
          userId,
          targetId,
          dmPayload,
          '',
          ts,
        );

        sendJsonMessage(body);

        setMessages(prev => {
          const arr = prev[targetId] ? [...prev[targetId]] : [];
          arr.push({ dir: 'out', text: messageText.trim(), ts });
          return { ...prev, [targetId]: arr };
        });
      } catch (err) {
        console.error('[SOCP] sendDirectDM failed:', err);
      }
    },
    [
      knownPubkeys,
      privateKeyB64,
      publicKeyB64,
      userId,
      sendJsonMessage,
      setMessages,
    ],
  );

  const sendPublicMessage = useCallback(
    async messageText => {
      if (!messageText?.trim()) return;

      const pubKey = groupKeys['public'];
      if (!pubKey) {
        console.error('[SOCP] No group key for public channel');
        return;
      }

      try {
        const ciphertext = await aesEncrypt(pubKey, messageText);

        const ts = currentTimestamp();

        const privKey = await loadPrivateKeyOAEP(privateKeyB64);
        const contentSig = await computePublicContentSig(
          privKey,
          ciphertext,
          userId,
          ts,
        );

        const pubPayload = {
          ciphertext,
          sender_pub: publicKeyB64,
          content_sig: contentSig,
        };
        const body = createBody(
          MESSAGE_TYPES.MSG_PUBLIC_CHANNEL,
          userId,
          'public',
          pubPayload,
          '',
          ts,
        );

        sendJsonMessage(body);

        setMessages(prev => {
          const arr = prev.public ? [...prev.public] : [];
          arr.push({ dir: 'out', text: messageText.trim(), ts });
          return { ...prev, public: arr };
        });
      } catch (err) {
        console.error('[SOCP] sendPublicMessage failed:', err);
      }
    },
    [
      groupKeys,
      privateKeyB64,
      publicKeyB64,
      userId,
      sendJsonMessage,
      setMessages,
    ],
  );

  const sendFile = useCallback(
    async (targetIdOrPublic, file, mode = 'dm') => {
      try {
        if (!file || !(file instanceof File)) return;

        const to = mode === 'public' ? 'public' : targetIdOrPublic;
        const ts = currentTimestamp();
        const fileId = crypto.randomUUID();

        const privKey = await loadPrivateKeyOAEP(privateKeyB64);
        let targetPubKey = null;
        let aesKey = null;

        if (mode === 'public') {
          aesKey = groupKeys['public'];
        } else {
          const targetPubB64 = knownPubkeys[targetIdOrPublic];
          if (!targetPubB64) {
            console.error(`[SOCP] Unknown user: ${targetIdOrPublic}`);
            return;
          }
          targetPubKey = await loadPublicKeyOAEP(targetPubB64);
        }

        const fileBuf = await file.arrayBuffer();
        const hash = sha256(new Uint8Array(fileBuf));

        // 1) FILE_START
        const startPayload = {
          file_id: fileId,
          name: file.name,
          size: file.size,
          sha256: hash,
          mode, // 'public' | 'dm'
        };
        sendJsonMessage(
          createBody(
            MESSAGE_TYPES.FILE_START,
            userId,
            to,
            startPayload,
            '',
            ts,
          ),
        );

        // 2) FILE_CHUNK (base64)
        const buf = await file.arrayBuffer();
        const u8 = new Uint8Array(buf);
        const chunkSize = 64 * 1024; // 64KB
        const totalChunks = Math.ceil(u8.length / chunkSize);

        for (let i = 0; i < totalChunks; i++) {
          const part = u8.subarray(
            i * chunkSize,
            Math.min((i + 1) * chunkSize, u8.length),
          );
          let ciphertext;
          let contentSig;
          const tsChunk = currentTimestamp();

          if (mode === 'public') {
            ciphertext = await aesEncrypt(aesKey, part);
            contentSig = await computePublicContentSig(
              privKey,
              ciphertext,
              userId,
              tsChunk,
            );
          } else {
            ciphertext = await rsaEncrypt(targetPubKey, part);
            contentSig = await computeContentSig(
              privKey,
              ciphertext,
              userId,
              to,
              tsChunk,
            );
          }

          const chunkPayload = {
            file_id: fileId,
            index: i,
            ciphertext,
            content_sig: contentSig,
          };
          sendJsonMessage(
            createBody(
              MESSAGE_TYPES.FILE_CHUNK,
              userId,
              to,
              chunkPayload,
              '',
              tsChunk,
            ),
          );
        }

        // 3) FILE_END
        const endPayload = { file_id: fileId, total_chunks: totalChunks };
        sendJsonMessage(
          createBody(MESSAGE_TYPES.FILE_END, userId, to, endPayload, '', ts),
        );

        const url = URL.createObjectURL(
          new Blob([u8], { type: 'application/octet-stream' }),
        );
        const roomKey = mode === 'public' ? 'public' : targetIdOrPublic;
        setMessages(prev => {
          const arr = prev[roomKey] ? [...prev[roomKey]] : [];
          arr.push({
            dir: 'out',
            text: `[File] ${file.name}`,
            fileUrl: url,
            ts,
          });
          return { ...prev, [roomKey]: arr };
        });
      } catch (err) {
        console.error('[SOCP] sendFile failed:', err);
      }
    },
    [
      sendJsonMessage,
      userId,
      setMessages,
      privateKeyB64,
      knownPubkeys,
      groupKeys,
    ],
  );

  useEffect(() => {
    if (!msg) return;
    const messageType = msg.type;

    switch (messageType) {
      case MESSAGE_TYPES.USER_DELIVER:
        onUserDeliver(msg, privateKeyB64, groupKeys).then(result => {
          if (!result || result.senderId === userId) return;
          const roomKey = result.type === 'public' ? 'public' : result.senderId;

          setMessages(prev => {
            const arr = prev[roomKey] ? [...prev[roomKey]] : [];
            arr.push({
              dir: 'in',
              text: result.text,
              ts: msg.ts,
              from: result.senderId,
            });
            return { ...prev, [roomKey]: arr };
          });
        });
        break;
      case MESSAGE_TYPES.USER_ADVERTISE:
        onUserAdvertise(msg);
        break;
      case MESSAGE_TYPES.USER_REMOVE:
        onUserRemove(msg);
        break;
      case MESSAGE_TYPES.PUBLIC_CHANNEL_KEY_SHARE:
        onPublicChannelKeyShare(msg);
        break;
      case MESSAGE_TYPES.FILE_START:
        handleFileStart(msg);
        break;
      case MESSAGE_TYPES.FILE_CHUNK:
        handleFileChunk(msg);
        break;
      case MESSAGE_TYPES.FILE_END:
        handleFileEnd(msg);
        break;
      case MESSAGE_TYPES.ERROR:
        console.error('[SOCP] ← ERROR', msg);
        break;
      default:
        console.warn('[SOCP] ← Unknown message type', msg);
        break;
    }
  }, [msg]);

  const handleFileStart = useCallback(
    msg => {
      console.log({ from: msg.from, userId });

      if (msg.from === userId) return;
      const { file_id, name, size, mode } = msg.payload || {};
      if (!file_id || !name) return;
      console.info(
        '[FILE_START] id=%s name=%s size=%s mode=%s',
        file_id,
        name,
        size,
        mode,
      );
      setFileTransfers(prev => ({
        ...prev,
        [file_id]: { name, size: size ?? 0, mode, chunks: {} },
      }));
    },
    [userId],
  );

  const handleFileChunk = useCallback(
    msg => {
      if (msg.from === userId) return;
      const { file_id, index, ciphertext, content_sig } = msg.payload || {};
      if (!file_id || typeof index !== 'number' || !ciphertext) return;

      (async () => {
        const ft = fileTransfers[file_id];
        if (!ft) {
          console.warn('[FILE_CHUNK] unknown file_id=', file_id);
          return;
        }

        try {
          let bytes;
          if (ft.mode === 'public') {
            const plain = await aesDecrypt(groupKeys['public'], ciphertext);
            bytes = utf8ToBytes(plain);
          } else {
            const privKey = await loadPrivateKeyOAEP(privateKeyB64);
            bytes = await rsaDecrypt(privKey, ciphertext);
          }

          if (!(bytes instanceof Uint8Array)) {
            console.error(
              '[FILE_CHUNK] decrypted result is not bytes, got:',
              typeof bytes,
            );
            return;
          }

          console.debug(
            '[FILE_CHUNK] id=%s idx=%d len=%d',
            file_id,
            index,
            bytes.length,
          );

          setFileTransfers(prev => {
            const cur = prev[file_id];
            if (!cur) return prev;
            const chunks = { ...cur.chunks, [index]: bytes };
            return { ...prev, [file_id]: { ...cur, chunks } };
          });
        } catch (e) {
          console.error('[FILE_CHUNK] decrypt/handle failed:', e);
        }
      })();
    },
    [fileTransfers, groupKeys, privateKeyB64],
  );

  const handleFileEnd = useCallback(
    msg => {
      if (msg.from === userId) return;

      const { file_id } = msg.payload || {};
      if (!file_id) return;

      setFileTransfers(prev => {
        const ft = prev[file_id];
        if (!ft) return prev;

        const ordered = Object.keys(ft.chunks)
          .sort((a, b) => Number(a) - Number(b))
          .map(k => ft.chunks[k]);

        const totalBytes = ordered.reduce((acc, u8) => acc + u8.length, 0);
        console.info(
          '[FILE_END] id=%s expected=%s received=%s (%s chunks)',
          file_id,
          ft.size,
          totalBytes,
          ordered.length,
        );

        const blob = new Blob(ordered, { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);

        const roomKey = ft.mode === 'public' ? 'public' : msg.from;

        setMessages(prevMsgs => {
          const arr = prevMsgs[roomKey] ? [...prevMsgs[roomKey]] : [];
          const text = `[File] ${ft.name}: ${url}`;
          const incoming = {
            dir: 'in',
            text,
            fileUrl: url,
            ts: msg.ts,
            from: msg.from,
            fileId: file_id,
          };

          const exists = arr.some(
            m =>
              (m && m.fileId && m.fileId === file_id) ||
              (m &&
                m.from === msg.from &&
                typeof m.text === 'string' &&
                m.text === text &&
                m.ts === msg.ts),
          );
          const nextArr = exists ? arr : arr.concat(incoming);

          console.log('prevMsgs', prevMsgs);
          return { ...prevMsgs, [roomKey]: nextArr };
        });

        // dọn RAM
        const { [file_id]: _, ...rest } = prev;
        return rest;
      });
    },
    [userId, setMessages],
  );

  const wsState = useMemo(
    () =>
      ({
        [ReadyState.CONNECTING]: 'connecting',
        [ReadyState.OPEN]: 'connected',
        [ReadyState.CLOSING]: 'closing',
        [ReadyState.CLOSED]: 'disconnected',
        [ReadyState.UNINSTANTIATED]: 'idle',
      })[readyState],
    [readyState],
  );

  const value = useMemo(
    () => ({
      userId,
      wsState,
      onlineUsers,
      messages,
      activePeerId,
      fileTransfers,
      setActivePeerId,
      sendDirectDM,
      sendPublicMessage,
      sendFile,
    }),
    [
      userId,
      wsState,
      onlineUsers,
      messages,
      activePeerId,
      fileTransfers,
      sendDirectDM,
      sendPublicMessage,
      sendFile,
    ],
  );

  return <SocpCtx.Provider value={value}>{children}</SocpCtx.Provider>;
}

export function useSocpContext() {
  const ctx = useContext(SocpCtx);
  if (!ctx) throw new Error('useSocpContext must be used within SocpProvider');
  return ctx;
}
