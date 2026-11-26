// LaTeX support — loaded on demand, only from Edit mode.
import { toast } from './util.js';
export function init(app) {
  return {
    snippet: () => toast('LaTeX insertion is coming in the next version.'),
    newDocument: () => toast('LaTeX documents are coming in the next version.'),
    openFile: () => toast('LaTeX documents are coming in the next version.')
  };
}
