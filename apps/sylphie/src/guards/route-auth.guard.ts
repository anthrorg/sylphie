import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from './auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * RouteAuthGuard — global default-deny gate (TK-109).
 *
 * Wired as APP_GUARD in app.module.ts. Every HTTP route is denied by default
 * unless it passes ONE of:
 *
 *   1. @Public() metadata on the handler or controller (reflector allowlist —
 *      the known-public routes: container healthcheck, login/register, the
 *      anonymous-read metrics/observatory + supervisor status/verdicts
 *      endpoints already confirmed to have no live Authorization-sending
 *      consumer today).
 *   2. A valid Bearer JWT, verified via the existing AuthGuard/jwt.verify
 *      path (reused as-is — this is not a new auth mechanism).
 *   3. The request originates from loopback (127.0.0.1 / ::1) AND
 *      ALLOW_LOCALHOST_MUTATIONS is enabled (defaults to true outside
 *      production) — keeps local dev and the e2e/supertest harness working
 *      without minting a JWT for every request, and is required precisely
 *      because branch 2 silently and permanently fails shut if JWT_SECRET is
 *      unset on Railway (auth.guard.ts never crashes the process on a bad
 *      secret, it just always 401s) — this branch is the one that cannot
 *      deadlock regardless of JWT_SECRET provisioning.
 *
 * Non-HTTP execution contexts (WS/RPC) short-circuit to true — Nest guards
 * never intercept the raw WS handshake/handleConnection lifecycle hook
 * anyway; per-message gateway authorization (if any) is unchanged and out of
 * this guard's scope.
 */
@Injectable()
export class RouteAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authGuard: AuthGuard,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // Branch 2: a valid Bearer JWT via the existing AuthGuard.
    try {
      if (this.authGuard.canActivate(context)) {
        return true;
      }
    } catch {
      // Falls through to branch 3 — a missing/invalid token is not fatal
      // here, the localhost/env-gate branch gets a chance too.
    }

    // Branch 3: loopback origin AND ALLOW_LOCALHOST_MUTATIONS enabled.
    const request = context.switchToHttp().getRequest();
    if (this.isLoopback(request) && this.localhostMutationsAllowed()) {
      return true;
    }

    throw new UnauthorizedException();
  }

  private isLoopback(request: {
    ip?: string;
    connection?: { remoteAddress?: string };
    socket?: { remoteAddress?: string };
  }): boolean {
    const addr =
      request.ip ?? request.connection?.remoteAddress ?? request.socket?.remoteAddress ?? '';
    return (
      addr === '127.0.0.1' ||
      addr === '::1' ||
      addr === '::ffff:127.0.0.1' ||
      addr === 'localhost'
    );
  }

  private localhostMutationsAllowed(): boolean {
    const raw = this.configService.get<string>('ALLOW_LOCALHOST_MUTATIONS');
    if (raw === undefined) {
      // Default: true outside production, false in production — never rely
      // on this branch being open on Railway unless explicitly set.
      return this.configService.get<string>('NODE_ENV') !== 'production';
    }
    return raw === 'true' || raw === '1';
  }
}
