import { knownLanguages, languageChoices, monaco } from '../monaco';
import type { ModelLocation, MonacoPort } from './ports';

function uriFor(location: ModelLocation) {
  return location.kind === 'file'
    ? monaco.Uri.file(location.path)
    : monaco.Uri.from({ scheme: 'untitled', path: `Untitled-${location.id}` });
}

const EOL = {
  lf: monaco.editor.EndOfLineSequence.LF,
  crlf: monaco.editor.EndOfLineSequence.CRLF,
} as const;

/** The real Monaco behind the documents service's port. */
export function createMonacoPort(): MonacoPort {
  return {
    createModel: (text, languageId, location) =>
      monaco.editor.createModel(text, languageId, uriFor(location)),
    setLanguage: (model, languageId) => void monaco.editor.setModelLanguage(model, languageId),
    setEol(model, eol) {
      if (model.getEOL() === (eol === 'crlf' ? '\r\n' : '\n')) return;
      model.setEOL(EOL[eol]);
    },
    pushEol(model, eol) {
      if (model.getEOL() === (eol === 'crlf' ? '\r\n' : '\n')) return;
      model.pushStackElement();
      model.pushEOL(EOL[eol]);
      model.pushStackElement();
    },
    knownLanguages,
    languageChoices,
  };
}
