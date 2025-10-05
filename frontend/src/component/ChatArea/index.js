import React, { useRef, useState } from 'react';
import '@chatscope/chat-ui-kit-styles/dist/default/styles.min.css';
import {
  MainContainer,
  ChatContainer,
  MessageList,
  Message,
  MessageInput,
  Avatar
} from '@chatscope/chat-ui-kit-react';

function ChatArea({ chatId, chatMessages, setChatMessages }) {


  const fileInputRef = useRef(null);
  const messages = chatMessages[chatId] || [];
  /**
   * To set the profile pictures to every user for the first time
   */
  const avatarSrc = [
    'https://chatscope.io/storybook/react/assets/eliot-JNkqSAth.svg',
    'https://chatscope.io/storybook/react/assets/akane-MXhWvx63.svg',
    'https://chatscope.io/storybook/react/assets/joe-v8Vy3KOS.svg'
  ]
  const [userAvatars, setUserAvatars] = useState({});
  const getAvatar = (sender) => {
    if (!userAvatars[sender]) {
      const randomAvatar = avatarSrc[Math.floor(Math.random() * avatarSrc.length)];
      setUserAvatars(prev => ({ ...prev, [sender]: randomAvatar }));
      return randomAvatar;
    }
    return userAvatars[sender];
  };

  const handleSend = (text) => {
    if (!text.trim()) return;
    const newMsg = {
      message: text,
      sentTime: new Date().toLocaleTimeString(),
      sender: "Tom",
      avatar: getAvatar("Tom"),
      direction: "outgoing"
    };
    setChatMessages({
      ...chatMessages,
      [chatId]: [...messages, newMsg]
    });

    /* To imitate some is sending a message to you */
    setTimeout(() => {
      const replyMsg = {
        message: "This is an imitating message" , 
        sentTime: new Date().toLocaleTimeString(),
        sender: "Jerry",
        avatar: getAvatar("Jerry"),
        direction: "incoming"
      };
      setChatMessages((prev) => ({
        ...prev,
        [chatId]: [...(prev[chatId] || []), replyMsg]
      }));
    }, 3000);
  };

  // Click the file attach button
  const handleFileAttach = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const newMsg = {
      message: `${file.name}`,
      sentTime: new Date().toLocaleTimeString(),
      sender: "Tom",
      avatar: getAvatar("Tom"),
      direction: "outgoing"
    };
    setChatMessages({
      ...chatMessages,
      [chatId]: [...messages, newMsg]
    });
    e.target.value = null;
  };

  return (
    <div style={{ position: "relative", height: "500px" }}>
      <MainContainer>
        <ChatContainer>
          <MessageList>
            {messages.map((msg, index) => (
              <Message
                key={index}
                model={{
                  message: msg.message,
                  sender: msg.sender,
                  direction: msg.direction
                }}
              >
                <Message.Header>{msg.sender}</Message.Header>
                <Avatar name={msg.sender} src={msg.avatar} />
                <Message.Footer>{msg.sentTime}</Message.Footer>
              </Message>
            ))}
          </MessageList>
          <MessageInput
            placeholder="Type message here"
            /* Used for sending a messages */
            onSend={handleSend}
            /* Used for attach a file */
            onAttachClick={handleFileAttach}
          />
        </ChatContainer>
      </MainContainer>

      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
}

export default ChatArea;
