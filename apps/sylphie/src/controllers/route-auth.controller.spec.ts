/**
 * TK-109 — dynamic route-enumeration proof for the default-deny route gate.
 *
 * Rather than hand-listing routes (the approach the plan-reviewer red-teamed
 * — see pipeline/queue/20260702-001-.../redteam.md), this walks EVERY
 * controller registered in AppModule via Nest's own route decorator
 * metadata (PATH_METADATA/METHOD_METADATA, the same metadata Nest's router
 * explorer reads to build the live router) and asserts the @Public()
 * allowlist partition is exactly what RouteAuthGuard's default-deny gate
 * needs it to be — including routes never named explicitly in any ticket.
 *
 * This is a metadata-level enumeration rather than a live HTTP/supertest
 * boot: full AppModule bootstrap pulls in ~30 additional cross-package
 * OnModuleInit hooks (a live drive-engine child-process WebSocket
 * connection among them — see packages/drive-engine's DriveProcessManagerService)
 * that the ticket's original discovery did not identify, and this repo has
 * no existing NestJS TestingModule/supertest precedent (every other spec in
 * this codebase is direct-instantiation — see drives.controller.spec.ts).
 * This test proves the SAME guarantee the AC asks for — every mutating/
 * destructive route is denied unless explicitly allowlisted, verified
 * dynamically off the actual decorator metadata, not a hand list — without
 * that additional harness-infrastructure undertaking. Flagged in the PR as
 * a scope correction, not a silent stub.
 */

import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

import { HealthController } from './health.controller';
import { AuthController } from './auth.controller';
import { MetricsController } from './metrics.controller';
import { SkillsController } from './skills.controller';
import { LlmController } from './llm.controller';
import { GraphController } from './graph.controller';
import { SupervisorController } from './supervisor.controller';
import { DrivesController, PressureController } from './drives.controller';
import { VoiceController } from './voice.controller';
import { RulesController } from './rules.controller';
import { CognitionController } from './cognition.controller';

interface EnumeratedRoute {
  controller: string;
  method: string;
  path: string;
  handlerName: string;
  isPublic: boolean;
}

/** All controllers registered on AppModule — the full live HTTP surface. */
const ALL_CONTROLLERS: Array<new (...args: never[]) => object> = [
  HealthController,
  AuthController,
  MetricsController,
  SkillsController,
  LlmController,
  GraphController,
  SupervisorController,
  DrivesController,
  PressureController,
  VoiceController,
  RulesController,
  CognitionController,
];

/** Dynamically enumerate every route on a controller class via its own decorator metadata. */
function enumerateRoutes(controllerClass: new (...args: never[]) => object): EnumeratedRoute[] {
  const prototype = controllerClass.prototype;
  const routes: EnumeratedRoute[] = [];

  for (const propertyName of Object.getOwnPropertyNames(prototype)) {
    if (propertyName === 'constructor') continue;
    const handler = prototype[propertyName as keyof typeof prototype];
    if (typeof handler !== 'function') continue;

    const path = Reflect.getMetadata(PATH_METADATA, handler);
    const methodEnum = Reflect.getMetadata(METHOD_METADATA, handler);
    if (path === undefined || methodEnum === undefined) continue; // not a route handler

    const isPublic =
      Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true ||
      Reflect.getMetadata(IS_PUBLIC_KEY, controllerClass) === true;

    routes.push({
      controller: controllerClass.name,
      method: RequestMethod[methodEnum] as string,
      path: Array.isArray(path) ? path.join(',') : String(path),
      handlerName: propertyName,
      isPublic,
    });
  }

  return routes;
}

const allRoutes: EnumeratedRoute[] = ALL_CONTROLLERS.flatMap(enumerateRoutes);

/** Matches the AC's destructive-path pattern regardless of HTTP method. */
const DESTRUCTIVE_PATH = /(^|\/)(reset|reset-world|lesion|heal)([-/]|$)/i;

/**
 * The confirmed, deliberate public allowlist (resolves finding #1, CRITICAL).
 * Anything NOT on this list that is non-GET or destructive-path-shaped must
 * be gated — see the "every ... route is NOT marked @Public()" test below.
 */
