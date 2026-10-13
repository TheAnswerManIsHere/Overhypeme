/**
 * #642: the port a boot test hands to a child server must be one no other
 * process in the run can be given.
 *
 * The boot tests assert "the port never opened" by connecting to it. A port
 * taken from `listen(0)` and closed again is back in the kernel's ephemeral
 * pool, and the other shards' supertest requests each `listen(0)` too, so one
 * of them can be handed the same port while the refusing child is being
 * watched — a connection is accepted by somebody else's server and the test
 * fails on a refusal that worked. Below the ephemeral range, the kernel never
 * hands the port out to anyone who did not name it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { ephemeralPortFloor, firstBindable, portForChildProcess } from "./helpers/childProcessPort.js";

describe("portForChildProcess", () => {
  it("never returns a port the kernel can hand to a listen(0) elsewhere", async () => {
    const floor = ephemeralPortFloor();
    for (let i = 0; i < 50; i++) {
      const port = await portForChildProcess();
      assert.ok(port < floor, `port ${port} is inside the ephemeral range (floor ${floor})`);
      assert.ok(port >= 1024, `port ${port} is privileged`);
    }
  });

  it("returns a port that is free to bind", async () => {
    const port = await portForChildProcess();
    const server = createServer();
    await new Promise<void>((resolveP, rejectP) => {
      server.once("error", rejectP);
      server.listen(port, "127.0.0.1", () => resolveP());
    });
    assert.equal((server.address() as AddressInfo).port, port);
    await new Promise((resolveP) => server.close(resolveP));
  });

  it("passes over a candidate someone is already listening on", async () => {
    const held = createServer();
    const heldPort = await portForChildProcess();
    await new Promise<void>((resolveP) => held.listen(heldPort, "127.0.0.1", () => resolveP()));
    try {
      const next = heldPort + 1 < ephemeralPortFloor() ? heldPort + 1 : heldPort - 1;
      assert.equal(await firstBindable([heldPort, next]), next);
    } finally {
      await new Promise((resolveP) => held.close(resolveP));
    }
  });
});
