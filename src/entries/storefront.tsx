import React from 'react';
import ReactDOM from 'react-dom/client';
import { StorefrontApp } from '../pages/StorefrontApp.js';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <StorefrontApp />
    </React.StrictMode>
  );
}
