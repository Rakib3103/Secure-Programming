import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import 'antd/dist/reset.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/Chatpage';
import ChatArea from './component/ChatArea';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    {/*  <ChatArea />  */}
    {/* <LoginPage/> */}
    {/* <ChatPage/> */} 
  </React.StrictMode>
);

reportWebVitals();
