import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './theme/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const ROOT_ID = 'root';

const container = document.getElementById(ROOT_ID);
if (container === null) {
  throw new Error(`The report page has no #${ROOT_ID} element to render into`);
}
createRoot(container).render(
  <StrictMode>
    <main>
      <h1>Lookover report</h1>
    </main>
  </StrictMode>,
);
