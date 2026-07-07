/**
 * TK-109 — RouteAuthGuard mechanism.
 *
 * Direct-instantiation unit test (repo convention — see drives.controller.spec.ts),
 * no NestJS TestingModule/HTTP boot required: the guard's canActivate() is pure
 * given an ExecutionContext, a Reflector, an AuthGuard, and a ConfigService.
 */

import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RouteAuthGuard } from './route-auth.guard';
import { AuthGuard } from './auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

function makeHttpContext(opts: {
  authHeader?: string;
  ip?: string;
}): ExecutionContext {
  const request = {
    headers: opts.authHeader ? { authorization: opts.authHeader } : {},
    ip: opts.ip,
  };
  const handler = function handler() {};
  const clazz = class Controller {};
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => clazz,
  } as unknown as ExecutionContext;
}

function makeWsContext(): ExecutionContext {
  const handler = function handler() {};
  const clazz = class Gateway {};
  return {
    getType: () => 'ws',
    switchToHttp: () => ({ getRequest: () => ({}) }),
    getHandler: () => handler,
    getClass: () => clazz,
  } as unknown as ExecutionContext;
}

function makeConfig(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] } as any;
}

describe('RouteAuthGuard', () => {
  it('short-circuits to true for non-HTTP execution contexts (WS/RPC)', () => {
    const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
    const authGuard = { canActivate: jest.fn() } as unknown as AuthGuard;
    const guard = new RouteAuthGuard(reflector, authGuard, makeConfig({}));

    expect(guard.canActivate(makeWsContext())).toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });

  it('passes any @Public() route with no Authorization header', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as unknown as Reflector;
    const authGuard = { canActivate: jest.fn() } as unknown as AuthGuard;
    const guard = new RouteAuthGuard(reflector, authGuard, makeConfig({}));

    expect(guard.canActivate(makeHttpContext({}))).toBe(true);
    expect(authGuard.canActivate).not.toHaveBeenCalled();
  });

  it('passes a non-public route with a valid Bearer token (delegates to AuthGuard)', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const authGuard = { canActivate: jest.fn().mockReturnValue(true) } as unknown as AuthGuard;
    const guard = new RouteAuthGuard(reflector, authGuard, makeConfig({}));

    expect(guard.canActivate(makeHttpContext({ authHeader: 'Bearer good' }))).toBe(true);
  });

  it('passes a non-public route with no token when the request is loopback and ALLOW_LOCALHOST_MUTATIONS=true', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const authGuard = {
      canActivate: jest.fn(() => {
        throw new UnauthorizedException();
      }),
    } as unknown as AuthGuard;
    const guard = new RouteAuthGuard(
      reflector,
      authGuard,
      makeConfig({ ALLOW_LOCALHOST_MUTATIONS: 'true' }),
    );

    expect(guard.canActivate(makeHttpContext({ ip: '127.0.0.1' }))).toBe(true);
  });

  it('denies (401) a non-public route with no token, from a non-loopback address', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const authGuard = {
      canActivate: jest.fn(() => {
        throw new UnauthorizedException();
      }),
    } as unknown as AuthGuard;
    const guard = new RouteAuthGuard(
      reflector,
      authGuard,
      makeConfig({ ALLOW_LOCALHOST_MUTATIONS: 'true' }),
    );

    expect(() => guard.canActivate(makeHttpContext({ ip: '203.0.113.5' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('denies (401) a non-public route from loopback when ALLOW_LOCALHOST_MUTATIONS is explicitly false (e.g. production)', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const authGuard = {
      canActivate: jest.fn(() => {
        throw new UnauthorizedException();
      }),
    } as unknown as AuthGuard;
    const guard = new RouteAuthGuard(
      reflector,
      authGuard,
      makeConfig({ ALLOW_LOCALHOST_MUTATIONS: 'false' }),
    );

    expect(() => guard.canActivate(makeHttpContext({ ip: '127.0.0.1' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('defaults ALLOW_LOCALHOST_MUTATIONS to false when NODE_ENV=production and the flag is unset (fail-shut, resolves finding #1)', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const authGuard = {
      canActivate: jest.fn(() => {
        throw new UnauthorizedException();
      }),
    } as unknown as AuthGuard;
    const guard = new RouteAuthGuard(
      reflector,
      authGuard,
      makeConfig({ NODE_ENV: 'production' }),
    );

    expect(() => guard.canActivate(makeHttpContext({ ip: '127.0.0.1' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('checks reflector metadata on both handler and class (getAllAndOverride)', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as unknown as Reflector;
    const authGuard = { canActivate: jest.fn() } as unknown as AuthGuard;
    const guard = new RouteAuthGuard(reflector, authGuard, makeConfig({}));
    const ctx = makeHttpContext({});

    guard.canActivate(ctx);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
  });
});
