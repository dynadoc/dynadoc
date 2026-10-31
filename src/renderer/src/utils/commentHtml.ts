import DOMPurify from 'dompurify'

/**
 * A comment body is rich text written by whoever shares the document, and it
 * used to reach three `{@html}` sinks unsanitised. It is ordinary rich text --
 * not an editor node -- so DOMPurify's default allowlist is the right shape
 * here, unlike on the document path where it would strip every custom node.
 */
export function sanitizeCommentHtml(html: unknown): string {
  const value = typeof html === 'string' ? html : ''
  if (!value) return ''
  return DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [
      'p', 'br', 'span', 'div',
      'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark',
      'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
      'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
    ],
    ALLOWED_ATTR: ['href', 'title', 'lang', 'dir'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    ADD_ATTR: ['target', 'rel'],
    FORBID_ATTR: ['style'],
    RETURN_TRUSTED_TYPE: false
  })
}
