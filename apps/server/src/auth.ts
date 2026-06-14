import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import type { Repository } from "./db/repository.js";
import type { ApiKeyRow } from "./db/schema.js";
import { secureEquals, signPayload, verifyPayload } from "./security.js";

export interface HumanSession {
  purpose: "human-session";
  humanId: string;
  exp: number;
}

export interface AttachmentToken {
  purpose: "attachment";
  attachmentId: string;
  apiKeyId: string;
  exp: number;
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length).trim();
}

export function requireApiKey(
  request: FastifyRequest,
  repository: Repository,
): ApiKeyRow {
  const token = bearerToken(request);
  const apiKey = token ? repository.findApiKey(token) : undefined;
  if (!apiKey) {
    const error = new Error("Unauthorized");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
  return apiKey;
}

export function requireAdmin(request: FastifyRequest, config: AppConfig): void {
  const token = bearerToken(request);
  if (!token || !secureEquals(token, config.adminToken)) {
    const error = new Error("Unauthorized");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
}

export function createHumanSession(
  humanId: string,
  config: AppConfig,
  ttlSeconds = 30 * 24 * 60 * 60,
): string {
  return signPayload(
    {
      purpose: "human-session",
      humanId,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    },
    config.tokenSecret,
  );
}

function parseCookies(request: FastifyRequest): Record<string, string> {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      if (index < 0) return [];
      return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))]];
    }),
  );
}

export function requireHumanSession(
  request: FastifyRequest,
  config: AppConfig,
): HumanSession {
  const token = parseCookies(request).dth_session;
  if (!token) {
    const error = new Error("Unauthorized");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
  try {
    const payload = verifyPayload<HumanSession>(token, config.tokenSecret);
    if (payload.purpose !== "human-session") throw new Error("Wrong token purpose");
    return payload;
  } catch {
    const error = new Error("Unauthorized");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
}

export function setHumanSessionCookie(
  reply: FastifyReply,
  token: string,
  secure: boolean,
): void {
  reply.header(
    "set-cookie",
    `dth_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secure ? "; Secure" : ""}`,
  );
}
