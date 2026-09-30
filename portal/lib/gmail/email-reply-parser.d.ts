// Minimal ambient types for email-reply-parser (ships no bundled types).
declare module "email-reply-parser" {
  class Fragment {
    getContent(): string;
    isSignature(): boolean;
    isQuoted(): boolean;
    isHidden(): boolean;
  }
  class Email {
    getFragments(): Fragment[];
    getVisibleText(): string;
    getQuotedText(): string;
  }
  export default class EmailReplyParser {
    read(text: string): Email;
    parseReply(text: string): string;
  }
}
