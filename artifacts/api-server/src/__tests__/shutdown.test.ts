import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { attachShutdownHandlers } from "../shutdown.js";

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
  });
}

function listenOn(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function openIdleConnection(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForSocketClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve();
    socket.once("close", resolve);
    socket.once("error", resolve);
  });
}

function waitForServerClose(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.once("close", resolve);
  });
}

describe("graceful shutdown", () => {
  it("destroys idle keep-alive sockets immediately on shutdown", async () => {
    const port = await getRandomPort();
    const server = http.createServer((_req, res) => res.end("ok"));
    await listenOn(server, port);

    const exitCodes: number[] = [];
    const shutdown = attachShutdownHandlers(server, {
      exit: (code) => exitCodes.push(code),
    });

    const idleSocket = await openIdleConnection(port);
    assert.equal(idleSocket.destroyed, false, "socket should be open before shutdown");

    const serverClosed = waitForServerClose(server);
    const socketClosed = waitForSocketClose(idleSocket);

    shutdown("SIGTERM");

    await Promise.all([serverClosed, socketClosed]);

    assert.equal(idleSocket.destroyed, true, "idle socket should be destroyed after shutdown");
    assert.deepEqual(exitCodes, [0], "should exit with code 0");
  });

  it("destroys in-flight sockets only after the response finishes", async () => {
    const port = await getRandomPort();

    let capturedSocket: net.Socket | null = null;
    let resolveRequestArrived!: () => void;
    const requestArrived = new Promise<void>((resolve) => {
      resolveRequestArrived = resolve;
    });

    let resolveResponseReady!: () => void;
    const responseReady = new Promise<void>((resolve) => {
      resolveResponseReady = resolve;
    });

    const server = http.createServer(async (_req, res) => {
      capturedSocket = _req.socket;
      resolveRequestArrived();
      await responseReady;
      res.end("done");
    });
    await listenOn(server, port);

    const exitCodes: number[] = [];
    const shutdown = attachShutdownHandlers(server, {
      exit: (code) => exitCodes.push(code),
    });

    const agent = new http.Agent({ keepAlive: true });
    const responseConsumed = new Promise<void>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
          res.resume();
          res.once("end", resolve);
        })
        .once("error", reject);
    });

    await requestArrived;

    assert.ok(capturedSocket !== null, "socket should be captured from the request");
    assert.equal(capturedSocket!.destroyed, false, "socket should be alive before shutdown");

    const serverClosed = waitForServerClose(server);

    shutdown("SIGTERM");

    assert.equal(
      capturedSocket!.destroyed,
      false,
      "socket should NOT be destroyed immediately after shutdown — request is still in-flight",
    );

    resolveResponseReady();

    await Promise.all([responseConsumed, serverClosed]);

    assert.equal(capturedSocket!.destroyed, true, "socket should be destroyed after response finishes");
    assert.deepEqual(exitCodes, [0], "should exit with code 0 after in-flight request completes");
  });

  it("exits with code 0 when no connections are open", async () => {
    const port = await getRandomPort();
    const server = http.createServer((_req, res) => res.end("ok"));
    await listenOn(server, port);

    const exitCodes: number[] = [];
    const shutdown = attachShutdownHandlers(server, {
      exit: (code) => exitCodes.push(code),
    });

    const serverClosed = waitForServerClose(server);
    shutdown("SIGTERM");
    await serverClosed;

    assert.deepEqual(exitCodes, [0], "should exit with code 0 when no connections are open");
  });

  it("exits with code 1 when the grace period times out", async () => {
    const port = await getRandomPort();

    let resolveResponseReady!: () => void;
    const responseReady = new Promise<void>((resolve) => {
      resolveResponseReady = resolve;
    });

    let resolveRequestArrived!: () => void;
    const requestArrived = new Promise<void>((resolve) => {
      resolveRequestArrived = resolve;
    });

    const server = http.createServer(async (_req, res) => {
      resolveRequestArrived();
      await responseReady;
      res.end("done");
    });
    await listenOn(server, port);

    const exitCodes: number[] = [];
    const shutdown = attachShutdownHandlers(server, {
      gracePeriodMs: 30,
      exit: (code) => {
        exitCodes.push(code);
        resolveResponseReady();
      },
    });

    const agent = new http.Agent({ keepAlive: true });
    const responseConsumed = new Promise<void>((resolve) => {
      http
        .get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
          res.resume();
          res.once("end", resolve);
        })
        .on("error", resolve);
    });

    await requestArrived;

    const serverClosed = waitForServerClose(server);
    shutdown("SIGTERM");

    await Promise.all([responseConsumed, serverClosed]);

    assert.deepEqual(exitCodes, [1], "should exit exactly once with code 1 when grace period times out");
  });
});
