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
  loadPrivateKey,
  loadPublicKey,
  rsaDecrypt,
  aesDecrypt,
  verifyContentSig,
  verifyPublicContentSig,
  rsaEncrypt,
  computeContentSig,
  aesEncrypt,
  computePublicContentSig,
} from './crypto';

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
  const serverUri = useState(
    process.env.REACT_APP_WS_URL || 'ws://127.0.0.1:8080/ws',
  );
  const [userId, setUserId] = useState('');
  const [privateKeyB64, setPrivateKeyB64] = useState(null);
  const [publicKeyB64, setPublicKeyB64] = useState(null);
  const [knownPubkeys, setKnownPubkeys] = useState({});
  const [groupKeys, setGroupKeys] = useState({});

  useEffect(() => {
    const generatedUserId = crypto.randomUUID();
    setUserId(generatedUserId);
    generateRsaKeypair().then(({ private_key_b64, public_key_b64 }) => {
      setPrivateKeyB64(private_key_b64);
      setPublicKeyB64(public_key_b64);
    });
  }, []);

  // onlineUsers: [{ userId, meta }]
  const [onlineUsers, setOnlineUsers] = useState([]);
  // messages: { [peerId]: [{dir: "in"|"out", text: string, ts: number}] }
  const [messages, setMessages] = useState({});
  const [activePeerId, setActivePeerId] = useState(null);

  const sendUserHello = useCallback((sendMessage) => {
    if (!publicKeyB64 || !userId) return;
    const payload = {
      //TODO: check correct value
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
  }, [publicKeyB64, userId]);

  const {
    sendJsonMessage,
    lastJsonMessage: msg,
    readyState,
  } = useWebSocket(serverUri, {
    share: true,
    shouldReconnect: () => true,
    reconnectAttempts: process.env.RECONNECT_ATTEMPTS || 3,
    reconnectInterval: 2000,
    onOpen: () => {
      sendUserHello(sendJsonMessage);
    },
  });

  const onUserDeliver = useCallback(async msg => {
    try {
      const payload = msg.payload;
      const ciphertext = payload.ciphertext;
      const senderId = payload.sender;
      const senderPubB64 = payload.sender_pub;
      const contentSig = payload.content_sig;
      const to = msg.to;
      const ts = msg.ts;

      const privKey = await loadPrivateKey(privateKeyB64);
      const senderPubKey = await loadPublicKey(senderPubB64);

      // 1️⃣ Try decrypt as Direct Message (RSA)
      try {
        const plaintext = await rsaDecrypt(privKey, ciphertext);
        const verified = await verifyContentSig(
          senderPubKey,
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
        // not a DM
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
          senderPubKey,
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

      console.error('[SOCP] Unable to decrypt message: neither DM nor public');
      return null;
    } catch (err) {
      console.error('[SOCP] message processing failed:', err);
      return null;
    }
  }, []);

  const onCommandResponse = useCallback(msg => {
    try {
      const payload = msg.payload;
      const command = payload.command;
      const response = JSON.parse(payload.response || '{}');

      switch (command) {
        case '/list': {
          const users = response.users || [];
          console.info('[SOCP] Online users:', users.join(', '));

          setOnlineUsers(users.map(u => ({ userId: u, meta: {} })));
          break;
        }

        default:
          console.error('[SOCP] Unknown command response:', command, payload);
          break;
      }
    } catch (err) {
      console.error('[SOCP] Failed to handle COMMAND_RESPONSE:', err);
    }
  }, []);

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
          const privKey = await loadPrivateKey(privateKeyB64);
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

      // Nếu không có trong knownPubkeys thì thôi (giống Python: early return)
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

      // setMessages(prev => {
      //   const { [uid]: _msgs, ...rest } = prev;
      //   return rest;
      // });
    } catch (err) {
      console.error('[SOCP] Bad USER_REMOVE payload:', err);
    }
  }, []);

  const sendDirectDM = useCallback(
    async (targetId, messageText) => {
      if (!targetId || !messageText?.trim()) return;

      // 1) Kiểm tra đã biết pubkey của người nhận chưa
      const targetPubB64 = knownPubkeys[targetId];
      if (!targetPubB64) {
        console.error(`[SOCP] Unknown user: ${targetId}`);
        return;
      }

      try {
        const targetPubKey = await loadPublicKey(targetPubB64); // RSA-OAEP public
        const privKey = await loadPrivateKey(privateKeyB64); // PKCS8 private

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

        const privKey = await loadPrivateKey(privateKeyB64);
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

        // 6) Gửi lên server
        sendJsonMessage(body);

        // 7) Cập nhật UI lạc quan vào thread "public"
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

  useEffect(() => {
    if (!msg) return;
    const messageType = msg.type;

    switch (messageType) {
      case MESSAGE_TYPES.USER_DELIVER:
        onUserDeliver(msg, privateKeyB64, groupKeys).then(result => {
          if (!result) return;
          setMessages(prev => {
            const arr = prev[result.senderId] ? [...prev[result.senderId]] : [];
            arr.push({ dir: 'in', text: result.text, ts: msg.ts });
            return { ...prev, [result.senderId]: arr };
          });
        });
        break;
      case MESSAGE_TYPES.COMMAND_RESPONSE:
        onCommandResponse(msg);
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
      // case MESSAGE_TYPES.FILE_START:
      //   break;
      // case MESSAGE_TYPES.FILE_CHUNK:
      //   break;
      // case MESSAGE_TYPES.FILE_END:
      //   break;
      case MESSAGE_TYPES.ERROR:
        console.error('[SOCP] ← ERROR', msg);
        break;
      default:
        console.warn('[SOCP] ← Unknown message type', msg);
        break;
    }
  }, [msg]);

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
      setActivePeerId,
      sendDirectDM,
      sendPublicMessage,
    }),
    [
      userId,
      wsState,
      onlineUsers,
      messages,
      activePeerId,
      sendDirectDM,
      sendPublicMessage,
    ],
  );

  return <SocpCtx.Provider value={value}>{children}</SocpCtx.Provider>;
}

export function useSocpContext() {
  const ctx = useContext(SocpCtx);
  if (!ctx) throw new Error('useSocpContext must be used within SocpProvider');
  return ctx;
}
