import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { isAndroidApp } from './services/androidBridge';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find the PRAHA root element.');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register PWA service worker on web (Android APK serves bundled assets locally).
if ('serviceWorker' in navigator && import.meta.env.PROD && !isAndroidApp()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
