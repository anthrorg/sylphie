/**
 * Unit tests for the guilt-repair behavioral-change path.
 *
 * Regression coverage for the dead-code bug where the contingency coordinator
 * passed the current action type as its own "previous error", making
 * behavioral-change detection always return false and the -0.15 / -0.30 relief
 * tiers unreachable (CANON §A.14).
 */

import { DriveName } from '@sylphie/shared';
import { GuiltyRepair } from './guilt-repair';
import { ContingencyCoordinator } from './contingency-coordinator';

// Suppress verbose logging during tests.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return {
    ...actual,
    verboseFor: () => () => {},
  };
});

describe('GuiltyRepair behavioral change detection', () => {
  let repair: GuiltyRepair;

  beforeEach(() => {
    repair = new GuiltyRepair();
  });

  it('returns null last error when no errors recorded', () => {
    expect(repair.getLastErrorActionType()).toBeNull();
  });

  it('reports the most recent error action type', () => {
    // Record a failure (negative outcome) of "reply".
    repair.computeGuiltRelief('reply', 'negative');
    expect(repair.getLastErrorActionType()).toBe('reply');

    repair.computeGuiltRelief('search', 'negative');
    expect(repair.getLastErrorActionType()).toBe('search');
  });

  it('fires behavioral-change-only relief (-0.15) when the repair action differs from the prior error', () => {
    // A different action type than the prior error = behavioral change, no ack.
    const relief = repair.computeGuiltRelief('rewrite-approach', 'positive', {
      previousErrorActionType: 'reply',
      previousErrorContext: 'reply',
    });
    expect(relief).toBe(-0.15);
  });

  it('fires combined relief (-0.30) for acknowledgment + behavioral change', () => {
    const relief = repair.computeGuiltRelief('apologize-and-retry', 'positive', {
      previousErrorActionType: 'reply',
      previousErrorContext: 'reply',
    });
    expect(relief).toBe(-0.3);
  });

  it('fires acknowledgment-only relief (-0.10) when action matches prior error', () => {
    const relief = repair.computeGuiltRelief('apologize', 'positive', {
      previousErrorActionType: 'apologize',
      previousErrorContext: 'apologize',
    });
    expect(relief).toBe(-0.1);
  });
});

describe('ContingencyCoordinator wires the genuine previous error', () => {
  it('passes the prior recorded error (not the current action) into guilt repair', () => {
    const coordinator = new ContingencyCoordinator();
    coordinator.reset();

    const drives = {} as any;

    // 1. A failure of "reply" gets recorded as an error.
    coordinator.applyContingencies(
      {
        actionType: 'reply',
        actionId: 'a1',
        outcome: 'negative',
        anxietyAtExecution: 0,
      } as any,
      drives,
    );

    // 2. A successful, *different* repair action should now register
    //    behavioral change against the prior "reply" error → -0.15 guilt.
    const deltas = coordinator.applyContingencies(
      {
        actionType: 'rewrite-approach',
        actionId: 'a2',
        outcome: 'positive',
        anxietyAtExecution: 0,
      } as any,
      drives,
    );

    expect(deltas[DriveName.Guilt]).toBe(-0.15);

    coordinator.reset();
  });

  it('does NOT fire behavioral change when there is no prior error', () => {
    const coordinator = new ContingencyCoordinator();
    coordinator.reset();

    const deltas = coordinator.applyContingencies(
      {
        actionType: 'rewrite-approach',
        actionId: 'a1',
        outcome: 'positive',
        anxietyAtExecution: 0,
      } as any,
      {} as any,
    );

    // No acknowledgment keyword, no prior error → no guilt relief.
    expect(deltas[DriveName.Guilt]).toBeUndefined();

    coordinator.reset();
  });
});
