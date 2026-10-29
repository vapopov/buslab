import './vendor/prism-config.mjs';
import './vendor/prism-core.min.js';
import './vendor/prism-clike.min.js';
import './vendor/prism-javascript.min.js';

export function highlightJavaScript(source) {
  return globalThis.Prism.highlight(source, globalThis.Prism.languages.javascript, 'javascript');
}

export function attachScriptHighlight(editor, preview, code) {
  const container = editor.parentElement;
  const syncScroll = () => {
    preview.scrollTop = editor.scrollTop;
    preview.scrollLeft = editor.scrollLeft;
  };
  const render = () => {
    try {
      // The extra line preserves the caret's final empty line in the mirror.
      code.innerHTML = highlightJavaScript(editor.value + '\n');
      container.classList.add('highlighted');
      syncScroll();
    } catch {
      // Keep an ordinary readable editor if highlighting ever fails.
      container.classList.remove('highlighted');
    }
  };
  let scheduled = false;
  editor.addEventListener('input', () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; render(); });
  });
  editor.addEventListener('scroll', syncScroll);
  render();
}
