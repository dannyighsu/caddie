/**
 * HTML→text conversion for the email channel.
 *
 * Pure and dependency-free (like ./strip) so it can be unit-tested without
 * dragging in the Gmail client or the database.
 */

/**
 * Used in both directions: to read a message that arrives HTML-only, and to
 * derive the `text/plain` alternative for an outbound HTML email.
 *
 * Link destinations and list markers are preserved deliberately. A bare
 * tag-strip turns `<a href="...">the doc</a>` into "the doc" and throws the URL
 * away — harmless when the HTML is merely a fallback for reading, but for the
 * plain-text alternative of a message *we* are sending it silently drops the
 * only copy of the link a text-only client would ever see.
 */
export function htmlToText(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    // Whitespace hugging a block-level tag is insignificant in HTML, but a naive
    // tag-strip turns the newline+indent between `<ul>` and `<li>` into a line
    // containing a single space. Drop it before anything else runs. Inline tags
    // (a, span, strong, em) are deliberately excluded — the space between two of
    // those IS meaningful.
    .replace(
      /\s*<(\/?)(p|div|ul|ol|li|table|tr|td|th|h[1-6]|blockquote|pre|br)\b([^>]*)>\s*/gi,
      "<$1$2$3>",
    )
    .replace(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_match, href: string, inner: string) => {
        const label = inner.replace(/<[^>]+>/g, "").trim();
        if (!href || !label) return label || href;
        // Anchor text that already *is* the URL needs no parenthetical.
        return label === href ? label : `${label} (${href})`;
      },
    )
    // Opening <li> carries the bullet; its closer is left to the block rule
    // below, so items don't end up separated by blank lines.
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    // Cells need a visible separator; without one a table row collapses into an
    // unreadable run-on. The trailing separator is trimmed per line below.
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|pre|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    // &amp; last: decoding it earlier would let "&amp;lt;" become "<".
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ \|[ \t]*$/gm, "")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
