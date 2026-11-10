import React from 'react';
import ReactDOM from 'react-dom/client';

const BusinessApp: React.FC = () => {
  return (
    <div className="p-4 text-white">
      <h1 className="text-xl font-bold">WaMart Business Hub</h1>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <BusinessApp />
    </React.StrictMode>
  );
}
