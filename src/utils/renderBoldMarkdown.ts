// Escapes raw HTML first, then converts **bold** markdown into <strong>
// tags. Used to build the __html passed to dangerouslySetInnerHTML for
// translation strings — escaping first closes the XSS gap that would
// otherwise open up if a locale string ever contained a raw '<'/'>'/'&'.
const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const renderBoldMarkdown = (text: string): string =>
  escapeHtml(text).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
