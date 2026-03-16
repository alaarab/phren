// --- Copy buttons for all code blocks in docs pages ---
(function() {
  document.querySelectorAll('.docs-content pre > code').forEach(code => {
    const pre = code.parentElement;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.textContent = 'copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'copy';
          btn.classList.remove('copied');
        }, 1800);
      } catch {
        btn.textContent = 'copy';
      }
    });
    pre.appendChild(btn);
  });
})();
