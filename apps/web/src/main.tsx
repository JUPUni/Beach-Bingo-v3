import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/lilita-one/400.css';
import '@fontsource/luckiest-guy/400.css';
import '@fontsource-variable/fredoka/index.css';
import './styles/global.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
