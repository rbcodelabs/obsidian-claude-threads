/**
 * Host-compatibility regressions around `app.secretStorage` and the secret
 * picker. The plugin runs inside Geode as well as Obsidian, and Geode's shim
 * differs from the real API here: its `secretStorage` persists values as
 * plaintext in `localStorage` and reports `isEncryptionAvailable() === false`,
 * while the settings copy said "Stored in your OS keychain." unconditionally.
 */

import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';

import { describeSecretStorage, probeSecretStorageProtection } from '../../src/SettingsTab';

function appWith(secretStorage: unknown): App {
  return { secretStorage } as unknown as App;
}

describe('describeSecretStorage', () => {
  it('only promises the OS keychain when the host confirmed encryption', () => {
    expect(describeSecretStorage('encrypted')).toBe('Stored in your OS keychain.');
  });

  it('says where the value really goes when the host has no encrypted storage', () => {
    const text = describeSecretStorage('plaintext');
    expect(text).not.toContain('Stored in your OS keychain');
    expect(text).toMatch(/no encrypted secret storage/i);
    expect(text).toMatch(/local app data/i);
  });

  it('does not claim the keychain when the host could not be asked', () => {
    const text = describeSecretStorage('unknown');
    expect(text).toMatch(/could not confirm/i);
    // The failure mode this guards: "unknown" quietly rendering as a promise.
    expect(text).not.toBe(describeSecretStorage('encrypted'));
  });
});

describe('probeSecretStorageProtection', () => {
  it('reports encrypted when the host says encryption is available', async () => {
    const isEncryptionAvailable = vi.fn(async () => true);
    await expect(probeSecretStorageProtection(appWith({ isEncryptionAvailable })))
      .resolves.toBe('encrypted');
    expect(isEncryptionAvailable).toHaveBeenCalledTimes(1);
  });

  it('reports plaintext when the host says it is not (the live Geode shape)', async () => {
    await expect(probeSecretStorageProtection(appWith({ isEncryptionAvailable: async () => false })))
      .resolves.toBe('plaintext');
  });

  it('accepts a synchronous isEncryptionAvailable', async () => {
    await expect(probeSecretStorageProtection(appWith({ isEncryptionAvailable: () => false })))
      .resolves.toBe('plaintext');
  });

  it('reports unknown — never encrypted — when an older host lacks the method', async () => {
    await expect(probeSecretStorageProtection(appWith({ getSecret: () => null })))
      .resolves.toBe('unknown');
  });

  it('reports unknown when the probe throws', async () => {
    const isEncryptionAvailable = vi.fn(() => { throw new Error('not implemented'); });
    await expect(probeSecretStorageProtection(appWith({ isEncryptionAvailable })))
      .resolves.toBe('unknown');
  });

  it('reports unknown when the probe rejects', async () => {
    await expect(
      probeSecretStorageProtection(appWith({ isEncryptionAvailable: async () => { throw new Error('IPC down'); } })),
    ).resolves.toBe('unknown');
  });

  it('reports unknown when the host has no secretStorage at all', async () => {
    await expect(probeSecretStorageProtection(appWith(undefined))).resolves.toBe('unknown');
  });
});
