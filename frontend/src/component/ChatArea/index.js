import React, { useState } from 'react'
import { UserOutlined } from '@ant-design/icons';
import { Button, Input, Avatar } from 'antd';

const { TextArea } = Input;

function ChatArea() {
  const [text, setText] = useState("");       
  const [messages, setMessages] = useState([]); 
  
  const handleSend = () => {
    if (text.trim() === "") return; 
    setMessages([...messages, text]); 
    setText(""); 
  };

  return (
    <div style={{ padding: 16 }}>
      {/* Messages List */}
      <div style={{ marginBottom: 16 }}>
        {messages.map((msg, index) => (
          <div key={index} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            
            <div
              style={{
                background: '#f5f5f5',
                padding: '8px 12px',
                borderRadius: 8,
                maxWidth: 300,
              }}
            >
              {msg}
            </div>
            <Avatar style={{ backgroundColor: '#87d068', marginRight: 8 }} icon={<UserOutlined />} />
          </div>
        ))}
      </div>

      <div style={{
        position: 'relative'
      }}>
        {/* To input the messages */}
        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={100}
          placeholder="Please Input"
          style={{ height: 120, resize: 'none' }}
        />
        <Button type="primary"
          onClick={handleSend}
          style={{
            position: 'absolute',
            bottom: 8,
            right: 8,
          }}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

export default ChatArea;
