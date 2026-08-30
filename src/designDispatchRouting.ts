import { Notice } from 'obsidian';
import type { ImageAttachment } from './types';
import type { DispatchDirective } from './slashCommands';

interface DesignDraftInput {
  setValue(value: string): void;
  setPendingImages(images: ImageAttachment[]): void;
  setPendingAttachment(attachment: string | null): void;
}

interface DesignDispatchArgs {
  directive: DispatchDirective;
  text: string;
  images: ImageAttachment[];
  attachment: string | null;
  agentHarness?: 'claude' | 'codex';
  input: DesignDraftInput;
  dispatch(brief: string, agentHarness?: 'claude' | 'codex'): Promise<string>;
}

function restoreDraft(input: DesignDraftInput, text: string, images: ImageAttachment[], attachment: string | null): void {
  input.setValue(text);
  input.setPendingImages(images);
  input.setPendingAttachment(attachment);
}

/** Handles the dispatch-only /design flow and leaves all other directives untouched. */
export async function handleDesignDispatch(args: DesignDispatchArgs): Promise<boolean> {
  if (args.directive.kind !== 'design') return false;

  if (args.directive.error) {
    new Notice(args.directive.error);
    restoreDraft(args.input, args.text, args.images, args.attachment);
    return true;
  }

  if (args.images.length > 0 || args.attachment) {
    new Notice('Design dispatch does not support attachments yet. Remove them and try again.');
    restoreDraft(args.input, args.text, args.images, args.attachment);
    return true;
  }

  try {
    await args.dispatch(args.directive.brief, args.agentHarness);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`Could not create design artifact: ${message}`);
    restoreDraft(args.input, args.text, args.images, args.attachment);
  }
  return true;
}
