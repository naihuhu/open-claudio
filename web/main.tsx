import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'wired-elements'; // registers <wired-button>, <wired-input>, … custom elements (light sketch theme)
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
