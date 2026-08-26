import { describe, it, expect, vi, afterEach } from "vitest";
import { teamRoster, teamOwner, teamMember, teamMemberLabel, teamLookup } from "./roster.js";

const TWO = {
  TEAM_MEMBER_A_NAME: "Danny",
  TEAM_MEMBER_A_EMAIL: "danny@example.com, Danny@work.example.com",
  TEAM_MEMBER_A_SLACK_ID: "U_DANNY",
  TEAM_MEMBER_B_NAME: "Betty",
  TEAM_MEMBER_B_EMAIL: "betty@example.com",
  TEAM_MEMBER_B_TELEGRAM_ID: "999",
} as NodeJS.ProcessEnv;

afterEach(() => vi.restoreAllMocks());

describe("teamRoster", () => {
  it("reads configured slots in order", () => {
    expect(teamRoster(TWO).map((m) => m.id)).toEqual(["danny", "betty"]);
  });

  it("derives an id from the name and normalizes emails", () => {
    const [danny] = teamRoster(TWO);
    expect(danny.id).toBe("danny");
    expect(danny.name).toBe("Danny");
    expect(danny.emails).toEqual(["danny@example.com", "danny@work.example.com"]);
  });

  it("honors an explicit id so a rename doesn't orphan history", () => {
    const env = { ...TWO, TEAM_MEMBER_A_NAME: "Daniel", TEAM_MEMBER_A_ID: "danny" };
    expect(teamRoster(env)[0]).toMatchObject({ id: "danny", name: "Daniel" });
  });

  it("slugifies a multi-word name", () => {
    expect(teamRoster({ TEAM_MEMBER_A_NAME: "Ana María" } as NodeJS.ProcessEnv)[0].id)
      .toBe("ana-mar-a");
  });

  it("treats a slot with no name as unused, and skips gaps", () => {
    const env = { TEAM_MEMBER_B_NAME: "Betty" } as NodeJS.ProcessEnv;
    expect(teamRoster(env).map((m) => m.id)).toEqual(["betty"]);
  });

  it("returns an empty roster when nothing is configured", () => {
    expect(teamRoster({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("drops a duplicate id rather than letting one member shadow the other", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { TEAM_MEMBER_A_NAME: "Sam", TEAM_MEMBER_B_NAME: "Sam" } as NodeJS.ProcessEnv;
    expect(teamRoster(env)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicates member id "sam"'));
  });
});

describe("teamOwner", () => {
  it("is the first configured slot", () => {
    expect(teamOwner(TWO)?.id).toBe("danny");
  });

  it("is the first *configured* slot, not slot A, when A is empty", () => {
    expect(teamOwner({ TEAM_MEMBER_B_NAME: "Betty" } as NodeJS.ProcessEnv)?.id).toBe("betty");
  });

  it("is null on an unconfigured instance", () => {
    expect(teamOwner({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("teamMember / teamMemberLabel", () => {
  it("looks a member up by id", () => {
    expect(teamMember("betty", TWO)?.name).toBe("Betty");
  });

  it("returns null for an id not on the roster", () => {
    expect(teamMember("nobody", TWO)).toBeNull();
  });

  it("falls back to the raw id so pre-rename history still renders", () => {
    expect(teamMemberLabel("someone-who-left", TWO)).toBe("someone-who-left");
  });
});

describe("teamLookup", () => {
  it("maps every address to its member, case-insensitively", () => {
    const map = teamLookup("emails", TWO);
    expect(map.get("danny@example.com")).toBe("danny");
    expect(map.get("danny@work.example.com")).toBe("danny");
    expect(map.get("betty@example.com")).toBe("betty");
  });

  it("maps single-valued channel ids and omits members without one", () => {
    expect(teamLookup("slackId", TWO)).toEqual(new Map([["u_danny", "danny"]]));
    expect(teamLookup("telegramId", TWO)).toEqual(new Map([["999", "betty"]]));
  });
});
