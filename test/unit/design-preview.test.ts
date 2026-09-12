/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';
import type { DesignArtifact } from '../../src/types';

const artifact = { root: '/artifact', manifestPath: '/artifact/artifact.json' } as DesignArtifact;
function setup(type = 'geode-artifact', contextual = false) {
  const view = Object.create(ThreadsView.prototype);
  const leaf = { setViewState: vi.fn(async () => {}), getViewState: () => ({ type }) };
  view.app = { workspace: { getLeavesOfType: () => [], getLeaf: () => leaf, revealLeaf: vi.fn() } };
  view.plugin = { isConversationFirst: () => contextual, contextPanel: { setViewState: leaf.setViewState, getLeaf: () => leaf } };
  return { view: view as ThreadsView, leaf };
}
describe('design preview outcomes', () => {
  for (const contextual of [false, true]) {
    it(`reports a loaded preview (contextual=${contextual})`, async () => {
      const { view, leaf } = setup('geode-artifact', contextual);
      expect(await view.openArtifactPreview(artifact)).toEqual({ status: 'opened' });
      expect(leaf.setViewState).toHaveBeenCalledWith({ type: 'geode-artifact', active: true, state: { root: '/artifact' } });
    });
    it(`does not claim success when an unsupported host silently substitutes another view (contextual=${contextual})`, async () => {
      const { view } = setup('empty', contextual);
      expect((await view.openArtifactPreview(artifact)).status).not.toBe('opened');
    });
  }
});
