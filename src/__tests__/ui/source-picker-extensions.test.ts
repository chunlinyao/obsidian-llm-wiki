// Source-picker extension allowlist — the pickers and the engine's MinerU
// routing set must agree, otherwise a format the converter handles is hidden
// from the user (finding: .xlsx unselectable in "Ingest single source").
//
// `FileSuggestModal` is the picker behind that command. These tests drive
// `getItems()` with a stub vault and assert which paths the user can see; the
// third case guards the wiki-folder exclusion that used to be fed
// `settings.wikiFolder` directly.

import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { FileSuggestModal } from '../../ui/modals';
import { DEFAULT_SETTINGS, type LLMWikiSettings } from '../../types';

const VAULT_PATHS = [
  'sources/note.md',
  'sources/paper.pdf',
  'sources/budget.xlsx',
  'sources/report.docx',
  'sources/slides.pptx',
  'sources/diagram.png',
  'wiki/sources/generated.md',
];

function mkFile(path: string): TFile {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return Object.assign(new TFile(), {
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : 'md',
  });
}

function pickerPaths(settings: LLMWikiSettings): string[] {
  const files = VAULT_PATHS.map(mkFile);
  const app = { vault: { configDir: '.obsidian', getFiles: () => files } };
  const modal = new FileSuggestModal(app as unknown as App, settings, () => { /* selection */ });
  return modal.getItems().map(f => f.path);
}

describe('FileSuggestModal — offered sources follow the conversion backend', () => {
  it('offers Office and image sources when the MinerU backend is configured', () => {
    const items = pickerPaths({ ...DEFAULT_SETTINGS, markdownConversionBackend: 'mineru' });

    expect(items).toContain('sources/budget.xlsx');
    expect(items).toContain('sources/report.docx');
    expect(items).toContain('sources/slides.pptx');
    expect(items).toContain('sources/diagram.png');
    // The text/PDF set stays available — the merge must not replace it.
    expect(items).toContain('sources/note.md');
    expect(items).toContain('sources/paper.pdf');
  });

  it('keeps the text + PDF set (and hides Office/images) under the native backend', () => {
    const items = pickerPaths({ ...DEFAULT_SETTINGS, markdownConversionBackend: 'native' });

    expect(items).toContain('sources/note.md');
    expect(items).toContain('sources/paper.pdf');
    expect(items).not.toContain('sources/budget.xlsx');
    expect(items).not.toContain('sources/report.docx');
    expect(items).not.toContain('sources/slides.pptx');
    expect(items).not.toContain('sources/diagram.png');
  });

  it('still hides files inside the wiki folder (regression guard)', () => {
    const items = pickerPaths({ ...DEFAULT_SETTINGS, markdownConversionBackend: 'mineru' });

    expect(items).not.toContain('wiki/sources/generated.md');
  });
});
