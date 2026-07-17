import './obsidian-mock'; // sets up HTMLElement.prototype
import { SkillsManagerView } from '../../src/SkillsManagerView';
import { DEFAULT_SETTINGS } from '../../src/types';
import { mockLeaf, mockApp } from './obsidian-mock';

const mockPlugin = {
  app: mockApp,
  settings: { ...DEFAULT_SETTINGS },
  saveSettings: async () => {},
};

const view = new SkillsManagerView(mockLeaf as any, mockPlugin as any);
const container = document.getElementById('app')!;
container.appendChild(view.containerEl);
view.onOpen();

// Expose for Playwright
(window as any).__skillsView = view;
