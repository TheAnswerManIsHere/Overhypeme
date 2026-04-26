import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveUserRole,
  isAtLeastLegendary,
  isAtLeastRegistered,
} from "../lib/userRole.js";

describe("deriveUserRole", () => {
  it("returns 'unregistered' for null tier and false admin", () => {
    assert.equal(deriveUserRole(null, false), "unregistered");
  });

  it("returns 'unregistered' for undefined tier and undefined admin", () => {
    assert.equal(deriveUserRole(undefined, undefined), "unregistered");
  });

  it("returns 'unregistered' for unknown tier", () => {
    assert.equal(deriveUserRole("garbage", false), "unregistered");
  });

  it("returns 'registered' for registered tier and false admin", () => {
    assert.equal(deriveUserRole("registered", false), "registered");
  });

  it("returns 'legendary' for legendary tier and false admin", () => {
    assert.equal(deriveUserRole("legendary", false), "legendary");
  });

  it("returns 'admin' when isAdmin is true regardless of tier", () => {
    assert.equal(deriveUserRole(null, true), "admin");
    assert.equal(deriveUserRole("registered", true), "admin");
    assert.equal(deriveUserRole("legendary", true), "admin");
    assert.equal(deriveUserRole("garbage", true), "admin");
  });
});

describe("isAtLeastLegendary", () => {
  it("returns true for legendary", () => {
    assert.equal(isAtLeastLegendary("legendary"), true);
  });

  it("returns true for admin", () => {
    assert.equal(isAtLeastLegendary("admin"), true);
  });

  it("returns false for registered", () => {
    assert.equal(isAtLeastLegendary("registered"), false);
  });

  it("returns false for unregistered", () => {
    assert.equal(isAtLeastLegendary("unregistered"), false);
  });
});

describe("isAtLeastRegistered", () => {
  it("returns true for registered", () => {
    assert.equal(isAtLeastRegistered("registered"), true);
  });

  it("returns true for legendary", () => {
    assert.equal(isAtLeastRegistered("legendary"), true);
  });

  it("returns true for admin", () => {
    assert.equal(isAtLeastRegistered("admin"), true);
  });

  it("returns false for unregistered", () => {
    assert.equal(isAtLeastRegistered("unregistered"), false);
  });
});
