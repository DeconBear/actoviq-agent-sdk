import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  externalCliSessionMatchesConfig,
  namedExternalCliManagedProfileId,
  type ExternalCliSessionSummary,
} from '../src/parity/externalCliSessions.js';
import { createCrushSessionReference } from '../src/parity/crushSessionHistory.js';

function summary(
  runtime: ExternalCliSessionSummary['runtime'],
  sessionPath: string,
): ExternalCliSessionSummary {
  return {
    runtime,
    nativeSessionId: 'shared-native-session',
    title: 'shared session',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:01:00.000Z',
    messageCount: 1,
    path: sessionPath,
  };
}

describe('external CLI history profile binding', () => {
  it('binds file-backed managed history to one named API-key profile', () => {
    const hadamardHomeDir = path.resolve('tmp', 'profile-binding-home');
    const profileA = namedExternalCliManagedProfileId('pi', 'profile-a');
    const managedA = summary('pi', path.join(
      hadamardHomeDir,
      'external-cli-profiles',
      'pi',
      profileA,
      'sessions',
      'shared-native-session.jsonl',
    ));
    const native = summary('pi', path.resolve('tmp', 'native-pi', 'shared-native-session.jsonl'));

    expect(externalCliSessionMatchesConfig(managedA, {
      runtime: 'pi',
      authSource: 'apiKey',
      profileName: 'profile-a',
    }, { hadamardHomeDir })).toBe(true);
    expect(externalCliSessionMatchesConfig(managedA, {
      runtime: 'pi',
      authSource: 'apiKey',
      profileName: 'profile-b',
    }, { hadamardHomeDir })).toBe(false);
    expect(externalCliSessionMatchesConfig(managedA, {
      runtime: 'pi',
      authSource: 'native',
      profileName: 'native-profile',
    }, { hadamardHomeDir })).toBe(false);
    expect(externalCliSessionMatchesConfig(native, {
      runtime: 'pi',
      authSource: 'native',
      profileName: 'native-profile',
    }, { hadamardHomeDir })).toBe(true);
  });

  it('disambiguates identical Crush session ids by native or exact managed source', () => {
    const profileA = namedExternalCliManagedProfileId('crush', 'profile-a');
    const nativeSessionId = '33333333-3333-4333-8333-333333333333';
    const native = summary('crush', createCrushSessionReference(nativeSessionId));
    const managedA = summary(
      'crush',
      createCrushSessionReference(nativeSessionId, profileA),
    );

    expect(externalCliSessionMatchesConfig(native, {
      runtime: 'crush',
      authSource: 'native',
      profileName: 'native-profile',
    })).toBe(true);
    expect(externalCliSessionMatchesConfig(native, {
      runtime: 'crush',
      authSource: 'apiKey',
      profileName: 'profile-a',
    })).toBe(false);
    expect(externalCliSessionMatchesConfig(managedA, {
      runtime: 'crush',
      authSource: 'apiKey',
      profileName: 'profile-a',
    })).toBe(true);
    expect(externalCliSessionMatchesConfig(managedA, {
      runtime: 'crush',
      authSource: 'apiKey',
      profileName: 'profile-b',
    })).toBe(false);
  });
});