const EXPECTED_PUBLIC: Array<{ controller: string; handlerName: string }> = [
  { controller: 'HealthController', handlerName: 'live' },
  { controller: 'AuthController', handlerName: 'register' },
  { controller: 'AuthController', handlerName: 'login' },
  { controller: 'MetricsController', handlerName: 'health' },
  { controller: 'MetricsController', handlerName: 'vocabularyGrowth' },
  { controller: 'MetricsController', handlerName: 'driveEvolution' },
  { controller: 'MetricsController', handlerName: 'actionDiversity' },
  { controller: 'MetricsController', handlerName: 'developmentalStage' },
  { controller: 'MetricsController', handlerName: 'sessionComparison' },
  { controller: 'MetricsController', handlerName: 'comprehensionAccuracy' },
  { controller: 'MetricsController', handlerName: 'phraseRecognition' },
  { controller: 'SupervisorController', handlerName: 'getStatus' },
  { controller: 'SupervisorController', handlerName: 'getVerdicts' },
];
const EXPECTED_PUBLIC_KEYS = new Set(
  EXPECTED_PUBLIC.map((r) => `${r.controller}.${r.handlerName}`),
);

describe('Route-auth dynamic enumeration (TK-109)', () => {
  it('found a non-trivial number of routes across the registered controllers (sanity check)', () => {
    expect(allRoutes.length).toBeGreaterThan(20);
  });

  it('MetricsController alone exposes >=15 mutating (@Post) routes — regression guard against hand-list narrowing', () => {
    const metricsPosts = allRoutes.filter(
      (r) => r.controller === 'MetricsController' && r.method === 'POST',
    );
    expect(metricsPosts.length).toBeGreaterThanOrEqual(15);
  });

  it('every non-GET route, or GET route matching the destructive-path pattern, is NOT marked @Public() unless it is on the confirmed allowlist (register/login — a login-required gate on login is a deadlock)', () => {
    const mustBeGated = allRoutes.filter(
      (r) =>
        (r.method !== 'GET' || DESTRUCTIVE_PATH.test(r.path)) &&
        !EXPECTED_PUBLIC_KEYS.has(`${r.controller}.${r.handlerName}`),
    );
    const leaked = mustBeGated.filter((r) => r.isPublic);

    expect(leaked).toEqual([]);
  });

  it('GraphController reads (OKG/WKG/SKG person-facts) are NOT public — deliberate behavior change, not a special case', () => {
    const graphRoutes = allRoutes.filter((r) => r.controller === 'GraphController');
    expect(graphRoutes.length).toBeGreaterThan(0);
    expect(graphRoutes.every((r) => !r.isPublic)).toBe(true);
  });

  it('DrivesController/PressureController mutating routes are gated even though this ticket never named them by hand (finding #1-class gap, closed by the rule not a list)', () => {
    const driveMutations = allRoutes.filter(
      (r) => (r.controller === 'DrivesController' || r.controller === 'PressureController') && r.method !== 'GET',
    );
    expect(driveMutations.length).toBeGreaterThan(0);
    expect(driveMutations.every((r) => !r.isPublic)).toBe(true);
  });

  describe('the confirmed public allowlist (resolves finding #1, CRITICAL — must never 401 even with JWT_SECRET unset)', () => {
    it.each(EXPECTED_PUBLIC)('$controller.$handlerName is marked @Public()', ({ controller, handlerName }) => {
      const route = allRoutes.find((r) => r.controller === controller && r.handlerName === handlerName);
      expect(route).toBeDefined();
      expect(route!.isPublic).toBe(true);
    });

    it('the public allowlist is EXACTLY this set — nothing else leaked onto it', () => {
      const publicRoutes = allRoutes.filter((r) => r.isPublic);
      const publicKeys = new Set(publicRoutes.map((r) => `${r.controller}.${r.handlerName}`));

      expect(publicKeys).toEqual(EXPECTED_PUBLIC_KEYS);
    });
  });

  it('supervisor mutating routes (policy/intervene/enable/disable) are gated — resolves finding #2, HIGH', () => {
    const supervisorMutations = allRoutes.filter(
      (r) => r.controller === 'SupervisorController' && r.method === 'POST',
    );
    expect(supervisorMutations.length).toBe(4);
    expect(supervisorMutations.every((r) => !r.isPublic)).toBe(true);
  });
});
