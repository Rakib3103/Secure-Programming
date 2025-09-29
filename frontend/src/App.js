import './App.css';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import ChatPage from './pages/Chatpage';
import LoginPage from './pages/LoginPage';

function App() {
  return (
    <Router>

        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/login" element={<LoginPage />} />
           <Route path="*" element={<div>Not found</div>} />
        </Routes>
    </Router>
  );
}

export default App;
