// File & Folder suggest modals — small FuzzySuggestModal subclasses used
// in settings.ts (folder picker) and settings tab flows (file picker).
//
// Extracted from the original `src/ui/modals.ts` god file (PR split).
// The exclusion rule for both pickers lives in `isExcludedFromSourcePicker`
// (src/core/folder-scope.ts); PR #384 / #383 follow-up centralised it.

import { App, TFile, TFolder, FuzzySuggestModal } from 'obsidian';
import type { LLMWikiSettings } from '../../types';
import { allowedSourceExtensions } from '../../constants';
import { isExcludedFromSourcePicker } from '../../core/folder-scope';

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
  onSelect: (file: TFile) => void;
  private settings: LLMWikiSettings;

  constructor(app: App, settings: LLMWikiSettings, onSelect: (file: TFile) => void) {
    super(app);
    this.settings = settings;
    this.onSelect = onSelect;
  }

  getItems(): TFile[] {
    // v1.25.0 PR2: include PDFs in the source picker (PDFs are a first-class
    // source format). Office/image sources join them whenever the MinerU
    // backend is configured — the backend is what makes those formats
    // ingestable, so the picker must ask the backend rather than a fixed list
    // (`allowedSourceExtensions`, shared with the folder picker, the multi-file
    // picker and the engine's requirements gate). The exclusion rule
    // (`isExcludedFromSourcePicker`) is shared with the folder picker so the
    // wiki folder itself, its descendants, and configDir siblings of any shape
    // are all hidden together.
    const allowed = allowedSourceExtensions(this.settings.markdownConversionBackend);
    return this.app.vault.getFiles()
      .filter(f => allowed.includes(f.extension.toLowerCase()))
      .filter(f => !isExcludedFromSourcePicker(
        f.path,
        this.settings.wikiFolder,
        this.app.vault.configDir,
      ));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onSelect(file);
  }
}

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  onSelect: (folder: TFolder) => void;
  private wikiFolder: string;

  constructor(app: App, wikiFolder: string, onSelect: (folder: TFolder) => void) {
    super(app);
    this.wikiFolder = wikiFolder;
    this.onSelect = onSelect;
  }

  getItems(): TFolder[] {
    const folders: TFolder[] = [];
    const root = this.app.vault.getRoot();

    const collect = (folder: TFolder) => {
      if (!isExcludedFromSourcePicker(folder.path, this.wikiFolder, this.app.vault.configDir)) {
        folders.push(folder);
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          collect(child);
        }
      }
    };
    collect(root);
    return folders;
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onSelect(folder);
  }
}