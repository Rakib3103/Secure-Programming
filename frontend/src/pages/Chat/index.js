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
  Search,
  Sidebar,
} from '@chatscope/chat-ui-kit-react';
import { useSocpContext } from '../../SocpContext';

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
  } = useSocpContext();
  console.log({ onlineUsers });

  return (
    <div
      style={{ height: '100vh' }}
      className="d-flex flex-column overflow-hidden"
    >
      <MainContainer responsive>
        <Sidebar position="left">
          <Search placeholder="Search..." />
          <ConversationList>
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
                  key={uid} // key duy nhất theo userId
                  name={uid} // hiển thị userId
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
            ) : (
              <ConversationHeader.Content userName="Select a user..." />
            )}
          </ConversationHeader>
          <MessageList>
            {activePeerId ? (
              messages[activePeerId] && messages[activePeerId].length > 0 ? (
                messages[activePeerId].map((m, i) => (
                  <Message
                    key={i}
                    model={{
                      direction: m.dir === 'out' ? 'outgoing' : 'incoming',
                      message: m.text,
                      position: 'single',
                      sentTime: new Date(m.ts).toLocaleTimeString(),
                      sender: m.dir === 'out' ? 'Me' : activePeerId,
                    }}
                  >
                    {m.dir !== 'out' && (
                      <Avatar
                        name={activePeerId}
                        src={avatarFor(activePeerId)}
                      />
                    )}
                  </Message>
                ))
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
                ? `Message ${activePeerId}`
                : 'Select a user to start chatting...'
            }
            attachButton={false}
            onSend={text => {
              if (!activePeerId || !text.trim()) return;
              sendDirectDM(activePeerId, text.trim());
            }}
            disabled={!activePeerId}
          />
        </ChatContainer>
      </MainContainer>
      <div
        className="text-center py-1"
        style={{ fontSize: 12, color: '#64748b' }}
      >
        SOCP WS: {wsState}
      </div>
    </div>
  );
}
