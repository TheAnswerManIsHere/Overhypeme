import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSession, type SessionData } from "../lib/auth";
import { isAdminById } from "./auth";

const router: IRouter = Router();

const SALT_ROUNDS = 10;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

const IS_PRODUCTION = process.env.NODE_ENV === "production";

function setSessionCookie(res: Response, sid: string) {
  const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
  res.cookie("sid", sid, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

router.post("/auth/register", async (req: Request, res: Response) => {
  const { username, password, email } = req.body as {
    username?: string;
    password?: string;
    email?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    res.status(400).json({
      error: "Username must be 3–30 characters, letters, numbers, or underscores only",
    });
    return;
  }

  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  if (password.length > 128) {
    res.status(400).json({ error: "Password must be 128 characters or fewer" });
    return;
  }

  if (email && typeof email === "string") {
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: "Email is already in use" });
      return;
    }
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (existing) {
    res.status(409).json({ error: "Username is already taken" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const [user] = await db
    .insert(usersTable)
    .values({
      username,
      passwordHash,
      email: email || null,
      firstName: username,
      captchaVerified: false,
    })
    .returning();

  const sessionData: SessionData = {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
    access_token: "",
    captchaVerified: false,
    isAdmin: user.isAdmin || isAdminById(user.id),
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
  });
});

router.post("/auth/local-login", async (req: Request, res: Response) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Invalid input types" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
    access_token: "",
    captchaVerified: user.captchaVerified,
    isAdmin: user.isAdmin || isAdminById(user.id),
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
  });
});

export default router;
