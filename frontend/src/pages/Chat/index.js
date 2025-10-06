import {
  Avatar,
  ChatContainer,
  Conversation,
  ConversationHeader,
  ConversationList,
  MainContainer,
  Message,
  MessageInput,
  MessageList,
  MessageSeparator,
  Sidebar,
} from '@chatscope/chat-ui-kit-react';
import { useSocpContext } from '../../SocpContext';
import React from 'react';

const AVATARS = [
  'https://chatscope.io/storybook/react/assets/lilly-aj6lnGPk.svg',
  'https://chatscope.io/storybook/react/assets/joe-v8Vy3KOS.svg',
  'https://chatscope.io/storybook/react/assets/emily-xzL8sDL2.svg',
  'https://chatscope.io/storybook/react/assets/kai-5wHRJGb2.svg',
  'https://chatscope.io/storybook/react/assets/akane-MXhWvx63.svg',
  'https://chatscope.io/storybook/react/assets/eliot-JNkqSAth.svg',
  'https://chatscope.io/storybook/react/assets/zoe-E7ZdmXF0.svg',
  'https://chatscope.io/storybook/react/assets/patrik-yC7svbAR.svg',
];

const GROUP_AVATAR = 'group.jpeg';

const GROUP_ID = 'public';
const GROUP_NAME = '#public';

const avatarFor = userId => {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return AVATARS[h % AVATARS.length];
};

export default function ChatPage() {
  const {
    wsState,
    onlineUsers,
    userId,
    activePeerId,
    setActivePeerId,
    messages,
    sendDirectDM,
    sendPublicMessage,
    sendFile,
  } = useSocpContext();
  console.log("message in chat page", { messages });

  return (
    <div
      style={{ height: '100vh' }}
      className="d-flex flex-column overflow-hidden"
    >
      <MainContainer responsive>
        <Sidebar position="left">
          <ConversationList>
            <Conversation
              key={GROUP_ID}
              name={GROUP_NAME}
              onClick={() => setActivePeerId(GROUP_ID)}
              active={activePeerId === GROUP_ID}
            >
              <Avatar name={GROUP_NAME} src={GROUP_AVATAR} />
            </Conversation>
            {Array.from(
              new Map(
                onlineUsers
                  .filter(u => u.userId && u.userId !== userId)
                  .map(u => [u.userId, u]), // Map(key=userId, value=user)
              ).values(),
            ).map(u => {
              const uid = u.userId;
              const src = avatarFor(uid);
              const isActive = activePeerId === uid;

              return (
                <Conversation
                  key={uid}
                  name={uid}
                  onClick={() => setActivePeerId(uid)}
                  active={isActive}
                >
                  <Avatar name={uid} src={src} status="available" />
                </Conversation>
              );
            })}
          </ConversationList>
        </Sidebar>
        <ChatContainer>
          <ConversationHeader>
            <ConversationHeader.Back />
            {typeof activePeerId === 'string' && activePeerId ? (
              activePeerId === GROUP_ID ? (
                [
                  <Avatar
                    key="hdr-avatar"
                    name={GROUP_NAME}
                    src={GROUP_AVATAR}
                  />,
                  <ConversationHeader.Content
                    key="hdr-content"
                    userName={GROUP_NAME}
                  />,
                ]
              ) : (
                [
                  <Avatar
                    key="hdr-avatar"
                    name={activePeerId}
                    src={avatarFor(activePeerId)}
                  />,
                  <ConversationHeader.Content
                    key="hdr-content"
                    userName={activePeerId}
                  />,
                ]
              )
            ) : (
              <ConversationHeader.Content userName="Select a user..." />
            )}
          </ConversationHeader>
          <MessageList>
            {activePeerId ? (
              messages[activePeerId] && messages[activePeerId].length > 0 ? (
                messages[activePeerId].map((m, _i, arr) => {
                  console.log("messages", {arr})
                  const uniqueKey = `${m.ts}-${m.from || 'me'}-${m.fileUrl || m.text}`;
                  return (
                  <React.Fragment key={uniqueKey}>
                    {activePeerId === GROUP_ID && m.dir !== 'out' && (
                      <div
                        key={`hdr-${uniqueKey}`}
                        className="cs-message__sender-name"
                        style={{
                          fontSize: '0.72em',
                          color: '#64748b',
                          margin: '2px 0 2px 48px',
                        }}
                      >
                        {m.from || 'someone'}
                      </div>
                    )}
                    <Message
                      key={`msg-${uniqueKey}`}
                      model={{
                        direction: m.dir === 'out' ? 'outgoing' : 'incoming',
                        // message: m.text,
                        position: 'single',
                        sentTime: new Date(m.ts).toLocaleTimeString(),
                        sender:
                          m.dir === 'out'
                            ? 'Me'
                            : activePeerId === GROUP_ID
                              ? m.from || 'someone'
                              : activePeerId,
                      }}
                    >
                      {m.dir !== 'out' && (
                        <Avatar
                          name={m.from || activePeerId}
                          src={avatarFor(m.from || activePeerId)}
                        />
                      )}
                      <Message.CustomContent>
                        {m.fileUrl ? (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <span role="img" aria-label="file">
                              📎
                            </span>
                            <strong>
                              {
                                m.text
                                  .replace(/\\[File\\]\\s*/i, '')
                                  .split(':')[0]
                              }
                            </strong>
                            <a
                              href="#"
                              onClick={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                const name =
                                  (m.text || '')
                                    .replace(/\[File\]\s*/i, '')
                                    .split(':')[0]
                                    .trim() || 'download.bin';
                                const a = document.createElement('a');
                                a.href = m.fileUrl;
                                a.download = name;
                                document.body.appendChild(a);
                                a.click();
                                a.remove();
                              }}
                              style={{
                                marginLeft: 6,
                                color: '#2563eb',
                                textDecoration: 'underline',
                              }}
                            >
                              Download
                            </a>
                          </div>
                        ) : (
                          <span>{m.text}</span>
                        )}
                      </Message.CustomContent>
                    </Message>
                  </React.Fragment>
                )})
              ) : (
                <MessageSeparator content="No messages yet" />
              )
            ) : (
              <MessageSeparator content="Select a user to start chatting" />
            )}
          </MessageList>
          <MessageInput
            placeholder={
              activePeerId
                ? `Message ${activePeerId === GROUP_ID ? GROUP_NAME : activePeerId}`
                : 'Select a user to start chatting...'
            }
            onSend={text => {
              if (!activePeerId || !text.trim()) return;
              if (activePeerId === GROUP_ID) {
                sendPublicMessage(text.trim());
              } else {
                sendDirectDM(activePeerId, text.trim());
              }
            }}
            onAttachClick={() => {
              if (!activePeerId) return;
              const input = document.createElement('input');
              input.type = 'file';
              input.onchange = e => {
                const file = e.target.files?.[0];
                if (!file) return;
                const mode = activePeerId === GROUP_ID ? 'public' : 'dm';
                const target =
                  activePeerId === GROUP_ID ? 'public' : activePeerId;
                sendFile(target, file, mode);
              };
              input.click();
            }}
            disabled={!activePeerId}
          />
        </ChatContainer>
      </MainContainer>
      <div
        className="text-center py-1"
        style={{ fontSize: 12, color: '#64748b' }}
      >
        SOCP WS: {wsState} | User: <b>{userId}</b>
      </div>
    </div>
  );
}
