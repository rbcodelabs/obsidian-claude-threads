/**
 * @vitest-environment jsdom
 *
 * Host-compatibility regressions around `app.secretStorage` and the secret
 * picker. The plugin runs inside Geode as well as Obsidian, and Geode's shim
 * differs from the real API in two ways that both surfaced as user-visible lies
 * or dead UI:
 *
 *  1. Its `secretStorage` persists values as plaintext in `localStorage` and
 *     reports `isEncryptionAvailable() === false`, while the settings copy said
 *     "Stored in your OS keychain." unconditionally.
 *  2. Its `SecretComponent` takes `(container)` where Obsidian's takes
 *     `(app, containerEl)`, so constructing it threw synchronously inside a
 *     click handler: the button did nothing, no error reached the user, and the
 *     hidden container leaked because its removal sat past the throw.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { App } from 'obsidian';
import { Notice, SecretComponent } from 'obsidian';

import '../setup/obsidian-dom';
import {
  describeSecretStorage,
  probeSecretStorageProtection,
  openSecretPicker,
} from '../../src/SettingsTab';

function appWith(secretStorage: unknown): App {
  return { secretStorage } as unknown as App;
}

beforeEach(() => {
  Notice.messages.length = 0;
  SecretComponent.last = null;
  document.body.innerHTML = '';
});

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

describe('openSecretPicker', () => {
  it('opens the picker and reports the chosen secret', () => {
    const onPicked = vi.fn();
    const app = appWith({});

    openSecretPicker(app, onPicked);

    // The hidden container is still mounted — the open picker owns it.
    expect(document.body.children.length).toBe(1);
    expect(SecretComponent.last).not.toBeNull();
    expect(Notice.messages).toEqual([]);

    SecretComponent.last!.pick('some-other-plugin-key');

    expect(onPicked).toHaveBeenCalledWith('some-other-plugin-key');
    // ...and released once the user answers.
    expect(document.body.children.length).toBe(0);
  });

  it('passes the app through so hosts with the real (app, containerEl) signature work', () => {
    const app = appWith({});
    const spy = vi.spyOn(document.body, 'appendChild');

    openSecretPicker(app, vi.fn());

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

/**
 * The Geode shape, isolated: a SecretComponent whose constructor throws because
 * it expects a different argument list. Kept in its own describe with a module
 * mock so the happy-path suite above still exercises the real mock.
 */
describe('openSecretPicker on a host with a mismatched SecretComponent', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    Notice.messages.length = 0;
  });

  it('surfaces a Notice, cleans up the temp container, and does not throw', async () => {
    vi.doMock('obsidian', async () => {
      const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
      return {
        ...actual,
        // Share the outer Notice class so its static message log is the one
        // these assertions read; vi.resetModules() otherwise hands the
        // re-imported SettingsTab a second, separate copy.
        Notice,
        // Geode's signature is (container), so the app lands where the
        // container is expected and appendChild is not a function.
        SecretComponent: class {
          constructor(container: { appendChild: (n: unknown) => void }) {
            container.appendChild(document.createElement('button'));
          }
        },
      };
    });

    const { openSecretPicker: open } = await import('../../src/SettingsTab');
    const onPicked = vi.fn();

    expect(() => open(appWith({}), onPicked)).not.toThrow();

    expect(onPicked).not.toHaveBeenCalled();
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]!.message).toMatch(/isn’t available on this host/);
    // The leak this regression is really about: no orphaned hidden div.
    expect(document.body.children.length).toBe(0);

    vi.doUnmock('obsidian');
  });

  it('cleans up and warns when the component renders no control to click', async () => {
    vi.doMock('obsidian', async () => {
      const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
      return {
        ...actual,
        Notice,
        SecretComponent: class {
          onChange(): this { return this; }
        },
      };
    });

    const { openSecretPicker: open } = await import('../../src/SettingsTab');

    expect(() => open(appWith({}), vi.fn())).not.toThrow();

    expect(Notice.messages).toHaveLength(1);
    expect(document.body.children.length).toBe(0);

    vi.doUnmock('obsidian');
  });
});
