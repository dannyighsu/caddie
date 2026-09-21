/**
 * RFC 2822 MIME builder for gmail.users.messages.send.
 *
 * Lifted from mcinteerj/openclaw-gmail (MIT) — builds a MIME buffer via
 * nodemailer's MailComposer, ready for base64url encoding.
 */

import MailComposer from "nodemailer/lib/mail-composer";

export interface MimeMessageOpts {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

export function buildMimeMessage(opts: MimeMessageOpts): Promise<Buffer> {
  const mail = new MailComposer({
    from: opts.from,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });

  return new Promise((resolvePromise, reject) => {
    mail.compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolvePromise(message);
    });
  });
}
