import type { Socket } from "net";
import type { Server } from "http";

type TrackedSocket = Socket & { _destroyOnIdle?: boolean };

export interface ShutdownOptions {
  gracePeriodMs?: number;
  exit?: (code: number) => void;
  onClose?: () => void;
  onTimeout?: () => void;
}

export function attachShutdownHandlers(
  server: Server,
  options: ShutdownOptions = {},
): (signal: string) => void {
  const {
    gracePeriodMs = 10_000,
    exit = (code) => process.exit(code),
    onClose,
    onTimeout,
  } = options;

  const sockets = new Set<TrackedSocket>();
  const socketInflight = new Map<TrackedSocket, number>();

  server.on("connection", (socket: TrackedSocket) => {
    sockets.add(socket);
    socketInflight.set(socket, 0);
    socket.once("close", () => {
      sockets.delete(socket);
      socketInflight.delete(socket);
    });
  });

  server.on("request", (_req, res) => {
    const socket = _req.socket as TrackedSocket;
    socketInflight.set(socket, (socketInflight.get(socket) ?? 0) + 1);
    res.once("finish", () => {
      const remaining = (socketInflight.get(socket) ?? 1) - 1;
      socketInflight.set(socket, remaining);
      if (remaining === 0 && socket._destroyOnIdle) {
        socket.destroy();
      }
    });
  });

  return function shutdown(_signal: string) {
    let exited = false;
    function safeExit(code: number) {
      if (exited) return;
      exited = true;
      exit(code);
    }

    const forceExitTimer = setTimeout(() => {
      if (onTimeout) onTimeout();
      safeExit(1);
    }, gracePeriodMs);
    forceExitTimer.unref();

    server.close(() => {
      clearTimeout(forceExitTimer);
      if (onClose) onClose();
      safeExit(0);
    });

    for (const socket of sockets) {
      if ((socketInflight.get(socket) ?? 0) > 0) {
        socket._destroyOnIdle = true;
      } else {
        socket.destroy();
      }
    }
  };
}
