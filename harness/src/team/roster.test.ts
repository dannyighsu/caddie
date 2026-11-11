import { describe, it, expect } from "vitest";
import { teamMemberId, teamOwner, teamMember, teamMemberLabel, teamLookup, type TeamMember } from "./roster.js";

const TWO: TeamMember[] = [
  {
    id: "danny",
    name: "Danny",
    emails: ["danny@example.com", "danny@work.example.com"],
    slackId: "U_DANNY",
    isOwner: true,
  },
  { id: "betty", name: "Betty", emails: ["betty@example.com"], telegramId: "999", isOwner: false },
];

describe("teamMemberId", () => {
  it("slugifies a name", () => {
    expect(teamMemberId("Danny")).toBe("danny");
    expect(teamMemberId("  Ana María ")).toBe("ana-mar-a");
  });
});

describe("teamOwner", () => {
  it("is the member flagged as owner, wherever they sit", () => {
    expect(teamOwner(TWO)?.id).toBe("danny");
    expect(teamOwner([...TWO].reverse())?.id).toBe("danny");
  });

  it("is null when no one is the owner", () => {
    expect(teamOwner([])).toBeNull();
    expect(teamOwner([{ ...TWO[1] }])).toBeNull();
  });
});

describe("teamMember / teamMemberLabel", () => {
  it("looks a member up by id", () => {
    expect(teamMember(TWO, "betty")?.name).toBe("Betty");
  });

  it("returns null for an id not on the roster", () => {
    expect(teamMember(TWO, "nobody")).toBeNull();
  });

  it("falls back to the raw id so a removed member's history still renders", () => {
    expect(teamMemberLabel(TWO, "someone-who-left")).toBe("someone-who-left");
  });
});

describe("teamLookup", () => {
  it("maps every address to its member, case-insensitively", () => {
    const map = teamLookup(TWO, "emails");
    expect(map.get("danny@example.com")).toBe("danny");
    expect(map.get("danny@work.example.com")).toBe("danny");
    expect(map.get("betty@example.com")).toBe("betty");
  });

  it("maps single-valued channel ids and omits members without one", () => {
    expect(teamLookup(TWO, "slackId")).toEqual(new Map([["u_danny", "danny"]]));
    expect(teamLookup(TWO, "telegramId")).toEqual(new Map([["999", "betty"]]));
  });
});
