import { SetMetadata } from '@nestjs/common';

/**
 * @Public() — marks a route handler (or an entire controller) as exempt from
 * the default-deny RouteAuthGuard (TK-109). Sets reflector metadata that
 * RouteAuthGuard checks via Reflector.getAllAndOverride, so a method-level
 * @Public() overrides a controller without one, and vice versa.
 *
 * Use ONLY for routes that must be reachable with no Authorization header:
 * container healthchecks, login/register, and anonymous-read dashboard data
 * already confirmed to have no auth header sent by the frontend today.
 * Everything else stays under the default-deny gate.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
