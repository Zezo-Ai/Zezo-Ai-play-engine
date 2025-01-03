import { createRoot } from 'react-dom/client';

import { MainLayout } from './components/MainLayout.mjs';
import { jsx } from './jsx.mjs';


import '@playcanvas/pcui/styles';

function main() {
    // render out the app
    const container = document.getElementById('app');
    if (!container) {
        return;
    }
    const root = createRoot(container);
    root.render(jsx(MainLayout, null));
}

main();
