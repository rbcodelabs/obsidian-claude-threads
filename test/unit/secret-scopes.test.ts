/**
 * secret-scopes.test.ts
 *
 * Unit tests for the project-scoping helpers added to secretUtils.ts:
 * `isSecretVisibleToProject` (gates a single secret's visibility for a given
 * projectId) and `pruneSecretEnvScopesForProject` (drops a deleted project's
 * id out of every scope list, removing the key entirely if its list becomes
 * empty).
 *
 * Semantics under test (see PluginSettings.secretEnvScopes doc comment):
 * - Absent key or empty array in secretEnvScopes = global (always visible).
 * - A non-empty list restricts visibility to those project ids only.
 * - A project-less caller (projectId === undefined) never sees a scoped
 *   secret, even though it sees every global one.
 */

import { describe, it, expect } from 'vitest';
import { isSecretVisibleToProject, pruneSecretEnvScopesForProject } from '../../src/secretUtils';

describe('isSecretVisibleToProject', () => {
  it('is visible everywhere when scopes is undefined (no scoping configured at all)', () => {
    expect(isSecretVisibleToProject(undefined, 'FOO', 'project-a')).toBe(true);
    expect(isSecretVisibleToProject(undefined, 'FOO', undefined)).toBe(true);
  });

  it('is visible everywhere when the varName has no entry in scopes', () => {
    const scopes = { OTHER_VAR: ['project-a'] };
    expect(isSecretVisibleToProject(scopes, 'FOO', 'project-b')).toBe(true);
    expect(isSecretVisibleToProject(scopes, 'FOO', undefined)).toBe(true);
  });

  it('is visible everywhere when the varName maps to an empty array', () => {
    const scopes = { FOO: [] };
    expect(isSecretVisibleToProject(scopes, 'FOO', 'project-a')).toBe(true);
    expect(isSecretVisibleToProject(scopes, 'FOO', undefined)).toBe(true);
  });

  it('is visible for a projectId included in a non-empty scope list', () => {
    const scopes = { FOO: ['project-a', 'project-b'] };
    expect(isSecretVisibleToProject(scopes, 'FOO', 'project-a')).toBe(true);
    expect(isSecretVisibleToProject(scopes, 'FOO', 'project-b')).toBe(true);
  });

  it('is NOT visible for a projectId excluded from a non-empty scope list', () => {
    const scopes = { FOO: ['project-a'] };
    expect(isSecretVisibleToProject(scopes, 'FOO', 'project-c')).toBe(false);
  });

  it('is NOT visible when projectId is undefined and the scope list is non-empty', () => {
    const scopes = { FOO: ['project-a'] };
    expect(isSecretVisibleToProject(scopes, 'FOO', undefined)).toBe(false);
  });
});

describe('pruneSecretEnvScopesForProject', () => {
  it('removes the deleted project id from every list', () => {
    const scopes = {
      FOO: ['project-a', 'project-b'],
      BAR: ['project-a'],
      BAZ: ['project-b'],
    };
    expect(pruneSecretEnvScopesForProject(scopes, 'project-a')).toEqual({
      FOO: ['project-b'],
      BAZ: ['project-b'],
    });
  });

  it('drops the key entirely once its list becomes empty', () => {
    const scopes = { FOO: ['project-a'] };
    expect(pruneSecretEnvScopesForProject(scopes, 'project-a')).toEqual({});
  });

  it('is a no-op (returns an equivalent empty object) when scopes is undefined', () => {
    expect(pruneSecretEnvScopesForProject(undefined, 'project-a')).toEqual({});
  });

  it('leaves lists that do not reference the deleted project unchanged', () => {
    const scopes = { FOO: ['project-b', 'project-c'] };
    expect(pruneSecretEnvScopesForProject(scopes, 'project-a')).toEqual({
      FOO: ['project-b', 'project-c'],
    });
  });
});
