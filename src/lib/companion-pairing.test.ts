import { describe, expect, it } from "vitest";
import { companionPairingLink } from "./companion-pairing";

describe("companionPairingLink", () => {
  const token = `omb_pair_${"a".repeat(43)}`;

  it("carries the dialable address, one-time token, fallback code, and display name", () => {
    const link = companionPairingLink({
      address: "macbook.tail1234.ts.net",
      port: 8810,
      code: "004209",
      token,
      name: "Milind's Mac",
    });

    const url = new URL(link!);
    expect(url.protocol).toBe("openmausbot:");
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("address")).toBe("macbook.tail1234.ts.net:8810");
    expect(url.searchParams.get("token")).toBe(token);
    expect(url.searchParams.get("code")).toBe("004209");
    expect(url.searchParams.get("name")).toBe("Milind's Mac");
  });

  it("refuses to make a link from an invalid pairing window", () => {
    expect(companionPairingLink({ address: "", port: 8810, code: "123456", token })).toBeNull();
    expect(companionPairingLink({ address: "mac.local", port: 0, code: "123456", token })).toBeNull();
    expect(companionPairingLink({ address: "mac.local", port: 8810, code: "12345", token })).toBeNull();
    expect(companionPairingLink({ address: "mac.local", port: 8810, code: "123456", token: "weak" })).toBeNull();
  });

  it("makes an IPv6 address unambiguous", () => {
    const link = companionPairingLink({ address: "2001:db8::1", port: 8810, code: "123456", token });
    expect(new URL(link!).searchParams.get("address")).toBe("[2001:db8::1]:8810");
  });
});
