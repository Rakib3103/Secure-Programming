import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import Chat from './pages/Chat';
import Login from './pages/Login';
import { SocpProvider } from './SocpContext';

import 'bootstrap/dist/css/bootstrap.min.css';
import '@chatscope/chat-ui-kit-styles/dist/default/styles.min.css';
import './App.css';

function App() {
  return (
    <SocpProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Chat />} />
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<div>Not found</div>} />
        </Routes>
      </Router>
    </SocpProvider>
  );
}

export default App;
