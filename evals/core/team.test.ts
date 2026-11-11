import { describe, it, expect } from "vitest";
import { Anonymizer, AGENT_ADDRESS, realAddressAliases } from "./team.ts";
import { parseInboundPrompt } from "../scripts/extract-case.ts";

describe("Anonymizer", () => {
  const anon = () =>
    new Anonymizer(
      new Map([
        ["real.danny@gmail.com", "danny@team.example"],
        ["myagent@gmail.com", AGENT_ADDRESS],
      ]),
      [["Jane Q. Public", "Jane"]]
    );

  it("maps known people, keeps org names recognizable, hides freemail", () => {
    const a = anon();
    expect(a.text("cc real.danny@gmail.com")).toBe("cc danny@team.example");
    expect(a.text("bodas@posadas.com.mx")).toBe("bodas@posadas.example");
    expect(a.text("someone@hotmail.com and someone@hotmail.com")).toBe("person1@mail.example and person1@mail.example");
  });

  it("scrubs phone numbers but not dates or times", () => {
    const a = anon();
    expect(a.text("WhatsApp +52 415 123 4567 please")).toBe("WhatsApp +1 555 0100 please");
    expect(a.text("on 2026-09-25 at 12:00")).toBe("on 2026-09-25 at 12:00");
  });

  it("applies local scrubs before anything else", () => {
    expect(anon().text("From: Jane Q. Public <real.danny@gmail.com>")).toBe("From: Jane <danny@team.example>");
  });

  it("replaces the agent's inbox name when used as a greeting", () => {
    expect(anon().text("Hola Myagent, write to myagent@gmail.com")).toBe("Hola Buri, write to buri@assistant.example");
  });
});

describe("realAddressAliases", () => {
  it("maps every real member, including one with no fake counterpart", () => {
    const map = realAddressAliases([
      { id: "danny", name: "D", emails: ["real.danny@gmail.com", "d@work.com"], isOwner: true },
      { id: "betty", name: "B", emails: ["real.betty@gmail.com"], isOwner: false },
      { id: "carol", name: "C", emails: ["carol@corp.com"], isOwner: false },
    ]);
    expect(map.get("real.danny@gmail.com")).toBe("danny@team.example");
    expect(map.get("d@work.com")).toBe("danny@team.example");
    expect(map.get("real.betty@gmail.com")).toBe("betty@team.example");
    expect(map.get("carol@corp.com")).toBe("carol@team.example");
  });
});

describe("parseInboundPrompt", () => {
  const prompt = [
    "[Current time: Wednesday, September 23, 2026 at 9:03 AM PDT]",
    "",
    "This is an inbound-message run: …",
    "",
    "---",
    "",
    "Email envelope (context — not part of the message body):",
    "- Subject: Re: Visit",
    "- From: Ana <ana@venue.example>",
    "- To: buri@assistant.example",
    "- Cc: betty@team.example, danny@team.example",
    "- This is a group thread with 3 recipients. You are a direct (To) recipient.",
    "",
    "---",
    "",
    "Conversation history (for context — this is a continuing conversation):",
    "[Assistant]: Hi Ana,\n\nFriday works.\n\nBuri H.",
    "",
    "[Guest]: Great.\n\n[https://link.example] signature",
    "",
    "[Betty]: Thanks!",
    "",
    "---",
    "",
    "New message from [Guest]:",
    "Perfect, see you Friday",
  ].join("\n");

  it("recovers envelope, speakers, multi-paragraph turns and the new message", () => {
    const p = parseInboundPrompt(prompt);
    expect(p.now).toBe("Wednesday, September 23, 2026 at 9:03 AM PDT");
    expect(p.envelope).toEqual({
      subject: "Re: Visit",
      from: "Ana <ana@venue.example>",
      to: ["buri@assistant.example"],
      cc: ["betty@team.example", "danny@team.example"],
    });
    expect(p.history.map((t) => t.from)).toEqual(["agent", "guest", "betty"]);
    expect(p.history[0].text).toBe("Hi Ana,\n\nFriday works.\n\nBuri H.");
    expect(p.history[1].text).toContain("[https://link.example] signature");
    expect(p.sender).toBe("guest");
    expect(p.message).toBe("Perfect, see you Friday");
  });
});
