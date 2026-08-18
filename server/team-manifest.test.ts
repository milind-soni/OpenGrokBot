import { describe, expect, it } from "vitest";

import { createTeamManifest, parseTeamManifest } from "./team-manifest.ts";

describe("team manifests", () => {
  it("exports portable member keys without room or runtime state", () => {
    const manifest = createTeamManifest(
      {
        name: "Launch Crew",
        memberIds: ["bot-a", "bot-b"],
      },
      [
        {
          id: "bot-a",
          name: "Mira",
          title: "Lead",
          description: "Coordinates the work",
          color: "purple",
          mascotExpression: "focused",
        },
        {
          id: "bot-b",
          name: "Mira",
          title: "Researcher",
          description: "Finds evidence",
          color: "cyan",
        },
      ],
    );

    expect(manifest).toMatchObject({
      format: "openmaus.team",
      version: 2,
      team: {
        name: "Launch Crew",
        members: [{ key: "mira" }, { key: "mira-2" }],
      },
    });
    expect(manifest.team).not.toHaveProperty("room");
    expect(JSON.stringify(manifest)).not.toMatch(/bot-a|bot-b|thread|model|permission|message/i);
  });

  it("parses legacy room files while dropping unrelated settings", () => {
    const manifest = parseTeamManifest({
      format: "openmaus.team",
      version: 1,
      team: {
        name: "  Research Lab  ",
        members: [
          {
            key: "analyst",
            name: " Ada ",
            title: " Analyst ",
            description: " Checks the evidence ",
            appearance: { color: "green" },
            modelSelection: { instanceId: "private-machine" },
            alwaysAllow: ["everything"],
          },
        ],
        room: {
          name: " Research Room ",
          bulletin: " Compare sources ",
          defaultResponder: { kind: "member", member: "analyst" },
          computer: "local",
        },
      },
    });

    expect(manifest.team.name).toBe("Research Lab");
    expect(manifest.team.members[0]).toEqual({
      key: "analyst",
      name: "Ada",
      title: "Analyst",
      description: "Checks the evidence",
      appearance: { color: "green" },
    });
    expect(manifest.team.room).toEqual({
      name: "Research Room",
      bulletin: "Compare sources",
      defaultResponder: { kind: "member", member: "analyst" },
    });
  });

  it("parses room-free version 2 files", () => {
    const manifest = parseTeamManifest({
      format: "openmaus.team",
      version: 2,
      team: {
        name: "Engineering",
        members: [
          {
            key: "lead",
            name: "Ada",
            title: "Tech Lead",
            description: "Coordinates the work",
            appearance: { color: "purple" },
          },
        ],
      },
    });

    expect(manifest.team.name).toBe("Engineering");
    expect(manifest.team).not.toHaveProperty("room");
  });

  it("rejects unsupported versions and dangling member references", () => {
    expect(() => parseTeamManifest({ format: "openmaus.team", version: 99 })).toThrow("not supported");
    expect(() =>
      parseTeamManifest({
        format: "openmaus.team",
        version: 1,
        team: {
          name: "Broken",
          members: [
            {
              key: "one",
              name: "One",
              appearance: { color: "blue" },
            },
          ],
          room: {
            name: "Broken",
            bulletin: "",
            defaultResponder: { kind: "member", member: "missing" },
          },
        },
      }),
    ).toThrow("Unknown default responder");
  });

  it("rejects duplicate member keys and malformed appearance data", () => {
    const member = {
      key: "analyst",
      name: "Ada",
      appearance: { color: "green" },
    };
    const room = {
      name: "Research",
      bulletin: "",
      defaultResponder: { kind: "everyone" },
    };
    expect(() =>
      parseTeamManifest({
        format: "openmaus.team",
        version: 1,
        team: { name: "Research", members: [member, member], room },
      }),
    ).toThrow("Duplicate member key");
    expect(() =>
      parseTeamManifest({
        format: "openmaus.team",
        version: 1,
        team: {
          name: "Research",
          members: [{ ...member, appearance: { color: 42 } }],
          room,
        },
      }),
    ).toThrow("appearance.color");
  });

  it("refuses to export values that the importer would reject", () => {
    expect(() =>
      createTeamManifest(
        {
          name: "x".repeat(101),
          memberIds: ["one"],
        },
        [
          {
            id: "one",
            name: "One",
            title: "",
            description: "",
            color: "blue",
          },
        ],
      ),
    ).toThrow("team.name is too long");

    const bots = Array.from({ length: 201 }, (_, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`,
      title: "",
      description: "",
      color: "green" as const,
    }));
    expect(() =>
      createTeamManifest(
        {
          name: "Too many",
          memberIds: bots.map((bot) => bot.id),
        },
        bots,
      ),
    ).toThrow("at most 200 members");
  });
});
